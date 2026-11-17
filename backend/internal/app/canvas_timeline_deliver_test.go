package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/gorm"

	"qisitv/backend/internal/editing"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
)

type timelineDeliverFixture struct {
	db       *gorm.DB
	service  *Service
	registry *operations.Registry
	resource *model.Resource
	canvasID string
	revision int64
}

// newTimelineDeliverFixture builds a canvas whose saved timeline references one
// owned video. The module name is a real file so the render worker can run.
func newTimelineDeliverFixture(t *testing.T) *timelineDeliverFixture {
	t.Helper()
	_, db := newTimelineTaskTestService(t)
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	svc := NewLocal(repository.New(db), t.TempDir())
	if err := db.Create(&model.Workspace{ID: "owner", Name: "test"}).Error; err != nil {
		t.Fatal(err)
	}
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	if out, err := exec.Command(bin, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24:d=1", "-c:v", "libx264", source).CombinedOutput(); err != nil {
		t.Fatalf("source: %v %s", err, out)
	}
	file, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	stat, _ := file.Stat()
	resource, err := svc.UploadLocalResourceFile("owner", "source.mp4", stat.Size(), "video", 180, 320, 1000, file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"resourceId": resource.ID})
	if err := db.Create(&model.Asset{ID: "asset", UserID: "owner", Kind: "video", PayloadJSON: string(payload)}).Error; err != nil {
		t.Fatal(err)
	}
	const canvasID = "canvas"
	doc := map[string]any{
		"id": canvasID, "revision": 0, "title": "delivery", "connections": []any{},
		"nodes": []any{
			map[string]any{"id": "source", "type": "video", "title": "源片", "metadata": map[string]any{"resourceId": resource.ID, "assetId": "asset"}},
			map[string]any{"id": "old-film", "type": "video", "title": "成片", "metadata": map[string]any{}},
		},
		"timeline": map[string]any{
			"version": 2, "durationMs": 1000, "tracks": []any{map[string]any{"id": "v", "kind": "video"}},
			"clips": []any{map[string]any{"id": "clip", "kind": "video", "nodeId": "source", "trackId": "v", "startMs": 0, "durationMs": 1000}},
		},
	}
	raw, _ := json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("owner", raw); err != nil {
		t.Fatal(err)
	}
	current, err := svc.UserCanvasProject("owner", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(current, &stored); err != nil {
		t.Fatal(err)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	return &timelineDeliverFixture{db: db, service: svc, registry: registry,
		resource: resource, canvasID: canvasID, revision: stored.Revision}
}

func (f *timelineDeliverFixture) execute(t *testing.T, opID string, params map[string]any) (operations.Result, error) {
	t.Helper()
	encoded, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return f.registry.Execute(operations.Request{Op: "canvas.timeline.deliver", OpID: opID,
		UserID: "owner", Caller: operations.ManualCaller(false), Params: encoded})
}

func (f *timelineDeliverFixture) deliverParams() map[string]any {
	return map[string]any{
		"canvasId": f.canvasID, "expectedRevision": f.revision,
		"timeline": map[string]any{
			"version": 2, "durationMs": 1000, "tracks": []any{map[string]any{"id": "v", "kind": "video"}},
			"clips": []any{map[string]any{"id": "clip", "kind": "video", "nodeId": "source", "trackId": "v", "startMs": 0, "durationMs": 1000}},
		},
	}
}

func TestCanvasTimelineDeliverReplaysAndBindsAfterRender(t *testing.T) {
	f := newTimelineDeliverFixture(t)
	first, err := f.execute(t, "deliver-one", f.deliverParams())
	if err != nil {
		t.Fatal(err)
	}
	result := first.Result.(map[string]any)
	if first.Replayed {
		t.Fatal("first delivery replayed another operation")
	}
	taskID, _ := result["renderTaskId"].(string)
	nodeID, _ := result["resultNodeId"].(string)
	if taskID == "" || nodeID == "" || result["title"] != "成片 · 2" {
		t.Fatalf("unexpected delivery result: %v", result)
	}
	var task model.Task
	if err := f.db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Type != model.TaskTypeTimelineRender || localtask.TargetBindingFromInput(task.InputJSON).NodeID != nodeID {
		t.Fatalf("render task did not register the binding target: %s", task.InputJSON)
	}
	replay, err := f.execute(t, "deliver-one", f.deliverParams())
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed {
		t.Fatal("same operation did not replay")
	}
	if replayed := replay.Result.(map[string]any); replayed["renderTaskId"] != taskID || replayed["resultNodeId"] != nodeID {
		t.Fatalf("replay returned different identities: %v", replayed)
	}
	var taskCount, nodeCount int64
	canvas := f.canvasJSON(t)
	if err := f.db.Model(&model.Task{}).Where("type = ?", model.TaskTypeTimelineRender).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if taskCount != 1 {
		t.Fatalf("replay admitted %d renders", taskCount)
	}
	for _, node := range canvasNodesOf(t, canvas) {
		if title, _ := node["title"].(string); title == "成片 · 2" {
			nodeCount++
		}
	}
	if nodeCount != 1 {
		t.Fatalf("replay created %d delivery nodes", nodeCount)
	}
	// Finish the render through the real worker; delivery must bind the node.
	task.Status = model.TaskStatusRunning
	if err := f.db.Model(&model.Task{}).Where("id = ?", taskID).Update("status", task.Status).Error; err != nil {
		t.Fatal(err)
	}
	if err := newTaskWorkerCoordinator(f.service).processTimelineRender(&task, context.Background()); err != nil {
		t.Fatalf("render: %v", err)
	}
	if err := f.db.First(&task, "id = ?", taskID).Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("render did not succeed: %s %s", task.Stage, task.Error)
	}
	canvas = f.canvasJSON(t)
	bound := false
	for _, node := range canvasNodesOf(t, canvas) {
		if node["id"] != nodeID {
			continue
		}
		metadata, _ := node["metadata"].(map[string]any)
		taskOnNode, _ := metadata["taskId"].(string)
		storageKey, _ := metadata["storageKey"].(string)
		bound = taskOnNode == taskID && strings.HasPrefix(storageKey, "resource:")
	}
	if !bound {
		t.Fatalf("finished render was not bound to its delivery node: %s", canvas)
	}
}

func TestCanvasTimelineDeliverRollsBackWhenRenderCannotStart(t *testing.T) {
	f := newTimelineDeliverFixture(t)
	before := f.canvasJSON(t)
	f.service.BeginDrain()
	if _, err := f.execute(t, "deliver-drained", f.deliverParams()); err == nil {
		t.Fatal("drained workspace admitted a render")
	}
	after := f.canvasJSON(t)
	// The node used to be created before render admission; the transaction must
	// leave no half product, including no revision bump.
	var beforeDoc, afterDoc struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(before, &beforeDoc); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(after, &afterDoc); err != nil {
		t.Fatal(err)
	}
	if beforeDoc.Revision != afterDoc.Revision || string(before) != string(after) {
		t.Fatalf("failed delivery changed the canvas:\nbefore %s\nafter  %s", before, after)
	}
	var taskCount int64
	if err := f.db.Model(&model.Task{}).Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if taskCount != 0 {
		t.Fatalf("failed delivery left %d tasks", taskCount)
	}
}

func (f *timelineDeliverFixture) canvasJSON(t *testing.T) []byte {
	t.Helper()
	raw, err := f.service.UserCanvasProject("owner", f.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func canvasNodesOf(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	var doc struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Nodes
}
