package projectfolder

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// The fence is written before the SQLite import transaction and retained after
// adoption. A legacy browser must never resume writing just because a failed
// projection left the original version-1 manifest in place.
const MigrationFenceName = ".qisitv/migration-pending.json"

type migrationFence struct {
	WorkspaceID  string `json:"workspaceId"`
	CanvasID     string `json:"canvasId"`
	SourceSHA256 string `json:"sourceSha256"`
}

func ensureMigrationFence(directory *os.Root, expected migrationFence) error {
	raw, err := readBounded(directory, MigrationFenceName, 4096)
	if err == nil {
		var actual migrationFence
		if json.Unmarshal(raw, &actual) != nil || actual != expected {
			return fmt.Errorf("migration reservation belongs to another source or workspace: %w", ErrConflict)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	raw, err = json.Marshal(expected)
	if err != nil {
		return err
	}
	return atomicWrite(directory, MigrationFenceName, raw)
}
