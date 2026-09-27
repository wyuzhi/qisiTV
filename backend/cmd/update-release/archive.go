package main

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	platformDarwinARM64  = "darwin-arm64"
	platformDarwinAMD64  = "darwin-amd64"
	platformWindowsAMD64 = "windows-amd64"
	macExecutableRel     = "Contents/MacOS/qisiTV"
	windowsExecutable    = "qisiTV.exe"
	pluginDirName        = "plugin-packages"
	pluginSuffix         = ".qisitv-plugin"
)

func cmdPackage(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("package", stderr)
	platform := fs.String("platform", "", "darwin-arm64, darwin-amd64, or windows-amd64")
	input := fs.String("input", "", "qisiTV.app, a directory containing it, or a Windows bin directory with qisiTV.exe")
	output := fs.String("output", "", "output zip path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := packageBundle(*platform, *input, *output); err != nil {
		return err
	}
	sum, size, err := fileSHA256AndSize(*output)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "path=%s\nsha256=%s\nsize=%d\n", *output, sum, size)
	return nil
}

func packageBundle(platform, input, output string) error {
	if err := validatePlatform(platform); err != nil {
		return err
	}
	if strings.TrimSpace(input) == "" {
		return fmt.Errorf("package requires --input")
	}
	if strings.TrimSpace(output) == "" {
		return fmt.Errorf("package requires --output")
	}
	root, err := resolveBundleRoot(platform, input)
	if err != nil {
		return err
	}
	if err := rejectUserDataDir(root); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(output), ".qisitv-update-*.zip")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	zw := zip.NewWriter(tmp)
	visited := map[string]struct{}{}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		if err := addTree(zw, root, root, filepath.Base(root), visited); err != nil {
			_ = zw.Close()
			return err
		}
	case platformWindowsAMD64:
		if err := addWindowsLayout(zw, root, visited); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, output); err != nil {
		return err
	}
	return validateArchive(platform, output)
}

func resolveBundleRoot(platform, input string) (string, error) {
	abs, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", fmt.Errorf("package input: %w", err)
	}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("package input must be a real directory, not a symlink")
		}
		if info.IsDir() && filepath.Base(abs) == "qisiTV.app" {
			return abs, nil
		}
		candidate := filepath.Join(abs, "qisiTV.app")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate, nil
		}
		return "", fmt.Errorf("macOS package input must be qisiTV.app or a directory containing qisiTV.app")
	case platformWindowsAMD64:
		if info.Mode().IsRegular() && strings.EqualFold(filepath.Base(abs), windowsExecutable) {
			return filepath.Dir(abs), nil
		}
		if info.IsDir() {
			exe := filepath.Join(abs, windowsExecutable)
			if st, err := os.Stat(exe); err == nil && st.Mode().IsRegular() {
				return abs, nil
			}
		}
		return "", fmt.Errorf("Windows package input must contain qisiTV.exe")
	default:
		return "", fmt.Errorf("unsupported platform %q", platform)
	}
}

func addWindowsLayout(zw *zip.Writer, root string, visited map[string]struct{}) error {
	exe := filepath.Join(root, windowsExecutable)
	if err := addTree(zw, root, exe, windowsExecutable, visited); err != nil {
		return err
	}
	pluginDir := filepath.Join(root, pluginDirName)
	st, err := os.Stat(pluginDir)
	if err != nil {
		return fmt.Errorf("Windows bundle missing %s: %w", pluginDirName, err)
	}
	if !st.IsDir() {
		return fmt.Errorf("Windows bundle %s is not a directory", pluginDirName)
	}
	return addTree(zw, root, pluginDir, pluginDirName, visited)
}

