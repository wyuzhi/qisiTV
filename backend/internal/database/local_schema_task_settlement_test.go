package database

import (
	"errors"
	"testing"
)

// v2.0.5 发布时库停在 v26，只有 recovery_outcome；升级必须补齐结算原值列并通过启动检查。
func TestTaskSettlementMigrationUpgradesReleasedV26Database(t *testing.T) {
	db, err := Open(Config{DSN: "file:task-settlement-v26?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("stop at v26")
	if err = migrateLocalSchema(db, func(v int64) error {
		if v == 27 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatal(err)
	}
	// v1 建表使用当前模型；用 v2.0.5 的列集合还原已发布库。
	for _, col := range []string{"beef_usage_state", "beef_billing_state", "beef_reconcile_deadline", "image_job_id"} {
		if err = db.Exec("ALTER TABLE tasks DROP COLUMN " + col).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Exec("ALTER TABLE image_submissions DROP COLUMN query_cipher").Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO tasks(id,user_id,type,status,stage,result_json,recovery_outcome) VALUES('released','owner','canvas_image','failed','任务失败','original','no_result')`).Error; err != nil {
		t.Fatal(err)
	}
	if err = RequireLocalSchema(db); err == nil {
		t.Fatal("v26 库不应通过当前结构检查")
	}
	for i := 0; i < 2; i++ {
		if err = MigrateLocalSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	if err = RequireLocalSchema(db); err != nil {
		t.Fatalf("升级后启动检查失败: %v", err)
	}
	var row struct {
		RecoveryOutcome *string
		BeefUsageState  *string
		ImageJobID      string
		ResultJSON      string
	}
	if err = db.Table("tasks").Where("id = ?", "released").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.RecoveryOutcome == nil || *row.RecoveryOutcome != "no_result" || row.BeefUsageState != nil || row.ImageJobID != "" || row.ResultJSON != "original" {
		t.Fatalf("历史任务被改写: %+v", row)
	}
}
