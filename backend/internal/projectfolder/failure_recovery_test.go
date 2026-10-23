package projectfolder

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/model"
)

func TestMigrationFenceSurvivesTransactionRollbackAndCanRetry(t *testing.T) {
	f := setup(t)
	req := f.source(t, "rollback", false)
	if err := f.db.Exec(`CREATE TRIGGER injected_import_failure BEFORE INSERT ON canvas_projects BEGIN SELECT RAISE(ABORT,'injected import failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Import(context.Background(), "owner", req); err == nil {
		t.Fatal("injected transaction failure was ignored")
	}
	if _, err := os.Stat(filepath.Join(f.root, req.Directory, MigrationFenceName)); err != nil {
		t.Fatal("legacy browser was not fenced", err)
	}
	var count int64
	f.db.Model(&model.CanvasProject{}).Count(&count)
	if count != 0 {
		t.Fatal("failed transaction published canonical canvas")
	}
	raw, _ := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
	if digestBytes(raw) != req.ExpectedManifestSHA256 {
		t.Fatal("failure changed original manifest")
	}
	if err := f.db.Exec(`DROP TRIGGER injected_import_failure`).Error; err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Import(context.Background(), "owner", req)
	if err != nil || status.State != "ready" {
		t.Fatal("reserved import cannot resume", status, err)
	}
}

func TestMigrationProjectionFailureBlocksEngineWriterUntilOriginalImportResumes(t *testing.T) {
	f := setup(t)
	req := f.source(t, "disk-failure", false)
	// A directory occupying the receipt filename deterministically makes the
	// final projection fail after SQLite commits, without relying on disk space.
	blocker := filepath.Join(f.root, req.Directory, ".qisitv", "task-receipts-g1.json")
	if err := os.MkdirAll(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Import(context.Background(), "owner", req); err == nil {
		t.Fatal("injected projection failure was ignored")
	}
	var canvas model.CanvasProject
	if err := f.db.First(&canvas, "id=?", "disk-failure").Error; err != nil {
		t.Fatal("test did not reach committed import", err)
	}
	raw, _ := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
	if digestBytes(raw) != req.ExpectedManifestSHA256 {
		t.Fatal("failure changed original manifest")
	}
	if _, err := os.Stat(filepath.Join(f.root, req.Directory, MigrationFenceName)); err != nil {
		t.Fatal("legacy writer fence is absent", err)
	}
	if err := f.service.CheckWritable(context.Background(), "owner"); err == nil {
		t.Fatal("engine allowed writing a half-adopted canvas")
	}
	status, err := f.service.Status(context.Background(), "owner", "disk-failure")
	if err != nil || status.State == "ready" || !status.Pending {
		t.Fatal("failed import was reported durable", status, err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	status, err = f.service.Import(context.Background(), "owner", req)
	if err != nil || status.State != "ready" {
		t.Fatal("same original import did not recover", status, err)
	}
	if err := f.service.CheckWritable(context.Background(), "owner"); err != nil {
		t.Fatal("completed import remains blocked", err)
	}
}

func TestReadyStatusObservesExternalFilesystemFailureWithoutPendingWrites(t *testing.T) {
	for _, kind := range []string{"directory", "manifest", "changed-manifest", "media"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			req := f.source(t, "inventory", false)
			if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
				t.Fatal(err)
			}
			project := filepath.Join(f.root, req.Directory)
			manifest := manifestOnDisk(t, f, req.Directory)
			target := filepath.Join(project, ManifestName)
			if kind == "directory" {
				target = project
			}
			if kind == "media" {
				for _, media := range manifest.Media {
					target = filepath.Join(project, media.Path)
					break
				}
			}
			saved := target + ".test-preserved"
			if err := os.Rename(target, saved); err != nil {
				t.Fatal(err)
			}
			if kind == "changed-manifest" {
				if err := os.WriteFile(target, []byte(`{"external":"preserve me"}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			status, err := f.service.Status(context.Background(), "owner", "inventory")
			if err != nil || status.State == "ready" || status.Error == "" {
				t.Fatal("poll claimed unavailable project was saved", status, err)
			}
			list, err := f.service.List(context.Background(), "owner")
			if err != nil || len(list) != 1 || list[0].State == "ready" {
				t.Fatal("list lost filesystem failure", list, err)
			}
			if err := f.service.CheckWritable(context.Background(), "owner"); err == nil {
				t.Fatal("unavailable project accepted writes")
			}
			if _, err := f.service.Recheck(context.Background(), "owner", "inventory"); err == nil {
				t.Fatal("recheck accepted unrecovered folder")
			}
			if kind == "changed-manifest" {
				if _, err := f.service.Flush(context.Background(), "owner", "inventory"); !errors.Is(err, ErrConflict) {
					t.Fatal("external change not protected", err)
				}
				raw, _ := os.ReadFile(target)
				if string(raw) != `{"external":"preserve me"}` {
					t.Fatal("external changes overwritten")
				}
			}
			if err := os.Rename(saved, target); err != nil {
				t.Fatal(err)
			}
			status, err = f.service.Recheck(context.Background(), "owner", "inventory")
			if err != nil || status.State != "ready" {
				t.Fatal("exact original restoration did not recover", status, err)
			}
		})
	}
}

func TestRecheckRejectsMediaWithSameSizeAndWrongHash(t *testing.T) {
	f := setup(t)
	req := f.source(t, "corrupt-media", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	manifest := manifestOnDisk(t, f, req.Directory)
	for _, media := range manifest.Media {
		target := filepath.Join(f.root, req.Directory, media.Path)
		original, _ := os.ReadFile(target)
		corrupt := append([]byte(nil), original...)
		corrupt[0] ^= 1
		if err := os.WriteFile(target, corrupt, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := f.service.Recheck(context.Background(), "owner", "corrupt-media"); err == nil {
			t.Fatal("same-size corruption was accepted as recovery")
		}
	}
}
