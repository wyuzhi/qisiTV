package projectfolder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

type Service struct {
	db      *gorm.DB
	options Options
	mu      sync.Mutex
}

func (s *Service) Matches(rootDirectory, workspaceID string) bool {
	root, err := filepath.EvalSymlinks(rootDirectory)
	return err == nil && filepath.Clean(root) == s.options.RootDirectory && workspaceID == s.options.WorkspaceID
}

// CheckWritable refuses writes while an adopted folder was externally edited,
// removed or is not accessible. The gateway calls this before mutating APIs;
// projection also checks again immediately before replacing the manifest.
func (s *Service) CheckWritable(ctx context.Context, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var bindings []binding
	if err := s.db.WithContext(ctx).Where("user_id=?", userID).Find(&bindings).Error; err != nil {
		return err
	}
	for _, b := range bindings {
		if b.State == "conflict" {
			return ErrConflict
		}
		if b.SourceSHA256 != "" && b.ExportedGeneration == 0 {
			return fmt.Errorf("project migration has not finished; retry the original import or flush before editing")
		}
		if failure := s.checkFolderFiles(b, false); failure != nil {
			if err := s.recordFolderFailure(ctx, &b, failure); err != nil {
				return err
			}
			return failure
		}
	}
	return nil
}

func Open(db *gorm.DB, options Options) (*Service, error) {
	if !filepath.IsAbs(options.RootDirectory) || !filepath.IsAbs(options.DataDir) || !safeID.MatchString(options.WorkspaceID) {
		return nil, fmt.Errorf("project folders require an explicitly selected absolute root and workspace identity")
	}
	root, err := filepath.EvalSymlinks(options.RootDirectory)
	if err != nil {
		return nil, err
	}
	options.RootDirectory = root
	if err = Install(db); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Join(options.DataDir, "resources"), 0700); err != nil {
		return nil, err
	}
	handle, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	ownerName := ".qisitv-engine-owner.json"
	owner, err := readBounded(handle, ownerName, 4096)
	if errors.Is(err, os.ErrNotExist) {
		owner, _ = json.Marshal(map[string]string{"workspaceId": options.WorkspaceID})
		// Exclusive creation prevents two installations claiming the same root.
		f, createErr := handle.OpenFile(ownerName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if createErr != nil {
			return nil, createErr
		}
		_, err = f.Write(owner)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else {
		var stored struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if json.Unmarshal(owner, &stored) != nil || stored.WorkspaceID != options.WorkspaceID {
			return nil, fmt.Errorf("project root belongs to a different engine workspace")
		}
	}
	return &Service{db: db, options: options}, nil
}

func (s *Service) Status(ctx context.Context, userID, canvasID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b binding
	if err := s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", canvasID, userID).First(&b).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			var row model.CanvasProject
			if lookup := s.db.WithContext(ctx).Where("id=? AND user_id=?", canvasID, userID).First(&row).Error; lookup != nil {
				return Status{}, lookup
			}
			return s.unboundStatus(row), nil
		}
		return Status{}, err
	}
	return s.status(ctx, b)
}
func (s *Service) unboundStatus(row model.CanvasProject) Status {
	return Status{CanvasID: row.ID, WorkspaceID: s.options.WorkspaceID, Directory: "qisitv-" + row.ID, State: "pending", Revision: row.Revision, Pending: true}
}
func (s *Service) status(ctx context.Context, b binding) (Status, error) {
	if failure := s.checkFolderFiles(b, false); failure != nil {
		if err := s.recordFolderFailure(ctx, &b, failure); err != nil {
			return Status{}, err
		}
	}
	result := Status{CanvasID: b.CanvasID, WorkspaceID: b.WorkspaceID, Directory: b.Directory, State: b.State, ExportedRevision: b.ExportedRevision, Error: b.LastError}
	var job projection
	err := s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", b.CanvasID, b.UserID).First(&job).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return result, err
	}
	result.Revision = job.Revision
	result.Pending = job.Generation > b.ExportedGeneration
	if result.Pending && result.State == "ready" {
		result.State = "pending"
	}
	if err = s.db.WithContext(ctx).Model(&receipt{}).Where("canvas_id=? AND user_id=?", b.CanvasID, b.UserID).Count(&result.LegacyReceipts).Error; err != nil {
		return result, err
	}
	return result, nil
}
func (s *Service) List(ctx context.Context, userID string) ([]Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rows []binding
	if err := s.db.WithContext(ctx).Where("user_id=?", userID).Order("canvas_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	result := make([]Status, 0, len(rows))
	for _, b := range rows {
		item, err := s.status(ctx, b)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	var unbound []model.CanvasProject
	if err := s.db.WithContext(ctx).Where("user_id=? AND NOT EXISTS (SELECT 1 FROM qisitv_project_folders f WHERE f.canvas_id=canvas_projects.id)", userID).Find(&unbound).Error; err != nil {
		return nil, err
	}
	for _, row := range unbound {
		result = append(result, s.unboundStatus(row))
	}
	return result, nil
}
func (s *Service) Receipts(ctx context.Context, userID, canvasID string) ([]json.RawMessage, error) {
	if _, err := s.Status(ctx, userID, canvasID); err != nil {
		return nil, err
	}
	var rows []receipt
	if err := s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", canvasID, userID).Order("task_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	result := make([]json.RawMessage, len(rows))
	for i, row := range rows {
		result[i] = json.RawMessage(row.PayloadJSON)
	}
	return result, nil
}

// Run is owned by the engine lifetime, not a website tab. Every failed job stays
// in the durable outbox; no generation or API submission occurs in this worker.
func (s *Service) Run(ctx context.Context) {
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		_ = s.FlushPending(ctx)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}
func (s *Service) FlushPending(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	var failures []error
	if err := s.bindNewCanvases(ctx); err != nil {
		failures = append(failures, err)
	}
	var rows []projection
	if err := s.db.WithContext(ctx).Table("qisitv_project_folder_outbox AS jobs").Select("jobs.*").Joins("JOIN qisitv_project_folders AS folders ON folders.canvas_id=jobs.canvas_id AND folders.user_id=jobs.user_id").Where("jobs.generation>folders.exported_generation AND folders.state!='conflict'").Order("jobs.updated_at").Limit(100).Scan(&rows).Error; err != nil {
		return err
	}
	for _, job := range rows {
		if _, err := s.flush(ctx, job.UserID, job.CanvasID); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (s *Service) Flush(ctx context.Context, userID, canvasID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.bindNewCanvases(ctx, userID, canvasID); err != nil {
		return Status{}, err
	}
	return s.flush(ctx, userID, canvasID)
}

// Recheck clears a conflict only after the user has restored the exact last
// confirmed file (or a witnessed rename). It never chooses a winning edit.
func (s *Service) Recheck(ctx context.Context, userID, canvasID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b binding
	if err := s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", canvasID, userID).First(&b).Error; err != nil {
		return Status{}, err
	}
	if b.WorkspaceID != s.options.WorkspaceID {
		return Status{}, ErrUnbound
	}
	directory, err := openProject(s.options.RootDirectory, b.Directory)
	if err != nil {
		return Status{}, err
	}
	defer directory.Close()
	raw, err := readBounded(directory, ManifestName, MaxManifestBytes)
	if err != nil {
		return Status{}, err
	}
	digest := digestBytes(raw)
	if digest != b.ManifestSHA256 && digest != b.PendingManifestSHA256 {
		return Status{}, ErrConflict
	}
	if err = s.checkFolderFiles(b, true); err != nil {
		if recordErr := s.recordFolderFailure(ctx, &b, err); recordErr != nil {
			return Status{}, recordErr
		}
		return Status{}, err
	}
	if err = s.db.WithContext(ctx).Model(&binding{}).Where("canvas_id=? AND user_id=?", canvasID, userID).Updates(map[string]any{"state": "ready", "last_error": ""}).Error; err != nil {
		return Status{}, err
	}
	return s.flush(ctx, userID, canvasID)
}
func (s *Service) bindNewCanvases(ctx context.Context, ownerCanvas ...string) error {
	var rows []model.CanvasProject
	var failures []error
	query := s.db.WithContext(ctx).Where("NOT EXISTS (SELECT 1 FROM qisitv_project_folders f WHERE f.canvas_id=canvas_projects.id)")
	if len(ownerCanvas) == 2 {
		query = query.Where("user_id=? AND id=?", ownerCanvas[0], ownerCanvas[1])
	}
	if err := query.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.bindNewCanvas(ctx, row); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (s *Service) bindNewCanvas(ctx context.Context, row model.CanvasProject) error {
	if !safeID.MatchString(row.ID) {
		return fmt.Errorf("invalid new canvas identity")
	}
	directory := "qisitv-" + row.ID
	root, err := os.OpenRoot(s.options.RootDirectory)
	if err != nil {
		return err
	}
	err = root.Mkdir(directory, 0700)
	_ = root.Close()
	alreadyExists := errors.Is(err, os.ErrExist)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	project, err := openProject(s.options.RootDirectory, directory)
	if err != nil {
		return err
	}
	_, statErr := project.Stat(ManifestName)
	if alreadyExists {
		contents, openErr := project.Open(".")
		if openErr != nil {
			_ = project.Close()
			return openErr
		}
		names, _ := contents.Readdirnames(1)
		_ = contents.Close()
		if len(names) > 0 {
			_ = project.Close()
			return fmt.Errorf("existing nonempty project directory requires explicit import: %s", directory)
		}
	}
	_ = project.Close()
	if statErr == nil {
		return fmt.Errorf("existing project directory requires explicit import: %s", directory)
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// The canvas may have changed while the directory was created. Read
		// its current revision inside the binding transaction, before later
		// mutations can enqueue through the triggers.
		var current model.CanvasProject
		if lookup := tx.Where("id=? AND user_id=?", row.ID, row.UserID).First(&current).Error; lookup != nil {
			if errors.Is(lookup, gorm.ErrRecordNotFound) {
				return nil
			}
			return lookup
		}
		b := binding{CanvasID: row.ID, UserID: row.UserID, WorkspaceID: s.options.WorkspaceID, Directory: directory, State: "pending"}
		if err := tx.Create(&b).Error; err != nil {
			return err
		}
		return tx.Create(&projection{CanvasID: row.ID, UserID: row.UserID, Revision: current.Revision, Generation: 1, UpdatedAt: time.Now()}).Error
	})
	if err != nil {
		return err
	}
	return nil
}
