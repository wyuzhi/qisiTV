package operations

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"qisitv/backend/internal/model"
)

func newOpRecordStore(t *testing.T) (*Store, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "ops.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.AgentOpRecord{}); err != nil {
		t.Fatal(err)
	}
	return NewStore(db), db
}

func countRunningReceipts(t *testing.T, db *gorm.DB, userID, opID string) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ? AND status = ?", userID, opID, "running").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func runOutOfTxRequest(opID string) RunRequest {
	return RunRequest{UserID: "user-1", OpID: opID, Op: "task.cancel", PayloadHash: "payload-1"}
}

func TestOutOfTxReceiptCleanedWhenHandlerPanics(t *testing.T) {
	store, db := newOpRecordStore(t)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("handler panic must propagate")
			}
		}()
		_, _ = store.Run(context.Background(), runOutOfTxRequest("panic-op"), func(*gorm.DB) ([]byte, error) {
			panic("boom")
		})
	}()
	if got := countRunningReceipts(t, db, "user-1", "panic-op"); got != 0 {
		t.Fatalf("panic 后不得留下 running 回执，得到 %d", got)
	}
}

func TestOutOfTxReceiptCleanedWhenSuccessUpdateFails(t *testing.T) {
	store, db := newOpRecordStore(t)
	if err := db.Exec(`CREATE TRIGGER fail_success_update BEFORE UPDATE ON agent_op_records
		WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := store.Run(context.Background(), runOutOfTxRequest("update-fail-op"), func(*gorm.DB) ([]byte, error) {
		return []byte(`{"ok":true}`), nil
	}); err == nil {
		t.Fatal("最终回执更新失败必须返回错误")
	}
	var count int64
	if err := db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", "user-1", "update-fail-op").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("最终回执更新失败后不得留下回执，得到 %d 条", count)
	}
}

func TestStaleRunningReceiptAllowsRetry(t *testing.T) {
	store, db := newOpRecordStore(t)
	stale := model.AgentOpRecord{
		UserID: "user-1", OpID: "stale-op", Op: "task.cancel", PayloadHash: "payload-1",
		Status: "running", CreatedAt: time.Now().Add(-5 * time.Minute),
	}
	if err := db.Create(&stale).Error; err != nil {
		t.Fatal(err)
	}
	outcome, err := store.Run(context.Background(), runOutOfTxRequest("stale-op"), func(*gorm.DB) ([]byte, error) {
		return []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatalf("过期 running 回执应允许重试: %v", err)
	}
	if outcome.Replayed {
		t.Fatal("过期回执必须重新执行而不是标记为回放")
	}
	var stored model.AgentOpRecord
	if err := db.Where("user_id = ? AND op_id = ?", "user-1", "stale-op").First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != "succeeded" || stored.ResultJSON != `{"ok":true}` {
		t.Fatalf("重试后回执未落定: %+v", stored)
	}
}

func TestFreshRunningReceiptStillRejectsRetry(t *testing.T) {
	store, db := newOpRecordStore(t)
	fresh := model.AgentOpRecord{
		UserID: "user-1", OpID: "fresh-op", Op: "task.cancel", PayloadHash: "payload-1",
		Status: "running", CreatedAt: time.Now(),
	}
	if err := db.Create(&fresh).Error; err != nil {
		t.Fatal(err)
	}
	_, err := store.Run(context.Background(), runOutOfTxRequest("fresh-op"), func(*gorm.DB) ([]byte, error) {
		t.Fatal("执行中的回执不得重跑")
		return nil, nil
	})
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "operation_in_progress" {
		t.Fatalf("执行中的回执必须继续拒绝，得到 %v", err)
	}
	if got := countRunningReceipts(t, db, "user-1", "fresh-op"); got != 1 {
		t.Fatalf("拒绝重试不得删除执行中的回执，得到 %d", got)
	}
}

func TestStaleRunningReceiptRejectsDifferentPayload(t *testing.T) {
	store, db := newOpRecordStore(t)
	stale := model.AgentOpRecord{
		UserID: "user-1", OpID: "stale-mismatch", Op: "task.cancel", PayloadHash: "payload-1",
		Status: "running", CreatedAt: time.Now().Add(-5 * time.Minute),
	}
	if err := db.Create(&stale).Error; err != nil {
		t.Fatal(err)
	}
	req := runOutOfTxRequest("stale-mismatch")
	req.PayloadHash = "payload-2"
	_, err := store.Run(context.Background(), req, func(*gorm.DB) ([]byte, error) {
		t.Fatal("不同参数的过期回执不得重跑")
		return nil, nil
	})
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "operation_id_reused_with_different_payload" {
		t.Fatalf("过期回执换参数必须拒绝，得到 %v", err)
	}
	if got := countRunningReceipts(t, db, "user-1", "stale-mismatch"); got != 1 {
		t.Fatalf("拒绝重试不得删除原回执，得到 %d", got)
	}
}

type rejectTurnGuard struct{}

func (rejectTurnGuard) VerifyOpenAssistantTurnInTx(*gorm.DB, string, string, string) error {
	return PreconditionFailed("turn_closed", "助手回合已经结束", nil)
}

func TestStaleScriptReceiptStillVerifiesTurnGuard(t *testing.T) {
	store, db := newOpRecordStore(t)
	stale := model.AgentOpRecord{
		UserID: "user-1", OpID: "stale-script", Op: "skill.script.run", PayloadHash: "payload-1",
		Status: "running", TurnID: "turn-1", CreatedAt: time.Now().Add(-time.Hour),
	}
	if err := db.Create(&stale).Error; err != nil {
		t.Fatal(err)
	}
	req := RunRequest{UserID: "user-1", OpID: "stale-script", Op: "skill.script.run", PayloadHash: "payload-1",
		TurnID: "turn-1", TurnGuard: rejectTurnGuard{}}
	_, err := store.Run(context.Background(), req, func(*gorm.DB) ([]byte, error) {
		t.Fatal("过期回执接管也必须先通过回合校验")
		return nil, nil
	})
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodePreconditionFailed || opErr.Reason != "turn_closed" {
		t.Fatalf("expected turn_closed, got %v", err)
	}
	var stored model.AgentOpRecord
	if err := db.Where("user_id = ? AND op_id = ?", "user-1", "stale-script").First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != "running" || stored.TurnID != "turn-1" {
		t.Fatalf("回合校验失败必须回滚接管，得到 %+v", stored)
	}
}

func TestLeaseTakeoverDoesNotOverwriteNewReceipt(t *testing.T) {
	store, db := newOpRecordStore(t)
	stale := model.AgentOpRecord{
		UserID: "user-1", OpID: "takeover-op", Op: "task.cancel", PayloadHash: "payload-1",
		Status: "running", CreatedAt: time.Now().Add(-5 * time.Minute),
	}
	if err := db.Create(&stale).Error; err != nil {
		t.Fatal(err)
	}
	_, err := store.Run(context.Background(), runOutOfTxRequest("takeover-op"), func(root *gorm.DB) ([]byte, error) {
		if err := root.Where("user_id = ? AND op_id = ?", "user-1", "takeover-op").Delete(&model.AgentOpRecord{}).Error; err != nil {
			return nil, err
		}
		replacement := model.AgentOpRecord{UserID: "user-1", OpID: "takeover-op", Op: "task.cancel",
			PayloadHash: "payload-1", Status: "running", CreatedAt: time.Now().Add(time.Second)}
		if err := root.Create(&replacement).Error; err != nil {
			return nil, err
		}
		return []byte(`{"old":true}`), nil
	})
	if opErr, ok := err.(*Error); !ok || opErr.Code != CodeConflict || opErr.Reason != "operation_superseded" {
		t.Fatalf("被接管的旧执行不得覆盖新回执，得到 %v", err)
	}
	var stored model.AgentOpRecord
	if err := db.Where("user_id = ? AND op_id = ?", "user-1", "takeover-op").First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != "running" || stored.ResultJSON != "" {
		t.Fatalf("新执行的回执被旧执行改写: %+v", stored)
	}
}

func TestCanceledRequestContextStillFinalizesReceipt(t *testing.T) {
	store, db := newOpRecordStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	outcome, err := store.Run(ctx, runOutOfTxRequest("canceled-ctx-op"), func(*gorm.DB) ([]byte, error) {
		cancel()
		return []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatalf("客户端取消不应阻止回执落定: %v", err)
	}
	if string(outcome.Result) != `{"ok":true}` {
		t.Fatalf("unexpected result: %s", outcome.Result)
	}
	var stored model.AgentOpRecord
	if err := db.Where("user_id = ? AND op_id = ?", "user-1", "canceled-ctx-op").First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != "succeeded" {
		t.Fatalf("回执未落定: %+v", stored)
	}
}

func TestCanceledRequestContextCleansRunningReceipt(t *testing.T) {
	store, db := newOpRecordStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	_, err := store.Run(ctx, runOutOfTxRequest("canceled-error-op"), func(*gorm.DB) ([]byte, error) {
		cancel()
		return nil, errors.New("boom")
	})
	if err == nil {
		t.Fatal("handler failure must return an error")
	}
	if got := countRunningReceipts(t, db, "user-1", "canceled-error-op"); got != 0 {
		t.Fatalf("客户端取消后不得留下 running 回执，得到 %d", got)
	}
}
