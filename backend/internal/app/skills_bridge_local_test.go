package app

import (
	"strings"
	"testing"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestSyncGitHubSkillDelegatesInLocalMode(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}); err != nil {
		t.Fatal(err)
	}
	svc := &Service{mode: serviceModeLocal, repo: repository.New(db)}
	if _, err := svc.SyncGitHubSkill("user-1", "skill-1"); err == nil || strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local GitHub skill sync error = %v, want delegated skill lookup error", err)
	}
}