func addTree(zw *zip.Writer, bundleParent, absPath, zipName string, visited map[string]struct{}) error {
	absPath = filepath.Clean(absPath)
	resolved, info, err := lstatDeref(bundleParent, absPath)
	if err != nil {
		return err
	}
	if isExcludedName(absPath) {
		return nil
	}
	zipName = path.Clean(filepath.ToSlash(zipName))
	if err := rejectUnsafeZipName(zipName); err != nil {
		return err
	}

	if info.IsDir() {
		if _, seen := visited[resolved]; seen {
			return nil
		}
		visited[resolved] = struct{}{}
		if !strings.HasSuffix(zipName, "/") {
			if err := addDirectoryEntry(zw, zipName, info.Mode()); err != nil {
				return err
			}
		}
		entries, err := os.ReadDir(resolved)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childAbs := filepath.Join(absPath, entry.Name())
			childZip := path.Join(zipName, entry.Name())
			if err := addTree(zw, bundleParent, childAbs, childZip, visited); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported file type for %s", absPath)
	}
	return addRegularFile(zw, resolved, zipName, info.Mode())
}

func lstatDeref(jailRoot, absPath string) (string, os.FileInfo, error) {
	info, err := os.Lstat(absPath)
	if err != nil {
		return "", nil, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		resolved, err := filepath.Abs(absPath)
		if err != nil {
			return "", nil, err
		}
		return resolved, info, nil
	}
	target, err := os.Readlink(absPath)
	if err != nil {
		return "", nil, err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(absPath), target)
	}
	target = filepath.Clean(target)
	if err := withinRoot(filepath.Clean(jailRoot), target); err != nil {
		return "", nil, fmt.Errorf("refusing symlink %s: %w", absPath, err)
	}
	info, err = os.Stat(absPath)
	if err != nil {
		return "", nil, fmt.Errorf("dereference symlink %s: %w", absPath, err)
	}
	resolved, err := filepath.Abs(target)
	if err != nil {
		return "", nil, err
	}
	return resolved, info, nil
}

func addDirectoryEntry(zw *zip.Writer, name string, mode os.FileMode) error {
	if !strings.HasSuffix(name, "/") {
		name += "/"
	}
	header := &zip.FileHeader{
		Name:   name,
		Method: zip.Store,
	}
	header.SetMode(mode | os.ModeDir)
	_, err := zw.CreateHeader(header)
	return err
}

func addRegularFile(zw *zip.Writer, absPath, zipName string, mode os.FileMode) error {
	file, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer file.Close()
	header := &zip.FileHeader{
		Name:   zipName,
		Method: zip.Deflate,
	}
	header.SetMode(mode &^ os.ModeSymlink)
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(writer, file)
	return err
}

func validateArchive(platform, zipPath string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open packaged zip: %w", err)
	}
	defer reader.Close()
	if len(reader.File) == 0 {
		return fmt.Errorf("packaged zip is empty")
	}
	hasMacExec := false
	hasWinExec := false
	pluginCount := 0
	for _, file := range reader.File {
		name := filepath.ToSlash(file.Name)
		if err := rejectUnsafeZipName(strings.TrimSuffix(name, "/")); err != nil {
			return err
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("zip entry %s is a symlink; updater archives must materialize file contents", name)
		}
		base := path.Base(strings.TrimSuffix(name, "/"))
		if isExcludedName(base) {
			return fmt.Errorf("zip entry %s looks like secret or user data and cannot ship in an updater archive", name)
		}
		if strings.Contains(name, "open_ai_canvas.db") {
			return fmt.Errorf("zip entry %s is user database data and cannot ship in an updater archive", name)
		}
		switch {
		case name == "qisiTV.app/"+macExecutableRel || name == "qisiTV.app/"+macExecutableRel+"/":
			hasMacExec = true
			if file.Mode()&0o111 == 0 {
				return fmt.Errorf("qisiTV.app/%s must retain executable mode", macExecutableRel)
			}
		case name == windowsExecutable:
			hasWinExec = true
		case strings.HasPrefix(name, pluginDirName+"/") && strings.HasSuffix(name, pluginSuffix) && file.Mode().IsRegular():
			pluginCount++
		case strings.HasPrefix(name, "qisiTV.app/Contents/Resources/"+pluginDirName+"/") && strings.HasSuffix(name, pluginSuffix) && file.Mode().IsRegular():
			pluginCount++
		}
	}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		if hasWinExec {
			return fmt.Errorf("macOS archive must not contain %s", windowsExecutable)
		}
		if !hasMacExec {
			return fmt.Errorf("macOS archive must contain qisiTV.app/%s", macExecutableRel)
		}
		if pluginCount == 0 {
			return fmt.Errorf("macOS archive must contain Contents/Resources/%s/*%s", pluginDirName, pluginSuffix)
		}
	case platformWindowsAMD64:
		if hasMacExec {
			return fmt.Errorf("Windows archive must not contain qisiTV.app")
		}
		if !hasWinExec {
			return fmt.Errorf("Windows archive must contain %s at the zip root", windowsExecutable)
		}
		if pluginCount == 0 {
			return fmt.Errorf("Windows archive must contain %s/*%s", pluginDirName, pluginSuffix)
		}
	}
	return nil
}

