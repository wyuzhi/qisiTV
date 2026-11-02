package database

import (
	"errors"
	"testing"
)

func TestManagedQueryIdentityUpgradesV27WithoutChangingExistingSubmission(t *testing.T) {
	db, err := Open(Config{DSN: "file:managed-query-v27?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	stop := errors.New("v27")
	if err = migrateLocalSchema(db, func(v int64) error {
		if v == 28 {
			return stop
		}
		return nil
	}); !errors.Is(err, stop) {
		t.Fatal(err)
	}
	if err = db.Exec("ALTER TABLE image_submissions DROP COLUMN query_cipher").Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO image_submissions(attempt_id,task_id,user_id,request_cipher,send_count,response_accepted) VALUES('old','task','owner','original-wire',1,1)`).Error; err != nil {
		t.Fatal(err)
	}
	if err = RequireLocalSchema(db); err == nil {
		t.Fatal("v27 incorrectly ready")
	}
	for i := 0; i < 2; i++ {
		if err = MigrateLocalSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	if err = RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	var row struct {
		RequestCipher    string
		QueryCipher      *string
		SendCount        int
		ResponseAccepted bool
	}
	if err = db.Table("image_submissions").Where("attempt_id = ?", "old").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.RequestCipher != "original-wire" || row.QueryCipher != nil || row.SendCount != 1 || !row.ResponseAccepted {
		t.Fatalf("changed historical row: %+v", row)
	}
	if err = db.Exec("ALTER TABLE image_submissions DROP COLUMN query_cipher").Error; err != nil {
		t.Fatal(err)
	}
	if err = RequireLocalSchema(db); err == nil {
		t.Fatal("missing query_cipher accepted")
	}
}
