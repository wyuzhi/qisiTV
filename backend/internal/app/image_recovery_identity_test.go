package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

// 每个恢复夹具都明确建立原 route attempt 的渠道和凭据，而非借用当前路由。
func pinImageRecoveryChannel(t *testing.T, s *Service, db *gorm.DB, row *model.ImageSubmission) *model.ModelChannel {
	t.Helper()
	wire, err := s.imageSubmissionWire(row)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(wire.URL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := s.encryptSettingSecret(strings.TrimPrefix(wire.Header.Get("Authorization"), "Bearer "))
	if err != nil {
		t.Fatal(err)
	}
	channel := &model.ModelChannel{ID: "original-image-channel", Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: u.Scheme + "://" + u.Host, APIKey: key}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.RouteAttempt{}).Where("id = ?", row.AttemptID).Update("channel_id", channel.ID).Error; err != nil {
		t.Fatal(err)
	}
	wire.ChannelID = channel.ID
	encoded, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	row.RequestCipher, err = s.encryptSettingSecret(string(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Save(row).Error; err != nil {
		t.Fatal(err)
	}
	return channel
}

func TestImageSubmissionFreezesOriginalAttemptChannel(t *testing.T) {
	s, db, task, _, body := imageSubmissionFixture(t, false)
	attempt := &model.RouteAttempt{ID: "next-original-attempt", TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: 2, ChannelID: "original-route-channel", DispatchState: "submission_unknown", StartedAt: time.Now()}
	if err := db.Create(attempt).Error; err != nil {
		t.Fatal(err)
	}
	task.InputJSON = `{"mode":"image","config":{"channelId":"different-current-channel"}}`
	ctx := withProviderSubmissionKey(withProviderAnalytics(context.Background(), s, task), attempt)
	ctx = context.WithValue(generation.WithImageReplayProtocol(ctx, generation.ImageReplayProtocol), imageTaskContext{}, task)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://enterprise.beefapi.com/v1/images/generations", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer original-upstream-token")
	row, handled, err := prepareImageSubmission(s, req)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	wire, err := s.imageSubmissionWire(row)
	if err != nil || wire.ChannelID != attempt.ChannelID || wire.Header.Get("Authorization") != "Bearer original-upstream-token" || string(wire.Body) != string(body) {
		t.Fatal("冻结请求未绑定原 attempt 渠道与实际传输凭据")
	}
}

func TestAutomaticImageRecoveryPinsOriginalChannelAndCredentialIdentity(t *testing.T) {
	for _, mode := range []string{"unchanged", "task-selects-other-channel", "legacy-routed-snapshot", "original-disabled", "original-deleted", "original-token-replaced", "original-origin-replaced", "snapshot-channel-mismatch", "snapshot-token-mismatch", "late-disable", "late-token-replacement", "channel-read-failure"} {
		t.Run(mode, func(t *testing.T) {
			s, db, task, row, originalBody := imageSubmissionFixture(t, false)
			originalChannel := pinImageRecoveryChannel(t, s, db, row)
			wire, err := s.imageSubmissionWire(row)
			if err != nil {
				t.Fatal(err)
			}
			originalURL, originalAuth, originalKey := wire.URL, wire.Header.Get("Authorization"), wire.Header.Get("Idempotency-Key")
			otherKey, err := s.encryptSettingSecret("other-upstream-token")
			if err != nil {
				t.Fatal(err)
			}
			other := &model.ModelChannel{ID: "other-image-channel", Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: "https://other.invalid", APIKey: otherKey}
			if err := db.Create(other).Error; err != nil {
				t.Fatal(err)
			}
			task.Status, task.Stage, task.LeaseOwner = model.TaskStatusFailed, "submission_unknown", "manual-recovery:identity"
			until := time.Now().Add(time.Minute)
			task.LeaseExpiresAt = &until
			switch mode {
			case "task-selects-other-channel":
				task.InputJSON = `{"mode":"image","config":{"channelId":"other-image-channel","baseUrl":"https://other.invalid","apiKey":"other-upstream-token"}}`
				task.RouteID, task.ChannelModelID = "other-route", "other-model"
			case "original-disabled":
				if err := db.Model(originalChannel).Update("enabled", false).Error; err != nil {
					t.Fatal(err)
				}
			case "original-deleted":
				if err := db.Delete(originalChannel).Error; err != nil {
					t.Fatal(err)
				}
			case "original-token-replaced":
				if err := db.Model(originalChannel).Update("api_key", otherKey).Error; err != nil {
					t.Fatal(err)
				}
			case "original-origin-replaced":
				if err := db.Model(originalChannel).Update("base_url", other.BaseURL).Error; err != nil {
					t.Fatal(err)
				}
			case "legacy-routed-snapshot", "snapshot-channel-mismatch", "snapshot-token-mismatch":
				wire.ChannelID = ""
				if mode == "snapshot-channel-mismatch" {
					wire.ChannelID = other.ID
				}
				if mode == "snapshot-token-mismatch" {
					wire.Header.Set("Authorization", "Bearer other-upstream-token")
				}
				encoded, _ := json.Marshal(wire)
				row.RequestCipher, err = s.encryptSettingSecret(string(encoded))
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Save(row).Error; err != nil {
					t.Fatal(err)
				}
			case "channel-read-failure":
				if err := db.Migrator().DropTable(&model.ModelChannel{}); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			sends := 0
			result, conclusion, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
				if mode == "late-disable" {
					if err := db.Model(originalChannel).Update("enabled", false).Error; err != nil {
						t.Fatal(err)
					}
				}
				if mode == "late-token-replacement" {
					if err := db.Model(originalChannel).Update("api_key", otherKey).Error; err != nil {
						t.Fatal(err)
					}
				}
				if err := admit(); err != nil {
					return nil, "", err
				}
				sends++
				body, readErr := io.ReadAll(req.Body)
				if readErr != nil {
					t.Fatal(readErr)
				}
				if req.URL.String() != originalURL || req.Header.Get("Authorization") != originalAuth || req.Header.Get("Idempotency-Key") != originalKey || string(body) != string(originalBody) {
					t.Fatal("原渠道、凭据、键或字节改变")
				}
				if canonicalCallMeta(req.Context()).ChannelID != originalChannel.ID {
					t.Fatal("传输运行时被当前任务的新渠道覆盖")
				}
				return []byte(`{"data":[{"url":"https://example.invalid/original.png"}]}`), "application/json", nil
			})
			allowed := mode == "unchanged" || mode == "task-selects-other-channel" || mode == "legacy-routed-snapshot"
			if allowed {
				if err != nil || sends != 1 || conclusion != "" || len(result) == 0 {
					t.Fatalf("sends=%d conclusion=%s err=%v", sends, conclusion, err)
				}
				return
			}
			if sends != 0 || len(result) != 0 {
				t.Fatal("原渠道不可用时仍然重发或改走备用渠道")
			}
			if mode == "channel-read-failure" {
				if err == nil || conclusion != "" {
					t.Fatal("数据库读取错误被当成永久拿不回")
				}
			} else if err != nil || conclusion != localtask.RecoveryUnrecoverable {
				t.Fatalf("conclusion=%s err=%v", conclusion, err)
			}
			// 再走真实恢复编排，验证结论持久化后读投影仍须确认，不仅检查 helper 返回值。
			task.LeaseOwner, task.LeaseExpiresAt = "", nil
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			recoveryErr := s.recoverFailedImage(context.Background(), task)
			stored, loadErr := s.repo.Task(task.ID)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if mode == "channel-read-failure" {
				if recoveryErr == nil || stored.RecoveryOutcome != nil {
					t.Fatal("临时数据库故障写入永久结论")
				}
			} else {
				got, loadErr := s.Task(task.UserID, task.ID)
				if recoveryErr != nil || loadErr != nil || got.Outcome.Phase != "failed" || got.Outcome.Regenerate != "confirm" || stored.RecoveryOutcome == nil || *stored.RecoveryOutcome != localtask.RecoveryUnrecoverable {
					t.Fatalf("未保持拿不回/需确认: task=%+v err=%v %v", got, recoveryErr, loadErr)
				}
			}
			storedSubmission, err := s.repo.ImageSubmission(row.AttemptID, task.ID, task.UserID)
			if err != nil || storedSubmission.SendCount != 0 {
				t.Fatal("原身份不可用时占用了发送次数")
			}
			var attempts int64
			if err := db.Model(&model.RouteAttempt{}).Where("task_id = ?", task.ID).Count(&attempts).Error; err != nil {
				t.Fatal(err)
			}
			if attempts != 1 || stored.RouteRun != task.RouteRun {
				t.Fatal("偷偷创建了新路由或轮次")
			}
		})
	}
}

func TestImageSubmissionRunningReplayStopsWhenOriginalIdentityUnavailable(t *testing.T) {
	for _, mode := range []string{"disabled", "deleted", "token-replaced"} {
		t.Run(mode, func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			original := pinImageRecoveryChannel(t, s, db, row)
			row.SendCount = 1 // 模拟原 worker 已提交，随后继续或重启接续；不是首次发送。
			if err := db.Save(row).Error; err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "disabled":
				if err := db.Model(original).Update("enabled", false).Error; err != nil {
					t.Fatal(err)
				}
			case "deleted":
				if err := db.Delete(original).Error; err != nil {
					t.Fatal(err)
				}
			case "token-replaced":
				key, err := s.encryptSettingSecret("new-token")
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Model(original).Update("api_key", key).Error; err != nil {
					t.Fatal(err)
				}
			}
			sends := 0
			_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				sends++
				return []byte(`{"data":[{"url":"https://example.invalid/original.png"}]}`), "application/json", nil
			}, noImageWait)
			if !errors.Is(err, errImageRecoveryIdentityUnavailable) || sends != 0 || row.SendCount != 1 {
				t.Fatalf("sends=%d count=%d err=%v", sends, row.SendCount, err)
			}
		})
	}
}

