package canvas

import (
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/model"
)

func TestCanvasHistoryContentContract(t *testing.T) {
	project := model.CanvasProject{
		ID: "canvas", Title: "current", ProjectID: "project", LibraryFolderID: "folder",
		PayloadJSON: `{"id":"stale","title":"stale","projectId":"stale","folderId":"stale","revision":99,"viewport":{"x":9},"createdAt":"stale","updatedAt":"stale","remoteContentHash":"stale","nodes":[],"connections":[],"custom":{"z":9007199254740993,"a":1.2300}}`,
	}
	got, err := canvasHistoryContent(project)
	const want = `{"connections":[],"custom":{"a":1.2300,"z":9007199254740993},"folderId":"folder","id":"canvas","nodes":[],"projectId":"project","title":"current"}`
	if err != nil || string(got) != want {
		t.Fatalf("history content changed: %s, %v", got, err)
	}
	for _, raw := range []string{`null`, `[]`, `{"nodes":[]} {}`, `{"nodes":`} {
		project.PayloadJSON = raw
		if _, err := canvasHistoryContent(project); err == nil {
			t.Fatalf("invalid document accepted: %s", raw)
		}
	}
}

func TestCanvasSnapshotPreservesOrderingReferencesAndRestore(t *testing.T) {
	at := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	before := model.CanvasProject{ID: "canvas", UserID: "owner", Title: "current", Revision: 7, UpdatedAt: at,
		PayloadJSON: `{"nodes":[{"id":"n","metadata":{"z":2,"a":1,"content":"/api/resources/media-original/file"}}],"connections":[],"viewport":{"resourceId":"viewport-resource"},"extension":{"referenceResourceIds":["media-original","extension-resource"],"prompt":"/api/resources/not-a-reference/file"}}`}
	after := before
	after.Revision++
	after.UpdatedAt = at.Add(time.Minute)
	after.PayloadJSON = strings.Replace(before.PayloadJSON, `"z":2,"a":1`, `"a":1,"z":2`, 1)
	snapshot, refs, err := buildCanvasSnapshot(&before, after, "automatic")
	if err != nil || snapshot != nil || len(refs) != 0 {
		t.Fatalf("key ordering alone created history: %v %v %v", snapshot, refs, err)
	}
	snapshot, refs, err = buildCanvasSnapshot(&before, after, "before_restore")
	if err != nil || snapshot == nil {
		t.Fatalf("restore must capture before image: %v", err)
	}
	if snapshot.NodeCount != 1 || snapshot.ConnectionCount != 0 || snapshot.Title != "current" || snapshot.Revision != 7 || snapshot.Reason != "before_restore" || snapshot.ContentUpdatedAt != at || snapshot.CreatedAt != after.UpdatedAt {
		t.Fatalf("snapshot metadata changed: %+v", snapshot)
	}
	if strings.Join(refs, ",") != "extension-resource,media-original,viewport-resource" {
		t.Fatalf("resource protection changed: %v", refs)
	}
	if !strings.Contains(snapshot.PayloadJSON, `"z":2,"a":1`) || snapshot.PayloadBytes != len(snapshot.PayloadJSON) {
		t.Fatalf("snapshot no longer preserves stored document: %s", snapshot.PayloadJSON)
	}
}

func TestCanvasSnapshotAllocationBudget(t *testing.T) {
	before := canvasHistoryBenchmarkProject(t, 100)
	after := before
	after.Title = "edited"
	allocations := testing.AllocsPerRun(10, func() {
		snapshot, refs, err := buildCanvasSnapshot(&before, after, "automatic")
		if err != nil || snapshot == nil || len(refs) != 100 {
			t.Fatalf("incomplete history: %v", err)
		}
	})
	// Baseline is ~23,800 allocations for this fixed 100-node document.
	// Guard the measured reduction without timing assertions affected by load.
	if allocations > 20000 {
		t.Fatalf("100-node snapshot allocation budget exceeded: %.0f > 20000", allocations)
	}
}

func TestCanvasSnapshotRejectsUnrepresentableReferenceDocumentNumbers(t *testing.T) {
	for _, custom := range []string{
		`1e1000`,
		`{"n":1e1000,"n":1}`,
		`{"n":[1e1000],"n":{}}`,
		`{"n":` + strings.Repeat("9", 309) + `,"n":1}`,
		`{"n":` + strings.Repeat("9", 250) + `e99,"n":1}`,
	} {
		before := model.CanvasProject{ID: "canvas", UserID: "owner", PayloadJSON: `{"nodes":[],"custom":` + custom + `}`}
		after := before
		after.Title = "edited"
		if _, _, err := buildCanvasSnapshot(&before, after, "automatic"); err == nil {
			t.Errorf("history accepted a document rejected by the existing resource-reference parser: %s", custom)
		}
	}
}
