// Package brand contains compatibility boundaries for the qisiTV rename.
package brand

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Getenv gives the new name precedence, including an explicitly empty value.
// Existing launch configurations remain usable during the rename.
func Getenv(name string) string {
	if value, set := os.LookupEnv(name); set {
		return value
	}
	if suffix, ok := strings.CutPrefix(name, "QISITV_"); ok {
		return os.Getenv("BEEFTV_" + suffix)
	}
	return ""
}

// DesktopDataDir uses the new location for new installs. Existing workspaces
// retain their original directory because persisted resource paths may be
// absolute; renaming that directory alone could make existing assets unreadable.
func DesktopDataDir(root string) (string, error) {
	current := filepath.Join(root, "qisiTV")
	for _, candidate := range []string{current, filepath.Join(root, "BeefTV")} {
		info, err := os.Stat(candidate)
		if err == nil {
			if !info.IsDir() {
				return "", fmt.Errorf("application data path is not a directory: %s", candidate)
			}
			return candidate, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
	}
	return current, nil
}
