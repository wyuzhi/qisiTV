package projectfolder

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/model"
)

func TestDeletedProjectFolderOnlyBlocksWritesUntilDeletionIsDurable(t *testing.T) {
	for _, flushed := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending deletion", true: "durable deletion"}[flushed], func(t *testing.T) {
			f := setup(t)
			req := f.source(t, "deleted-project", false)
			if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
				t.Fatal(err)
			}
			if err := f.db.Where("id=? AND user_id=?", "deleted-project", "owner").Delete(&model.CanvasProject{}).Error; err != nil {
				t.Fatal(err)
			}
			if flushed {
				if _, err := f.service.Flush(context.Background(), "owner", "deleted-project"); err != nil {
					t.Fatal(err)
				}
				if manifestOnDisk(t, f, req.Directory).DeletedAt == "" {
					t.Fatal("deletion was not written to disk")
				}
			}
			if err := os.Rename(filepath.Join(f.root, req.Directory), filepath.Join(f.root, "archived-project")); err != nil {
				t.Fatal(err)
			}
			err := f.service.CheckWritable(context.Background(), "owner")
			if flushed && err != nil {
				t.Fatalf("archiving an already deleted project blocked the workspace: %v", err)
			}
			if !flushed && err == nil {
				t.Fatal("unpersisted deletion did not protect the workspace")
			}
		})
	}
}
