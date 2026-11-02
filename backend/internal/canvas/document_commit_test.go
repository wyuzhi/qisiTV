package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func TestCommitUserCanvasDocumentPreservesUntouchedFieldsAndCAS(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas","revision":0,"title":"initial",
		"nodes":[{"id":"n1","type":"text","title":"旧"}],
		"connections":[],
		"customKeep":"keep-me",
		"viewport":{"x":9,"y":8,"k":2}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	overlay := json.RawMessage(`{
		"id":"forged","revision":99,"remoteContentHash":"local-only",
		"title":"手工提交",
		"nodes":[{"id":"n1","type":"text","title":"新"}],
		"viewport":{"x":1,"y":1,"k":4}
	}`)
	summary, after, err := svc.CommitUserCanvasDocument("owner", "canvas", created.Revision, overlay)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Revision != created.Revision+1 {
		t.Fatalf("revision = %d", summary.Revision)
	}
	var doc map[string]any
	if err := json.Unmarshal(after, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["id"] != "canvas" || doc["title"] != "手工提交" || doc["customKeep"] != "keep-me" {
		t.Fatalf("合并丢字段: %s", after)
	}
	if doc["remoteContentHash"] != nil {
		t.Fatal("不应写入 remoteContentHash")
	}
	viewport := doc["viewport"].(map[string]any)
	if viewport["x"] != float64(0) {
		t.Fatalf("视口应由服务端保留: %s", after)
	}
	_, _, err = svc.CommitUserCanvasDocument("owner", "canvas", created.Revision, overlay)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict {
		t.Fatalf("过期 revision 必须冲突: %v", err)
	}
	_, _, err = svc.CommitUserCanvasDocument("owner", "missing", summary.Revision, overlay)
	if !errors.As(err, &appErr) || appErr.Status != http.StatusNotFound {
		t.Fatalf("缺失画布必须 404: %v", err)
	}
}

func TestCommitUserCanvasDocumentHealsOwnedMediaAndAllowsEditsWithLegacyReferences(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	resource := model.Resource{
		ID: "res-owned", UserID: "owner", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/owner/image/owned.png",
		CreatedAt: now, UpdatedAt: now,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	rawAsset := json.RawMessage(`{"id":"asset-owned","kind":"image","title":"生成图","coverUrl":"/api/resources/res-owned/file","tags":[],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/res-owned/file","storageKey":"resource:res-owned","width":512,"height":512,"bytes":128,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("owner", rawAsset); err != nil {
		t.Fatal(err)
	}
	// Pre-populate a canvas row in SQLite that already contains a legacy broken image reference
	// and a missing preview resource reference in metadata.
	stored := model.CanvasProject{
		ID:       "legacy-canvas",
		UserID:   "owner",
		Title:    "大画布",
		Revision: 0,
		PayloadJSON: `{
			"id":"legacy-canvas",
			"title":"大画布",
			"nodes":[
				{"id":"legacy-broken","type":"image","metadata":{"assetId":"missing-asset","storageKey":"resource:missing-res","content":"/api/resources/missing-res/file"}},
				{"id":"video-preview-missing","type":"video","metadata":{"videoPreview":{"content":"/api/resources/missing-preview/file","storageKey":"resource:missing-preview"}}},
				{"id":"text-1","type":"text","title":"旧剧本"}
			],
			"connections":[]
		}`,
		CreatedAt: now.Add(-10 * time.Minute),
		UpdatedAt: now.Add(-10 * time.Minute),
	}
	if err := SaveDocumentWithHistory(svc.repo, nil, &stored, "automatic"); err != nil {
		t.Fatal(err)
	}

	// Commit an edit that updates text-1 and also includes an unbound node + batch root for res-owned.
	overlay := json.RawMessage(`{
		"title":"大画布-已编辑",
		"nodes":[
			{"id":"legacy-broken","type":"image","metadata":{"assetId":"missing-asset","storageKey":"resource:missing-res","content":"/api/resources/missing-res/file"}},
			{"id":"video-preview-missing","type":"video","metadata":{"videoPreview":{"content":"/api/resources/missing-preview/file","storageKey":"resource:missing-preview"}}},
			{"id":"unbound-child","type":"image","metadata":{"storageKey":"resource:res-owned","content":"/api/resources/res-owned/file","largeSeed":9007199254740993}},
			{"id":"unbound-root","type":"image","metadata":{"isBatchRoot":true,"primaryImageId":"unbound-child","storageKey":"resource:res-owned","content":"/api/resources/res-owned/file"}},
			{"id":"text-1","type":"text","title":"新剧本"}
		],
		"connections":[]
	}`)
	summary, after, err := svc.CommitUserCanvasDocument("owner", "legacy-canvas", stored.Revision, overlay)
	if err != nil {
		t.Fatalf("CommitUserCanvasDocument failed on legacy/unbound nodes: %v", err)
	}
	if summary.Revision != stored.Revision+1 {
		t.Fatalf("revision = %d, want %d", summary.Revision, stored.Revision+1)
	}
	if !strings.Contains(string(after), `"assetId":"asset-owned"`) {
		t.Fatalf("expected unbound owned media nodes to be healed with asset-owned: %s", after)
	}
	if !strings.Contains(string(after), `"largeSeed":9007199254740993`) {
		t.Fatalf("expected >2^53 integer to survive healing without float64 precision loss: %s", after)
	}

	// Duplicating a broken legacy reference or adding an unowned unbound reference must still be rejected.
	duplicateLegacyOverlay := json.RawMessage(`{
		"nodes":[
			{"id":"legacy-broken","type":"image","metadata":{"assetId":"missing-asset","storageKey":"resource:missing-res","content":"/api/resources/missing-res/file"}},
			{"id":"legacy-broken-copy","type":"image","metadata":{"assetId":"missing-asset","storageKey":"resource:missing-res","content":"/api/resources/missing-res/file"}}
		]
	}`)
	if _, _, err := svc.CommitUserCanvasDocument("owner", "legacy-canvas", summary.Revision, duplicateLegacyOverlay); err == nil {
		t.Fatal("expected duplicate broken legacy reference on new node to be rejected")
	}

	// ValidateSyncedPayload allows >4MB canvas payloads (up to 16MB) while keeping 4MB limit for assets.
	largeCanvas := json.RawMessage(`{"id":"big","nodes":[{"id":"t","type":"text","content":"` + strings.Repeat("a", 5<<20) + `"}]}`)
	if err := ValidateSyncedPayload(largeCanvas, "画布"); err != nil {
		t.Fatalf("ValidateSyncedPayload rejected 5MB canvas: %v", err)
	}
	if err := asset.ValidateSyncedPayload(largeCanvas, "素材"); err == nil {
		t.Fatal("asset.ValidateSyncedPayload accepted 5MB asset")
	}
}