func rejectUnsafeZipName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || name == "." {
		return fmt.Errorf("zip entry name is empty")
	}
	if strings.Contains(name, "\\") {
		return fmt.Errorf("zip entry %q uses backslashes", name)
	}
	if path.IsAbs(name) || strings.HasPrefix(name, "/") {
		return fmt.Errorf("zip entry %q is absolute", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return fmt.Errorf("zip entry %q contains ..", name)
		}
	}
	return nil
}

func rejectUserDataDir(root string) error {
	markers := []string{"open_ai_canvas.db", ".settings-key", "local-model-config.json"}
	for _, marker := range markers {
		if _, err := os.Stat(filepath.Join(root, marker)); err == nil {
			return fmt.Errorf("refusing to package user data directory %s", root)
		}
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	slash := filepath.ToSlash(abs)
	if (strings.Contains(slash, "/Application Support/qisiTV") && !strings.Contains(slash, "qisiTV.app")) || (strings.Contains(slash, "/Application Support/BeefTV") && !strings.Contains(slash, "BeefTV.app")) {
		return fmt.Errorf("refusing to package the macOS user data directory")
	}
	if runtime.GOOS == "windows" && (strings.Contains(strings.ToLower(slash), "/appdata/roaming/qisitv") || strings.Contains(strings.ToLower(slash), "/appdata/roaming/beeftv")) {
		return fmt.Errorf("refusing to package the Windows user data directory")
	}
	return nil
}

func withinRoot(root, candidate string) error {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("path escapes package root")
	}
	return nil
}

func isExcludedName(pathName string) bool {
	base := filepath.Base(pathName)
	switch {
	case base == ".env" || strings.HasPrefix(base, ".env."):
		return true
	case base == ".settings-key" || base == "beefapi-connection.json":
		return true
	case base == ".DS_Store" || base == "Thumbs.db" || strings.HasPrefix(base, "._"):
		return true
	case base == ".git":
		return true
	case strings.HasSuffix(base, ".db") || strings.HasSuffix(base, ".sqlite") || strings.HasSuffix(base, ".sqlite3"):
		return true
	case strings.HasSuffix(base, ".db-wal") || strings.HasSuffix(base, ".db-shm"):
		return true
	default:
		return false
	}
}

func validatePlatform(platform string) error {
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64, platformWindowsAMD64:
		return nil
	case "":
		return fmt.Errorf("platform is required")
	default:
		return fmt.Errorf("unsupported platform %q (want darwin-arm64, darwin-amd64, or windows-amd64)", platform)
	}
}

func fileSHA256AndSize(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if info.Size() <= 0 {
		return "", 0, fmt.Errorf("%s is empty", path)
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", 0, err
	}
	return fmt.Sprintf("%x", sum.Sum(nil)), info.Size(), nil
}

func artifactFileName(version, platform string) string {
	return fmt.Sprintf("qisiTV-%s-%s.zip", version, platform)
}