func TestAutomaticImageRecoveryStopsOnOriginalCredentialRejection(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			pinImageRecoveryChannel(t, s, db, row)
			task.Status, task.LeaseOwner = model.TaskStatusFailed, "manual-recovery:revoked"
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			sends := 0
			_, conclusion, err := s.failedImageResultWith(context.Background(), task, func(req *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				sends++
				if req.Header.Get("Authorization") != "Bearer private-test-key" {
					t.Fatal("替换了原凭据")
				}
				return nil, "", providerHTTPError{StatusCode: status, Body: `{"error":{"code":"token_revoked"}}`}
			})
			if err != nil || conclusion != localtask.RecoveryUnrecoverable || sends != 1 {
				t.Fatalf("sends=%d conclusion=%s err=%v", sends, conclusion, err)
			}
		})
	}
}

func TestAutomaticImageRecoveryDirectChannelIdentity(t *testing.T) {
	for _, id := range []string{"beefapi", "custom"} {
		for _, mode := range []string{"unchanged", "rotated", "disabled", "deleted"} {
			t.Run(id+"/"+mode, func(t *testing.T) {
				s, _, task, row, _ := imageSubmissionFixture(t, false)
				wire, err := s.imageSubmissionWire(row)
				if err != nil {
					t.Fatal(err)
				}
				wire.ChannelID = id
				channel := map[string]any{"id": id, "enabled": true, "baseUrl": "https://enterprise.beefapi.com", "apiKey": "private-test-key"}
				if mode == "rotated" {
					channel["apiKey"] = "new-token"
				}
				if mode == "disabled" {
					channel["enabled"] = false
				}
				channels := []any{channel}
				if mode == "deleted" {
					channels = nil
				}
				body, _ := json.Marshal(map[string]any{"channels": channels})
				if err := s.SaveLocalModelConfig(body); err != nil {
					t.Fatal(err)
				}
				available, err := s.imageRecoveryChannelAvailable(&model.RouteAttempt{ID: row.AttemptID, TaskID: task.ID}, wire)
				if err != nil || available != (mode == "unchanged") {
					t.Fatalf("available=%v err=%v", available, err)
				}
			})
		}
	}
}
