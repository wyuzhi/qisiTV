package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

func TestCommitUserCanvasProjectAssetsBindsAndPersistsGeneratedMediaAtomically(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	resource := model.Resource{
		ID: "resource-generated", UserID: "owner", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/owner/image/generated.png", CreatedAt: now, UpdatedAt: now,
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	asset := json.RawMessage(`{
		"id":"generation_asset","kind":"image","title":"生成图片","coverUrl":"/api/resources/resource-generated/file",
		"tags":["生成"],"status":"confirmed","source":"生成任务",
		"data":{"dataUrl":"/api/resources/resource-generated/file","storageKey":"resource:resource-generated","width":1024,"height":1024,"bytes":12,"mimeType":"image/png"}
	}`)
	project := json.RawMessage(`{
		"id":"canvas","revision":0,"title":"测试画布",
		"nodes":[{"id":"node","type":"image","metadata":{"taskId":"task","status":"success","storageKey":"resource:resource-generated","content":"/api/resources/resource-generated/file"}}],
		"connections":[]
	}`)

	saved, err := svc.CommitUserCanvasProjectAssets("owner", project, []json.RawMessage{asset})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 {
		t.Fatalf("revision = %d, want 1", saved.Revision)
	}
	persistedAsset, err := svc.UserAsset("owner", "generation_asset")
	if err != nil {
		t.Fatalf("asset was not committed: %v", err)
	}
	if len(persistedAsset) == 0 {
		t.Fatal("persisted asset payload is empty")
	}
	persistedProject, err := svc.UserCanvasProject("owner", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Nodes []struct {
			Metadata struct {
				AssetID string `json:"assetId"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(persistedProject, &document); err != nil {
		t.Fatal(err)
	}
	if got := document.Nodes[0].Metadata.AssetID; got != "generation_asset" {
		t.Fatalf("node assetId = %q, want generation_asset", got)
	}
}

func TestCommitUserCanvasProjectAssetsRollsBackAssetWhenCanvasRevisionConflicts(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"id":"canvas","revision":0,"title":"existing","nodes":[],"connections":[]}`)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	resource := model.Resource{ID: "resource-rollback", UserID: "owner", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/owner/image/rollback.png", CreatedAt: now, UpdatedAt: now}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	asset := json.RawMessage(`{"id":"generation_rollback","kind":"image","title":"生成图片","coverUrl":"/api/resources/resource-rollback/file","tags":["生成"],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/resource-rollback/file","storageKey":"resource:resource-rollback","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	stale := json.RawMessage(`{"id":"canvas","revision":0,"title":"stale","nodes":[{"id":"node","type":"image","metadata":{"storageKey":"resource:resource-rollback"}}],"connections":[]}`)

	_, err := svc.CommitUserCanvasProjectAssets("owner", stale, []json.RawMessage{asset})
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
		t.Fatalf("commit error = %v, want revision conflict", err)
	}
	if _, err := svc.repo.AssetForUser("owner", "generation_rollback"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("asset survived failed canvas transaction: %v", err)
	}
}

func TestBindCanvasMediaAssetsCoversImageVideoAndAudio(t *testing.T) {
	items := []model.Asset{
		{ID: "asset-image", PayloadJSON: `{"data":{"storageKey":"resource:image-resource"}}`},
		{ID: "asset-video", PayloadJSON: `{"data":{"storageKey":"resource:video-resource"}}`},
		{ID: "asset-audio", PayloadJSON: `{"data":{"storageKey":"resource:audio-resource"}}`},
	}
	raw := json.RawMessage(`{"nodes":[
		{"id":"image","type":"image","metadata":{"storageKey":"resource:image-resource"}},
		{"id":"video","type":"video","metadata":{"content":"/api/resources/video-resource/file"}},
		{"id":"audio","type":"audio","metadata":{"storageKey":"resource:audio-resource"}},
		{"id":"text","type":"text","metadata":{"content":"resource:image-resource"}}
	]}`)

	bound, err := BindCanvasMediaAssets(raw, items)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Nodes []struct {
			ID       string `json:"id"`
			Metadata struct {
				AssetID string `json:"assetId"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(bound, &document); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"image": "asset-image", "video": "asset-video", "audio": "asset-audio", "text": ""}
	for _, node := range document.Nodes {
		if node.Metadata.AssetID != want[node.ID] {
			t.Fatalf("node %s assetId = %q, want %q", node.ID, node.Metadata.AssetID, want[node.ID])
		}
	}
}

func TestCommitUserCanvasProjectAssetsCannotRetargetAnAssetUsedByAnotherCanvas(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	now := time.Now().UTC()
	for _, id := range []string{"resource-old", "resource-new"} {
		resource := model.Resource{ID: id, UserID: "owner", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/owner/image/" + id + ".png", CreatedAt: now, UpdatedAt: now}
		if err := svc.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
	}
	existingAsset := json.RawMessage(`{"id":"shared-asset","kind":"image","title":"旧素材","coverUrl":"/api/resources/resource-old/file","tags":[],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/resource-old/file","storageKey":"resource:resource-old","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("owner", existingAsset); err != nil {
		t.Fatal(err)
	}
	firstCanvas := json.RawMessage(`{"id":"first","revision":0,"title":"first","nodes":[{"id":"node","type":"image","metadata":{"assetId":"shared-asset","storageKey":"resource:resource-old"}}],"connections":[]}`)
	if _, err := svc.UpsertUserCanvasProject("owner", firstCanvas); err != nil {
		t.Fatal(err)
	}
	replacement := json.RawMessage(`{"id":"shared-asset","kind":"image","title":"新素材","coverUrl":"/api/resources/resource-new/file","tags":[],"status":"confirmed","source":"生成任务","data":{"dataUrl":"/api/resources/resource-new/file","storageKey":"resource:resource-new","width":1,"height":1,"bytes":1,"mimeType":"image/png"}}`)
	secondCanvas := json.RawMessage(`{"id":"second","revision":0,"title":"second","nodes":[{"id":"node","type":"image","metadata":{"storageKey":"resource:resource-new"}}],"connections":[]}`)

	if _, err := svc.CommitUserCanvasProjectAssets("owner", secondCanvas, []json.RawMessage{replacement}); err == nil {
		t.Fatal("retargeting an asset referenced by another canvas succeeded")
	}
	persisted, err := svc.UserAsset("owner", "shared-asset")
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(persisted) || !containsJSONText(persisted, "resource:resource-old") {
		t.Fatalf("existing asset was changed: %s", persisted)
	}
}

func containsJSONText(raw json.RawMessage, text string) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	encoded, _ := json.Marshal(value)
	return string(encoded) != "" && strings.Contains(string(encoded), text)
}
