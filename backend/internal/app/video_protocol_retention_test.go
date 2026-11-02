package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/plugins"
	"qisitv/backend/internal/protocol"
)

func TestVideoProtocolUpgradeRetainsRemovedTaskIDs(t *testing.T) {
	for _, source := range []string{"row-id", "log-id", "running", "cancelled"} {
		t.Run(source, func(t *testing.T) {
			const id = "luma-dream-machine"
			oldRaw := readVideoUpgradeFixture(t, "testdata/video-protocol-v2.0.4/"+id+".json")
			release, dir := t.TempDir(), t.TempDir()
			t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
			shipVideoUpgradePackage(t, release, id, oldRaw)
			svc, db := openDBRuntimeMatrix(t, dir)
			now := time.Now()
			task := model.Task{ID: "retained-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: `{"mode":"video","config":{"interfaceType":"luma-dream-machine"}}`, CreatedAt: now, UpdatedAt: now}
			switch source {
			case "log-id":
				task.ProviderRequestID = ""
			case "running":
				task.Status = model.TaskStatusRunning
			case "cancelled":
				task.Status = model.TaskStatusCancelled
				task.ProviderCancelStatus = model.ProviderCancelStatusRequested
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if source == "log-id" {
				if err := db.Create(&model.ApiCallLog{ID: "original-log", UserID: "local", TaskID: task.ID, Capability: "video", ProviderRequestID: "original", CreatedAt: now}).Error; err != nil {
					t.Fatal(err)
				}
			}
			closeDBRuntimeMatrix(t, svc, db)
			var next protocol.Manifest
			if err := json.Unmarshal(readVideoUpgradeFixture(t, filepath.Join("../../../plugin-packages", id, "manifest.json")), &next); err != nil {
				t.Fatal(err)
			}
			next.Contributes.Providers[0].ID = "renamed-luma"
			raw, err := json.Marshal(next)
			if err != nil {
				t.Fatal(err)
			}
			shipVideoUpgradePackage(t, release, id, raw)
			svc, db = openDBRuntimeMatrix(t, dir)
			defer closeDBRuntimeMatrix(t, svc, db)
			view, ok := plugins.ByID(svc.pluginRuntime.List(), id)
			if !ok || view.Manifest.Version != "2.0.0" || view.Retention == nil || view.Retention.Retired {
				t.Fatalf("removed task protocol lost: %+v", view)
			}
			if _, ok := svc.protocolRegistry().Resolve(id); !ok {
				t.Fatal("original protocol no longer resolves")
			}
			stored, err := svc.repo.Task(task.ID)
			if err != nil || stored.InputJSON != task.InputJSON || stored.ProviderRequestID != task.ProviderRequestID || stored.Status != task.Status {
				t.Fatal("retention rewrote the task")
			}
		})
	}
}

// 回退会重新装入旧清单及其缺陷；不把“可以降级”写成“降级仍能取回”。
func TestVideoProtocolRollbackReplaysOldRequests(t *testing.T) {
	for _, id := range []string{"luma-dream-machine", "runway-video"} {
		t.Run(id, func(t *testing.T) {
			allowLoopbackProviderTest(t)
			oldRaw := readVideoUpgradeFixture(t, filepath.Join("testdata/video-protocol-v2.0.4", id+".json"))
			newRaw := readVideoUpgradeFixture(t, filepath.Join("../../../plugin-packages", id, "manifest.json"))
			payload := readVideoUpgradeFixture(t, "testdata/reference-fragmented-30fps.mp4")
			var oldPhase atomic.Bool
			var posts, polls, downloads atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					posts.Add(1)
					http.Error(w, "unexpected write", 400)
					return
				}
				if r.URL.Path == "/video.mp4" {
					downloads.Add(1)
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write(payload)
					return
				}
				if r.Header.Get("Authorization") != "Bearer rollback-fixture" {
					t.Error("original credential lost")
				}
				path := "/v1/tasks/original"
				if id == "luma-dream-machine" {
					path = "/dream-machine/v1/generations/original"
					if oldPhase.Load() {
						path = "/v1" + path
					}
				} else {
					header := "2024-11-06"
					if oldPhase.Load() {
						header = ""
					}
					if r.Header.Get("X-Runway-Version") != header {
						t.Errorf("unexpected version header for rollback phase")
					}
				}
				if r.URL.Path != path {
					t.Errorf("path=%s want=%s", r.URL.Path, path)
					http.NotFound(w, r)
					return
				}
				polls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if id == "luma-dream-machine" {
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "state": "completed", "assets": map[string]any{"video": server.URL + "/video.mp4"}})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "SUCCEEDED", "output": []string{server.URL + "/video.mp4"}})
				}
			}))
			defer server.Close()
			release, dir := t.TempDir(), t.TempDir()
			t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
			shipVideoUpgradePackage(t, release, id, newRaw)
			svc, db := openDBRuntimeMatrix(t, dir)
			input, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{InterfaceType: id, Model: "fixture", BaseURL: server.URL, APIKey: "rollback-fixture"}})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			task := model.Task{ID: "rollback-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(input), CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			closeDBRuntimeMatrix(t, svc, db)
			shipVideoUpgradePackage(t, release, id, oldRaw)
			oldPhase.Store(true)
			svc, db = openDBRuntimeMatrix(t, dir)
			view, _ := plugins.ByID(svc.pluginRuntime.List(), id)
			if view.Manifest.Version != "2.0.0" || view.Retention != nil {
				t.Fatal("rollback did not install the old manifest")
			}
			_, err = svc.QueryFailedVideoTask(context.Background(), "local", task.ID)
			if err == nil || !strings.Contains(err.Error(), "声明式协议已完成但没有返回") {
				t.Fatalf("old parser unexpectedly recovered official receipt: %v", err)
			}
			if posts.Load() != 0 || polls.Load() != 1 || downloads.Load() != 0 {
				t.Fatal("rollback sent unexpected requests")
			}
			stored, err := svc.repo.Task(task.ID)
			if err != nil || stored.Status != model.TaskStatusFailed || !bytes.Equal([]byte(stored.InputJSON), input) {
				t.Fatal("failed rollback changed the task")
			}
			closeDBRuntimeMatrix(t, svc, db)
			shipVideoUpgradePackage(t, release, id, newRaw)
			oldPhase.Store(false)
			svc, db = openDBRuntimeMatrix(t, dir)
			defer closeDBRuntimeMatrix(t, svc, db)
			assertVideoUpgradeInstalled(t, svc, id)
			if _, err := svc.QueryFailedVideoTask(context.Background(), "local", task.ID); err != nil {
				t.Fatal(err)
			}
			assertVideoUpgradeResult(t, svc, dir, task.ID, "original", payload)
			if posts.Load() != 0 || polls.Load() != 2 || downloads.Load() != 1 {
				t.Fatal("re-upgrade resubmitted or failed to download")
			}
		})
	}
}
