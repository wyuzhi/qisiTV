package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/plugins"
	"qisitv/backend/internal/protocol"
)

// 由 #78 附录改成产品回归：真实 SQLite、NewLocal 启动和原任务取回，
// 不再用无盘点构造器替换运行时。旧清单逐字取自 v2.0.4（542124ba）。
func TestVideoProtocolUpgradeRecoversOriginalTasks(t *testing.T) {
	allowLoopbackProviderTest(t)
	// Startup reads this process-wide setting. Prepare every independent runtime
	// before parallel subtests resume; no environment changes occur during polling.
	setOfficialDirectory := func(dir string) { t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", dir) }
	for _, id := range []string{"luma-dream-machine", "runway-video"} {
		for _, source := range []string{"row-id", "log-id", "running"} {
			for _, prefix := range []string{"", "/proxy/v1"} {
				t.Run(id+"/"+source+"/"+prefix, func(t *testing.T) {
					oldRaw := readVideoUpgradeFixture(t, filepath.Join("testdata/video-protocol-v2.0.4", id+".json"))
					newRaw := readVideoUpgradeFixture(t, filepath.Join("../../../plugin-packages", id, "manifest.json"))
					payload := readVideoUpgradeFixture(t, "testdata/reference-fragmented-30fps.mp4")
					release := t.TempDir()
					setOfficialDirectory(release)
					shipVideoUpgradePackage(t, release, id, oldRaw)
					var posts, originalPolls, newPolls, downloads atomic.Int32
					var allowCreate atomic.Bool
					pollPath, createPath := "/v1/tasks/", "/v1/text_to_video"
					if prefix != "" {
						pollPath, createPath = prefix+"/tasks/", prefix+"/text_to_video"
					}
					if id == "luma-dream-machine" {
						pollPath, createPath = "/dream-machine/v1/generations/", "/dream-machine/v1/generations"
					}
					var server *httptest.Server
					server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Content-Type", "application/json")
						if r.Method == http.MethodGet && r.URL.Path == "/video.mp4" {
							downloads.Add(1)
							w.Header().Set("Content-Type", "video/mp4")
							_, _ = w.Write(payload)
							return
						}
						if r.Header.Get("Authorization") != "Bearer original-fixture-key" {
							t.Error("original credential was not used")
						}
						if id == "runway-video" && r.Header.Get("X-Runway-Version") != "2024-11-06" {
							t.Error("Runway version header missing")
						}
						if r.URL.RawQuery != "" {
							t.Errorf("unexpected query %q", r.URL.RawQuery)
						}
						if r.Method == http.MethodPost {
							posts.Add(1)
							if !allowCreate.Load() || r.URL.Path != createPath {
								t.Errorf("unexpected create %s", r.URL.Path)
								http.Error(w, "unexpected create", 400)
								return
							}
							var body map[string]any
							if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
								t.Error(err)
								return
							}
							if id == "luma-dream-machine" {
								if body["prompt"] != "upgrade fixture" || body["duration"] != "5s" || body["aspect_ratio"] != "16:9" {
									t.Errorf("old Luma create mapping: %+v", body)
								}
							} else if body["promptText"] != "upgrade fixture" || body["ratio"] != "1280:720" || body["duration"] != float64(5) || body["prompt"] != nil {
								t.Errorf("old Runway create mapping: %+v", body)
							}
							_, _ = w.Write([]byte(`{"id":"new-result","status":"pending"}`))
							return
						}
						if r.Method != http.MethodGet || (r.URL.Path != pollPath+"original" && r.URL.Path != pollPath+"new-result") {
							t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
							http.NotFound(w, r)
							return
						}
						upstreamID := strings.TrimPrefix(r.URL.Path, pollPath)
						if upstreamID == "original" {
							originalPolls.Add(1)
						} else {
							newPolls.Add(1)
						}
						if id == "luma-dream-machine" {
							_ = json.NewEncoder(w).Encode(map[string]any{"id": upstreamID, "state": "completed", "assets": map[string]any{"video": server.URL + "/video.mp4"}})
						} else {
							_ = json.NewEncoder(w).Encode(map[string]any{"id": upstreamID, "status": "SUCCEEDED", "output": []string{server.URL + "/video.mp4"}})
						}
					}))
					defer server.Close()
					dir := t.TempDir()
					svc, db := openDBRuntimeMatrix(t, dir)
					config := providerConfig{BaseURL: server.URL + prefix, APIKey: "original-fixture-key", Model: "fixture-model", InterfaceType: id, VideoSeconds: "5", Size: "16:9"}
					input, err := json.Marshal(canvasGenerationInput{Mode: "video", Prompt: "upgrade fixture", Config: config})
					if err != nil {
						t.Fatal(err)
					}
					now := time.Now()
					task := model.Task{ID: "original-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(input), CreatedAt: now, UpdatedAt: now}
					if source == "log-id" {
						task.ProviderRequestID = ""
					}
					if source == "running" {
						task.Status = model.TaskStatusRunning
						task.PollStage = "polling"
					}
					if err := db.Create(&task).Error; err != nil {
						t.Fatal(err)
					}
					if source == "log-id" {
						if err := db.Create(&model.ApiCallLog{ID: "original-log", UserID: "local", TaskID: task.ID, Capability: "video", ProviderRequestID: "original", CreatedAt: now}).Error; err != nil {
							t.Fatal(err)
						}
					}
					configPath := writeLocalModelConfig(t, dir, `{"channels":[{"id":"saved","interfaceType":"`+id+`","enabled":false,"baseUrl":"https://example.invalid","apiKey":"saved-fixture-key"}]}`)
					configBytes := readVideoUpgradeFixture(t, configPath)
					closeDBRuntimeMatrix(t, svc, db)
					shipVideoUpgradePackage(t, release, id, newRaw)
					svc, db = openDBRuntimeMatrix(t, dir)
					// 再启动一次，确认升级已持久化；旧任务和日志仍未改变。
					assertVideoUpgradeInstalled(t, svc, id)
					closeDBRuntimeMatrix(t, svc, db)
					svc, db = openDBRuntimeMatrix(t, dir)
					defer closeDBRuntimeMatrix(t, svc, db)
					assertVideoUpgradeInstalled(t, svc, id)
					counts, err := svc.repo.TaskProviderReferences()
					if err != nil || counts[id] != 1 {
						t.Fatalf("references=%v err=%v", counts, err)
					}
					before, err := svc.repo.Task(task.ID)
					if err != nil || before.InputJSON != task.InputJSON || before.ProviderRequestID != task.ProviderRequestID {
						t.Fatal("startup changed the original task")
					}
					if !bytes.Equal(configBytes, readVideoUpgradeFixture(t, configPath)) {
						t.Fatal("startup rewrote saved configuration")
					}
					// Each case owns its database, loaded registry, server and resources.
					// Keep real 30-second polling without serializing twelve waits.
					t.Parallel()

					if source != "running" {
						// 旧失败任务仍在时，新建任务也必须使用当前单一 registry。
						allowCreate.Store(true)
						var requestInput map[string]any
						if err := json.Unmarshal(input, &requestInput); err != nil {
							t.Fatal(err)
						}
						created, err := svc.CreateTask("local", CreateTaskRequest{Type: "canvas_video", Prompt: "upgrade fixture", Input: requestInput})
						if err != nil {
							t.Fatal(err)
						}
						if err := svc.taskWorker().processNextTask(); err != nil {
							t.Fatal(err)
						}
						assertVideoUpgradeResult(t, svc, dir, created.ID, "new-result", payload)
						if posts.Load() != 1 || newPolls.Load() != 1 || originalPolls.Load() != 0 {
							t.Fatal("new task used the wrong upstream identity")
						}
						allowCreate.Store(false)
					}
					postsBefore := posts.Load()
					if source == "running" {
						if err := svc.taskWorker().processNextTask(); err != nil {
							t.Fatal(err)
						}
					} else {
						result, err := svc.QueryFailedVideoTask(context.Background(), "local", task.ID)
						if err != nil {
							t.Fatal(err)
						}
						if !result.Recovered || result.Task.ID != task.ID {
							t.Fatalf("not the original task: %+v", result)
						}
					}
					assertVideoUpgradeResult(t, svc, dir, task.ID, "original", payload)
					if posts.Load() != postsBefore || originalPolls.Load() != 1 || downloads.Load() != newPolls.Load()+1 {
						t.Fatalf("recovery calls posts=%d old-polls=%d new-polls=%d downloads=%d", posts.Load(), originalPolls.Load(), newPolls.Load(), downloads.Load())
					}
					after, err := svc.repo.Task(task.ID)
					if err != nil {
						t.Fatal(err)
					}
					// 成功后产品会精简 InputJSON，完整原输入在已有加密配方中保留。
					originalInput, err := svc.decryptSettingSecret(after.WorkflowSourceCipher)
					if err != nil || originalInput != task.InputJSON {
						t.Fatal("recovery lost the original input")
					}
					t.Logf("original=READY recovery POST=0 GET=1 download=1; new task POST=%d; config/input preserved", posts.Load())
				})
			}
		}
	}
}

func readVideoUpgradeFixture(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func shipVideoUpgradePackage(t *testing.T, release, id string, raw []byte) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	file, err := archive.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(release, id+protocol.PluginPackageExtension), buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertVideoUpgradeInstalled(t *testing.T, svc *Service, id string) {
	t.Helper()
	view, ok := plugins.ByID(svc.pluginRuntime.List(), id)
	if !ok || view.Retention != nil || view.Manifest.Version != "2.0.1" {
		t.Fatalf("normal startup did not install fix: %+v", view)
	}
}

func assertVideoUpgradeResult(t *testing.T, svc *Service, dir, taskID, upstreamID string, payload []byte) {
	t.Helper()
	task, err := svc.taskDomain().Get("local", taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != taskID || task.Status != model.TaskStatusSucceeded || task.ProviderRequestID != upstreamID || task.ResultState != "READY" || len(task.Outputs) != 1 || task.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("incomplete recovery: %+v", task)
	}
	resource, err := svc.repo.Resource(task.Outputs[0].ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	if saved := readVideoUpgradeFixture(t, filepath.Join(dir, "resources", filepath.FromSlash(resource.ObjectKey))); !bytes.Equal(saved, payload) {
		t.Fatal("saved video bytes differ")
	}
}
