package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

func controlRequest(t *testing.T, raw string) CanvasOperationsRequest {
	t.Helper()
	var req CanvasOperationsRequest
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatal(err)
	}
	return req
}
func controlTestCanvas(t *testing.T) *Service {
	t.Helper()
	svc := newCanvasHistoryTestService(t)
	_, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"test","nodes":[],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	return svc
}
func requireControlStatus(t *testing.T, err error, status int) {
	t.Helper()
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != status {
		t.Fatalf("wanted %d, got %v", status, err)
	}
}

func TestCanvasOperationsAtomicAndVersioned(t *testing.T) {
	svc := controlTestCanvas(t)
	req := controlRequest(t, `{"baseRevision":1,"operations":[{"op":"add","node":{"id":"a","type":"text","metadata":{"content":"reference"}}},{"op":"add","node":{"id":"b","type":"video","metadata":{"referenceNodeIds":["a"]}}},{"op":"connect","connection":{"id":"edge","fromNodeId":"a","toNodeId":"b"}}]}`)
	raw, err := svc.ApplyCanvasOperations("owner", "canvas", req)
	if err != nil {
		t.Fatal(err)
	}
	var project struct {
		Revision    int64 `json:"revision"`
		Nodes       []any `json:"nodes"`
		Connections []any `json:"connections"`
	}
	_ = json.Unmarshal(raw, &project)
	if project.Revision != 2 || len(project.Nodes) != 2 || len(project.Connections) != 1 {
		t.Fatalf("result: %s", raw)
	}
	_, err = svc.ApplyCanvasOperations("owner", "canvas", req)
	requireControlStatus(t, err, http.StatusConflict)
	before, _ := svc.UserCanvasProject("owner", "canvas")
	_, err = svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"update","nodeId":"a","patch":{"title":"must rollback"}},{"op":"connect","connection":{"fromNodeId":"a","toNodeId":"missing"}}]}`))
	requireControlStatus(t, err, http.StatusBadRequest)
	after, _ := svc.UserCanvasProject("owner", "canvas")
	if string(before) != string(after) {
		t.Fatal("failed batch changed document")
	}
	_, err = svc.ApplyCanvasOperations("stranger", "canvas", controlRequest(t, `{"operations":[{"op":"delete","nodeId":"a"}]}`))
	requireControlStatus(t, err, http.StatusNotFound)
}

func TestCanvasOperationsMergeAndDeleteReferences(t *testing.T) {
	svc := controlTestCanvas(t)
	_, err := svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"add","node":{"id":"a","type":"image","metadata":{"prompt":"original"}}},{"op":"add","node":{"id":"b","type":"video","metadata":{"referenceNodeIds":["a"],"videoStartFrameNodeId":"a","prompt":"keep"}}},{"op":"connect","connection":{"id":"edge","fromNodeId":"a","toNodeId":"b"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"update","nodeId":"b","patch":{"position":{"x":100},"metadata":{"composerContent":"new"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"prompt":"keep"`) || !strings.Contains(string(raw), `"x":100`) {
		t.Fatalf("merge lost fields: %s", raw)
	}
	raw, err = svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"delete","nodeId":"a"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"videoStartFrameNodeId"`) || strings.Contains(string(raw), `"id":"edge"`) || !strings.Contains(string(raw), `"referenceNodeIds":[]`) {
		t.Fatalf("dangling references: %s", raw)
	}
}

func TestLegacyCanvasNodeDeleteUsesReferenceCleanup(t *testing.T) {
	svc := controlTestCanvas(t)
	_, err := svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"add","node":{"id":"ref","type":"image"}},{"op":"add","node":{"id":"target","type":"video","metadata":{"referenceNodeIds":["ref"],"videoStartFrameNodeId":"ref"}}},{"op":"connect","connection":{"id":"edge","fromNodeId":"ref","toNodeId":"target"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	summary, err := svc.DeleteUserCanvasNode("owner", "canvas", "ref")
	if err != nil || summary.Revision != 3 || summary.SaveAudit == nil || summary.SaveAudit.NodesAfter != 1 {
		t.Fatalf("legacy delete summary: %+v %v", summary, err)
	}
	raw, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil || strings.Contains(string(raw), `"ref"`) || strings.Contains(string(raw), `"videoStartFrameNodeId"`) || strings.Contains(string(raw), `"edge"`) {
		t.Fatalf("legacy delete left references: %s %v", raw, err)
	}
}

func TestCanvasOperationsRejectInvalidInput(t *testing.T) {
	for _, input := range []string{
		`{"operations":[]}`,
		`{"operations":[{"op":"add","node":{"type":"surprise"}}]}`,
		`{"operations":[{"op":"add","node":{"type":"text","width":-1}}]}`,
		`{"operations":[{"op":"add","node":{"type":"text","metadata":{"apiKey":"secret"}}}]}`,
		`{"operations":[{"op":"add","node":{"type":"text","metadata":{"referenceNodeIds":["missing"]}}}]}`,
		`{"operations":[{"op":"add","node":{"id":"a","type":"text","parentId":"a"}}]}`,
		`{"operations":[{"op":"project","patch":{"revision":100}}]}`,
		`{"operations":[{"op":"add","node":{"id":"a","type":"text"}},{"op":"add","node":{"id":"b","type":"video"}},{"op":"connect","connection":{"fromNodeId":"a","toNodeId":"b","relation":123}}]}`,
	} {
		t.Run(input, func(t *testing.T) {
			svc := controlTestCanvas(t)
			_, err := svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, input))
			requireControlStatus(t, err, http.StatusBadRequest)
		})
	}
}

func TestCanvasInteractionIsolationExpiryAndSelection(t *testing.T) {
	svc := controlTestCanvas(t)
	_, err := svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"add","node":{"id":"a","type":"text"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	value := CanvasInteraction{TabID: "tab-one", SelectedNodeIDs: []string{"a"}, Viewport: CanvasViewport{K: 1}, IsActive: true}
	interaction, err := svc.PutCanvasInteraction("owner", "canvas", value)
	if err != nil {
		t.Fatal(err)
	}
	if interaction.CanvasID != "canvas" || interaction.ExpiresAt.Sub(interaction.UpdatedAt) != CanvasInteractionTTL {
		t.Fatalf("bad presence: %+v", interaction)
	}
	if got, err := svc.GetCanvasInteraction("stranger", "", ""); err != nil || got != nil {
		t.Fatalf("cross-user read: %+v %v", got, err)
	}
	_, err = svc.PutCanvasInteraction("stranger", "canvas", value)
	if err == nil {
		t.Fatal("cross-user write")
	}
	value.TabID = "tab-two"
	value.IsActive = false
	_, err = svc.PutCanvasInteraction("owner", "canvas", value)
	if err != nil {
		t.Fatal(err)
	}
	got, err := svc.GetCanvasInteraction("owner", "", "")
	if err != nil || got.TabID != "tab-one" {
		t.Fatalf("inactive tab selected: %+v %v", got, err)
	}
	_, err = svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"delete","nodeId":"a"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err = svc.GetCanvasInteraction("owner", "", "")
	if err != nil || len(got.SelectedNodeIDs) != 0 {
		t.Fatalf("deleted selection retained: %+v %v", got, err)
	}
	for key, item := range svc.interactions {
		item.ExpiresAt = time.Now().Add(-time.Second)
		svc.interactions[key] = item
	}
	got, err = svc.GetCanvasInteraction("owner", "", "")
	if err != nil || got != nil {
		t.Fatalf("stale presence retained: %+v %v", got, err)
	}
}

type controlLockedHost struct {
	nopHost
	mu sync.Mutex
}

func (h *controlLockedHost) WithStorageLock(fn func() error) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return fn()
}

func TestCanvasOperationsConcurrentRevisionCAS(t *testing.T) {
	svc := controlTestCanvas(t)
	svc.host = &controlLockedHost{}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, title := range []string{"first", "second"} {
		go func(title string) {
			<-start
			revision := int64(1)
			_, err := svc.ApplyCanvasOperations("owner", "canvas", CanvasOperationsRequest{BaseRevision: &revision, Operations: []CanvasOperation{{Op: "project", Patch: map[string]any{"title": title}}}})
			results <- err
		}(title)
	}
	close(start)
	successes := 0
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			successes++
		} else {
			requireControlStatus(t, err, http.StatusConflict)
		}
	}
	if successes != 1 {
		t.Fatalf("%d writes succeeded against same revision", successes)
	}
}

func TestCanvasOperationsRequireOwnedReadyMediaAsset(t *testing.T) {
	svc := controlTestCanvas(t)
	now := time.Now().UTC()
	resource := model.Resource{ID: "media", UserID: "owner", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "image.png", CreatedAt: now, UpdatedAt: now}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	req := controlRequest(t, `{"operations":[{"op":"add","node":{"type":"image","metadata":{"storageKey":"resource:media"}}}]}`)
	_, err := svc.ApplyCanvasOperations("owner", "canvas", req)
	requireControlStatus(t, err, http.StatusBadRequest)
	_, err = svc.UpsertUserAsset("owner", json.RawMessage(`{"id":"asset","kind":"image","title":"reference","coverUrl":"/api/resources/media/file","tags":[],"source":"Canvas","status":"confirmed","data":{"dataUrl":"/api/resources/media/file","storageKey":"resource:media","mimeType":"image/png","width":1,"height":1,"bytes":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCanvasOperations("owner", "canvas", controlRequest(t, `{"operations":[{"op":"add","node":{"type":"image","metadata":{"storageKey":"resource:media","assetId":"asset","nodeRole":"result","resultOrigin":"upload"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
}
