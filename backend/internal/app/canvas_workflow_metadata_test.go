package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/model"
)

func migratedWorkflowVideo(t *testing.T, svc *Service) *model.Resource {
	t.Helper()
	encoder, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip(err)
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip(err)
	}
	svc.dataDir = t.TempDir()
	file := filepath.Join(svc.dataDir, "resources", "imported.mp4")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, encoder, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=32x24:rate=10", "-t", "0.4", "-c:v", "mpeg4", "-y", file).CombinedOutput(); err != nil {
		t.Fatalf("create local fixture: %v %s", err, output)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	// This is the shape of an imported resource before trusted probing. Legacy
	// Kind=media also appears in pre-engine resources and must use its MIME type.
	r := &model.Resource{ID: "migrated-media", UserID: "owner", Kind: "media", MimeType: "video/mp4", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "imported.mp4", Size: info.Size()}
	if err := svc.repo.DB().Create(r).Error; err != nil {
		t.Fatal(err)
	}
	return r
}

func TestWorkflowMigratedMediaProbesBeforeMergeAndDurationBinding(t *testing.T) {
	for _, operation := range []string{"merge", "duration"} {
		t.Run(operation, func(t *testing.T) {
			svc, db := newTimelineTaskTestService(t)
			resource := migratedWorkflowVideo(t, svc)
			steps := map[string]*cw.Step{"a": {Status: "succeeded", ResourceID: resource.ID}, "b": {Status: "succeeded", ResourceID: resource.ID}}
			if operation == "merge" {
				task, err := svc.executeCanvasWorkflowMedia("owner", "imported-merge", cw.Node{ID: "merge", OperationID: "video.merge"}, []cw.Edge{{From: "a", To: "merge", Order: 1}, {From: "b", To: "merge", Order: 2}}, steps)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.First(task, "id = ?", task.ID).Error; err != nil {
					t.Fatal(err)
				}
				var input timelineRenderInput
				if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Timeline.DurationMs != 800 || input.Options.Width != 32 || input.Options.Height != 24 {
					t.Fatalf("merge did not use probed metadata: %+v", input)
				}
			} else {
				recipe := workflowRecipe{Request: CreateTaskRequest{Input: map[string]any{"config": map[string]any{"videoSeconds": "9"}}}, VideoDurationSourceNodeID: "a"}
				req, err := svc.materializeCanvasWorkflowRequest("owner", "imported-duration", recipe, map[string]cw.Node{"a": {MediaType: "video"}}, steps)
				if err != nil || req.Input["config"].(map[string]any)["videoSeconds"] != "1" {
					t.Fatalf("duration source did not use probed facts: %+v %v", req, err)
				}
			}
			var stored model.Resource
			if err := db.First(&stored, "id = ?", resource.ID).Error; err != nil || stored.DurationMs != 400 || stored.Width != 32 || stored.Height != 24 {
				t.Fatalf("trusted facts not persisted: %+v %v", stored, err)
			}
			if _, err := svc.workflowResource("other", resource.ID, "video"); err == nil {
				t.Fatal("foreign resource reached probe")
			}
		})
	}
}

func TestWorkflowInvalidImportedMediaDoesNotEnqueueTask(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	if err := db.Create(&model.Resource{ID: "bad-media", UserID: "owner", Kind: "video", MimeType: "video/mp4", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "missing.mp4"}).Error; err != nil {
		t.Fatal(err)
	}
	steps := map[string]*cw.Step{"a": {Status: "succeeded", ResourceID: "bad-media"}, "b": {Status: "succeeded", ResourceID: "bad-media"}}
	if _, err := svc.executeCanvasWorkflowMedia("owner", "invalid-merge", cw.Node{ID: "merge", OperationID: "video.merge"}, []cw.Edge{{From: "a", To: "merge"}, {From: "b", To: "merge"}}, steps); err == nil {
		t.Fatal("missing original bytes accepted")
	}
	var tasks int64
	if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatal("invalid media enqueued work", tasks, err)
	}
	var stored model.Resource
	if err := db.First(&stored, "id = ?", "bad-media").Error; err != nil || stored.DurationMs != 0 || stored.Width != 0 || stored.Height != 0 {
		t.Fatal("failed probe fabricated metadata", stored, err)
	}
}
