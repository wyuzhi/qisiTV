package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

func TestHistoricalImageAutoRecoveryDownloadsAndBindsLegacyCanvas(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, canvasID, revision := newAssistantTurnService(t)
	db := s.repo.DB()
	png, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
	var gets, posts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			posts.Add(1)
			w.WriteHeader(500)
			return
		}
		gets.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer upstream.Close()
	task := model.Task{ID: "historical-image", UserID: "local", ProjectID: canvasID, Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", Error: "context deadline exceeded", RouteRun: 3,
		InputJSON: `{"mode":"image","metadata":{"source":"canvas","nodeId":"n1"}}`}
	doc, _ := json.Marshal(map[string]any{"id": canvasID, "title": "历史图片恢复", "revision": revision, "nodes": []any{map[string]any{"id": "n1", "type": "image", "title": "图片", "position": map[string]any{"x": 0, "y": 0}, "metadata": map[string]any{"taskId": task.ID, "status": "error", "generationSubmissionState": "unknown"}}}, "connections": []any{}})
	if _, err := s.UpsertUserCanvasProject("local", doc); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	receipt := model.ApiCallLog{ID: "legacy-receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: fmt.Sprintf(`{"data":[{"url":%q}]}`, upstream.URL+"/original.png")}
	if err := db.Create(&receipt).Error; err != nil {
		t.Fatal(err)
	}
	before, err := s.Task("local", task.ID)
	if err != nil || before.Outcome == nil || before.Outcome.Phase != "retrievable" {
		t.Fatalf("恢复前=%+v %v", before, err)
	}
	// 只启动真实交付定时器，不启动会执行生成的主 worker。
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	ctx, _ := s.backgroundWorkers().Start()
	s.startGenerationDeliveryRecovery(ctx)
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.backgroundWorkers().Stop(stop); err != nil {
			t.Error(err)
		}
		closeDB(t, db)
	})
	var document struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		got, err := s.Task("local", task.ID)
		if err == nil && got.Outcome != nil && got.Outcome.Phase == "ready" {
			// 成片入库和画布绑定是不同提交；等真实绑定，不以 ready 代替画布完成。
			raw, loadErr := s.UserCanvasProject("local", canvasID)
			if loadErr == nil && json.Unmarshal(raw, &document) == nil && len(document.Nodes) == 1 && document.Nodes[0].Metadata["status"] == "success" && document.Nodes[0].Metadata["content"] != nil {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	got, err := s.Task("local", task.ID)
	if err != nil || got.Status != model.TaskStatusSucceeded || got.Outcome.Phase != "ready" || got.RouteRun != 3 || len(got.Outputs) != 1 || got.Outputs[0].ResourceID == "" {
		t.Fatalf("恢复后=%+v %v", got, err)
	}
	raw, err := s.UserCanvasProject("local", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	meta := document.Nodes[0].Metadata
	if meta["status"] != "success" || meta["content"] == nil {
		t.Fatalf("旧前端使用的成片字段未写回: %s", raw)
	}
	var tasks, attempts int64
	db.Model(&model.Task{}).Count(&tasks)
	db.Model(&model.RouteAttempt{}).Count(&attempts)
	if tasks != 1 || attempts != 0 || posts.Load() != 0 || gets.Load() != 1 {
		t.Fatalf("任务=%d 路由=%d GET=%d POST=%d", tasks, attempts, gets.Load(), posts.Load())
	}
	t.Logf("历史回执→后台重建→GET 下载→旧画布 success/content：通过；task=%s routeRun=%d，GET=%d POST=%d", got.ID, got.RouteRun, gets.Load(), posts.Load())
}

func TestAutomaticImageRecoveryConclusions(t *testing.T) {
	for _, name := range []string{"missing", "incomplete", "ambiguous", "business-failed", "rejected", "read-failure", "lease-conflict"} {
		t.Run(name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			task := model.Task{ID: "task", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown"}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if name != "missing" && name != "rejected" {
				r := model.ApiCallLog{ID: "receipt", UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", Path: "/v1/images/generations", APIFormat: "openai", Status: model.ApiCallStatusSucceeded, StatusCode: 200, ResponseBody: `{"data":[]}`}
				if name == "business-failed" {
					r.ResponseBody = `{"code":500,"message":"failed"}`
				}
				if err := db.Create(&r).Error; err != nil {
					t.Fatal(err)
				}
				if name == "ambiguous" {
					r.ID = "second"
					if err := db.Create(&r).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			if name == "rejected" {
				if err := db.Create(&model.RouteAttempt{ID: "attempt", TaskID: task.ID, DispatchState: "rejected_no_job"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if name == "read-failure" {
				if err := db.Migrator().DropTable(&model.ApiCallLog{}); err != nil {
					t.Fatal(err)
				}
			}
			if name == "lease-conflict" {
				if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, task.UserID, "manual-recovery:other", time.Minute); err != nil {
					t.Fatal(err)
				}
			}
			err := s.recoverFailedImage(context.Background(), task)
			stored, loadErr := s.repo.Task(task.ID)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if name == "read-failure" || name == "lease-conflict" {
				if err == nil || stored.RecoveryOutcome != nil {
					t.Fatalf("暂时失败变成永久结论: %+v %v", stored, err)
				}
				return
			}
			want := localtask.RecoveryUnrecoverable
			if name == "rejected" || name == "business-failed" {
				want = localtask.RecoveryNoResult
			}
			if err != nil || stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != want {
				t.Fatalf("结论=%+v want=%s err=%v", stored, want, err)
			}
			got, err := s.Task(task.UserID, task.ID)
			if err != nil || got.Outcome.Phase != "failed" {
				t.Fatalf("投影=%+v err=%v", got, err)
			}
			if name != "rejected" && got.Outcome.Regenerate != "confirm" {
				t.Fatal("没有结果被当成未计费")
			}
		})
	}
}

func TestAutomaticImageReplayUsesFrozenRequestBeyondOldSendLimit(t *testing.T) {
	for _, multipart := range []bool{false, true} {
		t.Run(fmt.Sprint(multipart), func(t *testing.T) {
			s, db, task, row, original := imageSubmissionFixture(t, multipart)
			var sends atomic.Int32
			var originalKey string
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" {
					t.Error("不应重新协商或组装请求")
					w.WriteHeader(500)
					return
				}
				sends.Add(1)
				body, _ := io.ReadAll(r.Body)
				if string(body) != string(original) || r.Header.Get("Idempotency-Key") != originalKey || r.Header.Get("Authorization") != "Bearer private-test-key" {
					t.Error("原字节或原键改变")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"data":[{"url":%q}]}`, serverArtifactURL)
			}))
			defer server.Close()
			// 测试传输替身只连接本机 TLS 服务器；没有真实模型地址。
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			plain, err := s.decryptSettingSecret(row.RequestCipher)
			if err != nil {
				t.Fatal(err)
			}
			var wire imageWireRequest
			json.Unmarshal([]byte(plain), &wire)
			originalKey = wire.Header.Get("Idempotency-Key")
			wire.URL = server.URL + "/v1/images/generations"
			if multipart {
				wire.URL = server.URL + "/v1/images/edits"
			}
			encoded, _ := json.Marshal(wire)
			row.RequestCipher, err = s.encryptSettingSecret(string(encoded))
			if err != nil {
				t.Fatal(err)
			}
			row.SendCount = imageRecoveryMaxSends
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			pinImageRecoveryChannel(t, s, db, row)
			// 前两次同键发送都没拿到应答；不能把多条传输日志当成结果必定丢失。
			for i := 0; i < 2; i++ {
				if err := db.Create(&model.ApiCallLog{ID: fmt.Sprintf("unknown-%d", i), UserID: task.UserID, TaskID: task.ID, Capability: "image", RequestKind: "create", Method: "POST", StatusCode: 0}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "submission_unknown", "lease_owner": "", "lease_expires_at": nil, "input_json": `{"prompt":"changed after restart"}`}).Error; err != nil {
				t.Fatal(err)
			}
			owner := "manual-recovery:replay"
			if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, task.UserID, owner, time.Minute); err != nil {
				t.Fatal(err)
			}
			current, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			result, outcome, err := s.failedImageResultWith(context.Background(), *current, func(req *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				resp, err := server.Client().Do(req)
				if err != nil {
					return nil, "", err
				}
				defer resp.Body.Close()
				data, err := io.ReadAll(resp.Body)
				return data, resp.Header.Get("Content-Type"), err
			})
			if err != nil || outcome != "" || len(result) == 0 {
				t.Fatalf("outcome=%s err=%v", outcome, err)
			}
			if err := s.saveTaskCompletionWithinStorageQuota(current, result, nil, false); err != nil {
				t.Fatal(err)
			}
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if sends.Load() != 1 || stored.Status != model.TaskStatusSucceeded || stored.RouteRun != task.RouteRun {
				t.Fatalf("sends=%d stored=%+v", sends.Load(), stored)
			}
		})
	}
}

const serverArtifactURL = "https://example.invalid/original.png"

func TestAutomaticImageRecoveryExpiredOrUnsafeReplayNeverSends(t *testing.T) {
	for _, mode := range []string{"expired", "no-protocol", "wrong-key", "cancelled", "stale-run"} {
		t.Run(mode, func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			task.Status = model.TaskStatusFailed
			task.Stage = "submission_unknown"
			task.LeaseOwner = ""
			task.LeaseExpiresAt = nil
			switch mode {
			case "expired":
				row.CreatedAt = time.Now().Add(-24 * time.Hour)
			case "cancelled":
				task.Status = model.TaskStatusCancelled
			case "stale-run":
				task.RouteRun++
			default:
				plain, _ := s.decryptSettingSecret(row.RequestCipher)
				var wire imageWireRequest
				json.Unmarshal([]byte(plain), &wire)
				if mode == "no-protocol" {
					wire.ReplayProtocol = ""
				} else {
					wire.Header.Set("Idempotency-Key", "different")
				}
				encoded, _ := json.Marshal(wire)
				row.RequestCipher, _ = s.encryptSettingSecret(string(encoded))
			}
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.recoverFailedImages(context.Background(), 8); err != nil {
				t.Fatal(err)
			}
			stored, _ := s.repo.Task(task.ID)
			fresh, _ := s.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
			if fresh.SendCount != 0 || stored.Status != task.Status {
				t.Fatal("越权恢复或发送了不安全的请求")
			}
			if mode != "cancelled" && (stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != localtask.RecoveryUnrecoverable) {
				t.Fatal("缺失取不回结论")
			}
		})
	}
}

func TestAutomaticImageRecoveryTemporaryReplayPreservesUnknown(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	pinImageRecoveryChannel(t, s, db, row)
	task.Status = model.TaskStatusFailed
	task.LeaseOwner = "manual-recovery:test"
	at := time.Now().Add(time.Minute)
	task.LeaseExpiresAt = &at
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, _, err := s.sendImageSubmissionWithMode(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
		if err := admit(); err != nil {
			return nil, "", err
		}
		calls++
		return nil, "", generation.RequestPreparationError{Cause: errors.New("temporary")}
	}, noImageWait, true)
	if err == nil || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	stored, _ := s.repo.Task(task.ID)
	if stored.RecoveryOutcome != nil {
		t.Fatal("发送失败被当成结果丢失")
	}
}
