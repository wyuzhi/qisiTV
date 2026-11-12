package repository

import (
	"errors"
	"testing"
	"time"

	"qisitv/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestSaveLogicalModelBundleAllocatesMonotonicRevisionSequence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:logical-model-revision-sequence?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.LogicalModel{}, &model.LogicalModelRevision{}, &model.LogicalModelRoute{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)

	item := &model.LogicalModel{ID: "LMODEL_1", Code: "demo", Name: "Demo", Capability: "text", Enabled: true, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	first := &model.LogicalModelRevision{ID: "REVISION_1", LogicalModelID: item.ID, CapabilitySpecJSON: `{"version":1,"capability":"text"}`, DefaultOptionsJSON: `{}`, CreatedAt: time.Now()}
	if err := repo.SaveLogicalModelBundle(item, first, nil, true); err != nil {
		t.Fatal(err)
	}

	var updated model.LogicalModel
	if err := db.First(&updated, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	updated.Name = "Demo 2"
	updated.UpdatedAt = time.Now()
	second := &model.LogicalModelRevision{ID: "REVISION_2", LogicalModelID: item.ID, CapabilitySpecJSON: `{"version":1,"capability":"text"}`, DefaultOptionsJSON: `{}`, CreatedAt: time.Now()}
	if err := repo.SaveLogicalModelBundle(&updated, second, nil, false); err != nil {
		t.Fatal(err)
	}

	var revisions []model.LogicalModelRevision
	if err := db.Order("version asc").Find(&revisions).Error; err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 2 || revisions[0].Version != 1 || revisions[1].Version != 2 {
		t.Fatalf("revision versions = %#v, want [1 2]", revisions)
	}
	if updated.RevisionSequence != 2 || updated.ActiveRevisionID != "REVISION_2" {
		t.Fatalf("updated model state = %#v", updated)
	}
}

func TestCreateTaskRejectsArchivedLogicalModel(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:logical-model-archived-task?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.LogicalModel{}, &model.Task{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	archivedAt := time.Now()
	item := model.LogicalModel{ID: "LMODEL_ARCHIVED_TASK", Code: "archived-task", Name: "Archived Task", Enabled: false, ActiveRevisionID: "REVISION_ARCHIVED_TASK", ArchivedAt: &archivedAt, CreatedAt: archivedAt, UpdatedAt: archivedAt}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	task := &model.Task{ID: "TASK_ARCHIVED_MODEL", UserID: "USER_1", LogicalModelID: item.ID, LogicalModelRevisionID: item.ActiveRevisionID, Status: model.TaskStatusQueued, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.CreateTaskWithActiveLimit(task, 5); !errors.Is(err, ErrLogicalModelUnavailable) {
		t.Fatalf("CreateTaskWithActiveLimit() error = %v, want ErrLogicalModelUnavailable", err)
	}
}
