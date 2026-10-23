// Package projectfolder projects the engine's single transactional workspace
// into the user's real project directories. A projection is never a second writer.
package projectfolder

import (
	"fmt"
	"time"

	"gorm.io/gorm"
)

type binding struct {
	CanvasID              string `gorm:"primaryKey;size:80"`
	UserID                string `gorm:"index;size:36"`
	WorkspaceID           string
	Directory             string `gorm:"uniqueIndex"`
	SourceSHA256          string
	ManifestSHA256        string
	ExportedRevision      int64
	ExportedGeneration    int64
	PendingManifestSHA256 string
	PendingGeneration     int64
	PendingRevision       int64
	State                 string
	LastError             string
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

func (binding) TableName() string { return "qisitv_project_folders" }

type projection struct {
	CanvasID   string `gorm:"primaryKey;size:80"`
	UserID     string `gorm:"index;size:36"`
	Revision   int64
	Generation int64
	Deleted    bool
	UpdatedAt  time.Time
}

func (projection) TableName() string { return "qisitv_project_folder_outbox" }

// Browser receipts retain the exact old task identity, but are deliberately not
// runnable worker tasks. Browser inputJson did not contain a complete recipe.
type receipt struct {
	TaskID      string `gorm:"primaryKey;size:160"`
	CanvasID    string `gorm:"index;size:80"`
	UserID      string `gorm:"index;size:36"`
	PayloadJSON string `gorm:"type:text"`
	CreatedAt   time.Time
}

func (receipt) TableName() string { return "qisitv_browser_task_receipts" }

// Install attaches outbox writes to SQLite itself, so manual saves, assistant
// mutations, undo and task delivery all enqueue in their existing transaction.
// It neither creates nor changes the upstream canvas/task schema.
func Install(db *gorm.DB) error {
	if db == nil || db.Dialector.Name() != "sqlite" {
		return fmt.Errorf("project folders require the local SQLite workspace")
	}
	if !db.Migrator().HasTable("canvas_projects") {
		return fmt.Errorf("canvas schema is not initialized")
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.AutoMigrate(&binding{}, &projection{}, &receipt{}); err != nil {
			return err
		}
		for _, event := range []string{"INSERT", "UPDATE", "DELETE"} {
			ref, deleted := "NEW", 0
			if event == "DELETE" {
				ref, deleted = "OLD", 1
			}
			name := "qisitv_project_folder_canvas_" + event
			query := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS %s AFTER %s ON canvas_projects
WHEN EXISTS (SELECT 1 FROM qisitv_project_folders WHERE canvas_id=%s.id AND user_id=%s.user_id)
BEGIN
 INSERT INTO qisitv_project_folder_outbox(canvas_id,user_id,revision,generation,deleted,updated_at)
 VALUES(%s.id,%s.user_id,%s.revision,1,%d,CURRENT_TIMESTAMP)
 ON CONFLICT(canvas_id) DO UPDATE SET revision=excluded.revision,generation=generation+1,deleted=excluded.deleted,updated_at=CURRENT_TIMESTAMP;
END`, name, event, ref, ref, ref, ref, ref, deleted)
			if err := tx.Exec(query).Error; err != nil {
				return err
			}
		}
		for _, event := range []string{"UPDATE", "DELETE"} {
			query := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS qisitv_project_folder_conflict_%s BEFORE %s ON canvas_projects
WHEN EXISTS (SELECT 1 FROM qisitv_project_folders WHERE canvas_id=OLD.id AND user_id=OLD.user_id AND state='conflict')
BEGIN SELECT RAISE(ABORT,'project folder conflict: preserve external changes before editing'); END`, event, event)
			if err := tx.Exec(query).Error; err != nil {
				return err
			}
		}
		for table, column := range map[string]string{"tasks": "project_id", "canvas_drawings": "canvas_id"} {
			if !tx.Migrator().HasTable(table) {
				continue
			}
			for _, event := range []string{"INSERT", "UPDATE", "DELETE"} {
				ref := "NEW"
				if event == "DELETE" {
					ref = "OLD"
				}
				query := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS qisitv_project_folder_%s_%s AFTER %s ON %s
WHEN EXISTS(SELECT 1 FROM qisitv_project_folders WHERE canvas_id=%s.%s AND user_id=%s.user_id)
BEGIN
 INSERT INTO qisitv_project_folder_outbox(canvas_id,user_id,revision,generation,deleted,updated_at)
 SELECT id,user_id,revision,1,0,CURRENT_TIMESTAMP FROM canvas_projects WHERE id=%s.%s AND user_id=%s.user_id
 ON CONFLICT(canvas_id) DO UPDATE SET revision=excluded.revision,generation=generation+1,updated_at=CURRENT_TIMESTAMP;
END`, table, event, event, table, ref, column, ref, ref, column, ref)
				if err := tx.Exec(query).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}
