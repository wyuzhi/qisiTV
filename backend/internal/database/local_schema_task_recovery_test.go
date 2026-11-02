package database

import (
	"errors"
	"testing"

	"qisitv/backend/internal/model"
)

func TestTaskRecoveryOutcomeMigrationOnlyAddsNullableColumn(t *testing.T) {
	db, err := Open(Config{DSN: "file:task-recovery-v25?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("stop at v25")
	if err = migrateLocalSchema(db, func(v int64) error {
		if v == 26 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatal(err)
	}
	// v1 创建新库会使用当前模型；用明确历史 DDL 去掉尚未存在的列。
	if err = db.Exec("ALTER TABLE tasks DROP COLUMN recovery_outcome").Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("ALTER TABLE tasks ADD COLUMN custom_marker TEXT").Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO tasks(id,user_id,type,status,stage,result_json,custom_marker) VALUES('historical','owner','canvas_image','running','上游生成中','original','keep')`).Error; err != nil {
		t.Fatal(err)
	}
	var before string
	if err = db.Raw("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").Scan(&before).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = MigrateLocalSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var row struct {
		Status          string
		ResultJSON      string
		RecoveryOutcome *string
		CustomMarker    string
	}
	if err = db.Table("tasks").Where("id = ?", "historical").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.Status != "running" || row.ResultJSON != "original" || row.RecoveryOutcome != nil || row.CustomMarker != "keep" {
		t.Fatalf("历史记录被改写: %+v", row)
	}
	var columns []struct {
		Name      string
		Notnull   int
		DfltValue *string
	}
	if err = db.Raw("PRAGMA table_info(tasks)").Scan(&columns).Error; err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range columns {
		if c.Name == "recovery_outcome" {
			found = true
			if c.Notnull != 0 || c.DfltValue != nil {
				t.Fatal("新列不是无默认值的可空列")
			}
		}
	}
	if !found {
		t.Fatal("缺少 recovery_outcome")
	}
	if err = RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("ALTER TABLE tasks DROP COLUMN recovery_outcome").Error; err != nil {
		t.Fatal(err)
	}
	if err = RequireLocalSchema(db); err == nil {
		t.Fatal("缺少已迁移列仍标 Ready")
	}
}

func TestTaskRecoveryOutcomeMigrationRollsBackWithLedgerFailure(t *testing.T) {
	db, err := Open(Config{DSN: "file:task-recovery-rollback?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("v25")
	if err = migrateLocalSchema(db, func(v int64) error {
		if v == 26 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatal(err)
	}
	if err = db.Exec("ALTER TABLE tasks DROP COLUMN recovery_outcome").Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`CREATE TRIGGER fail_v26 BEFORE INSERT ON local_schema_migrations WHEN NEW.version = 26 BEGIN SELECT RAISE(ABORT, 'injected'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if err = MigrateLocalSchema(db); err == nil {
		t.Fatal("注入失败没有阻止迁移")
	}
	version, _ := currentSchemaVersion(db)
	if version != 25 || db.Migrator().HasColumn(&model.Task{}, "recovery_outcome") {
		t.Fatal("DDL 与迁移记录未同时回滚")
	}
}
