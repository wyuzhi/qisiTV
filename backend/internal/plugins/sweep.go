package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"qisitv/backend/internal/protocol"
)

// blobSweepGrace leaves alone package files written in the last few minutes:
// an install writes its blob before the registry commit that references it.
const blobSweepGrace = 10 * time.Minute

// sweepStartupLeftovers runs from open(), after the registry is committed and
// before the runtime is returned. Every
// release reconciles its official packages, and each changed archive used to
// leave its previous blob behind, so long-lived installs accumulate thousands
// of files no record points at. Once the database owns the registry, the old
// plugin_registry.json is only a stale copy and goes too. Failures are ignored:
// leftovers waste disk but never change what runs.
//
// The service builds one runtime per data directory, and this runs before that
// runtime is handed out, so no install in this process can race it. The
// committed registry is still re-read first, and files written in the last few
// minutes are skipped, in case another process shares the directory.
func (c *Runtime) sweepStartupLeftovers(committed []RegistryRecord) {
	referenced := referencedBlobNames(committed)
	if latest, err := c.persistedRecordsForGC(); err == nil {
		for name := range referencedBlobNames(latest) {
			referenced[name] = struct{}{}
		}
	} else {
		return
	}
	cutoff := time.Now().Add(-blobSweepGrace)
	entries, err := os.ReadDir(c.packageDir)
	if err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !isContentAddressedBlob(name) {
				continue
			}
			if _, keep := referenced[name]; keep {
				continue
			}
			info, err := entry.Info()
			if err != nil || info.ModTime().After(cutoff) {
				continue
			}
			_ = os.Remove(filepath.Join(c.packageDir, name))
		}
	}
	if c.store != nil {
		if _, found, err := c.store.LoadPluginRegistry(); err == nil && found {
			_ = os.Remove(c.registryPath)
		}
	}
}

// isContentAddressedBlob matches the <sha256>.beeftv-plugin names the runtime
// writes, so files a user dropped into the directory are never touched.
func isContentAddressedBlob(name string) bool {
	hash, ok := strings.CutSuffix(name, protocol.PluginPackageExtension)
	if !ok || len(hash) != 64 || filepath.Base(name) != name {
		return false
	}
	for _, r := range hash {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}
