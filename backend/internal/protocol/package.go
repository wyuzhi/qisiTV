package protocol

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const (
	PluginPackageFormat    = "beeftv.plugin/package-v1"
	PluginPackageExtension = ".beeftv-plugin"
	PluginPackageMaxBytes  = 48 << 20
	PluginManifestMaxBytes = 512 << 10
	pluginPackageMaxFiles  = 256
	pluginPackageMaxEntry  = 16 << 20
)

// PluginPackage is the transport envelope for every uploaded plugin. The
// manifest remains the single capability contract; files are optional runtime
// artifacts addressed by manifest.entry.
type PluginPackage struct {
	Manifest       Manifest
	ManifestRaw    []byte
	Files          map[string][]byte
	RootDir        string
	PackageName    string
	SkillDirs      []string
	ExtensionPaths []string
	SHA256         string
}

// ParsePluginPackage validates the package container and returns its manifest
// and files. Uploaded code is never executed by this function.
func ParsePluginPackage(data []byte) (PluginPackage, error) {
	if len(data) == 0 || len(data) > PluginPackageMaxBytes {
		return PluginPackage{}, fmt.Errorf("plugin package must be between 1 and %d bytes", PluginPackageMaxBytes)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return PluginPackage{}, fmt.Errorf("decode plugin package: %w", err)
	}
	if len(reader.File) == 0 || len(reader.File) > pluginPackageMaxFiles {
		return PluginPackage{}, fmt.Errorf("plugin package must contain between 1 and %d files", pluginPackageMaxFiles)
	}
	files := make(map[string][]byte, len(reader.File))
	var manifestRaw []byte
	for _, file := range reader.File {
		name, err := validatePluginPackagePath(file.Name)
		if err != nil {
			return PluginPackage{}, err
		}
		if _, exists := files[name]; exists {
			return PluginPackage{}, fmt.Errorf("duplicate plugin package file %q", name)
		}
		if file.FileInfo().IsDir() {
			continue
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return PluginPackage{}, fmt.Errorf("plugin package cannot contain symlink %q", name)
		}
		if file.UncompressedSize64 > pluginPackageMaxEntry {
			return PluginPackage{}, fmt.Errorf("plugin package file %q exceeds %d bytes", name, pluginPackageMaxEntry)
		}
		stream, err := file.Open()
		if err != nil {
			return PluginPackage{}, fmt.Errorf("open plugin package file %q: %w", name, err)
		}
		content, readErr := io.ReadAll(io.LimitReader(stream, pluginPackageMaxEntry+1))
		closeErr := stream.Close()
		if readErr != nil {
			return PluginPackage{}, fmt.Errorf("read plugin package file %q: %w", name, readErr)
		}
		if closeErr != nil {
			return PluginPackage{}, fmt.Errorf("close plugin package file %q: %w", name, closeErr)
		}
		if len(content) > pluginPackageMaxEntry {
			return PluginPackage{}, fmt.Errorf("plugin package file %q exceeds %d bytes", name, pluginPackageMaxEntry)
		}
		files[name] = content
		if name == "manifest.json" {
			manifestRaw = content
		}
	}
	if len(manifestRaw) == 0 {
		return PluginPackage{}, fmt.Errorf("plugin package must contain manifest.json")
	}
	if len(manifestRaw) > PluginManifestMaxBytes {
		return PluginPackage{}, fmt.Errorf("manifest.json exceeds %d bytes", PluginManifestMaxBytes)
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return PluginPackage{}, fmt.Errorf("decode plugin manifest: %w", err)
	}
	if err := ValidateManifest(manifest); err != nil {
		return PluginPackage{}, err
	}
	return PluginPackage{Manifest: manifest, ManifestRaw: manifestRaw, Files: files}, nil
}

func validatePluginPackagePath(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsRune(name, '\\') || strings.HasPrefix(name, "/") || path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") || name == ".." {
		return "", fmt.Errorf("invalid plugin package path %q", name)
	}
	if name == "manifest.json" || strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "docs/") || name == "README.md" || name == "LICENSE" {
		return name, nil
	}
	return "", fmt.Errorf("plugin package path %q is outside the allowed package roots", name)
}

func validateManifestPackageExtensions(manifest Manifest) error {
	if strings.TrimSpace(manifest.Client) != "" {
		if err := validateManifestClientPath(manifest.Client); err != nil {
			return err
		}
	}
	seenNodeTypes := make(map[string]struct{}, len(manifest.Contributes.CanvasNodes))
	for index, node := range manifest.Contributes.CanvasNodes {
		nodeType := node.NodeType()
		renderer := strings.TrimSpace(node.Renderer)
		if nodeType != "" {
			if len(nodeType) > 128 || strings.ContainsAny(nodeType, " \t\r\n") {
				return fmt.Errorf("canvas node contribution %d requires a valid id or type", index)
			}
			if _, exists := seenNodeTypes[nodeType]; exists {
				return fmt.Errorf("duplicate canvas node contribution %q", nodeType)
			}
			seenNodeTypes[nodeType] = struct{}{}
		} else if renderer == "client" {
			return fmt.Errorf("canvas node contribution %d requires a valid id or type", index)
		}
		switch renderer {
		case "", "declarative":
		case "client":
			if strings.TrimSpace(manifest.Client) == "" {
				return fmt.Errorf("canvas node %q with client renderer requires manifest.client", nodeType)
			}
		default:
			return fmt.Errorf("canvas node %q has unsupported renderer %q", nodeType, renderer)
		}
	}
	return nil
}

func validateManifestClientPath(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if strings.ContainsRune(trimmed, '\\') || strings.HasPrefix(trimmed, "/") || path.IsAbs(trimmed) {
		return fmt.Errorf("manifest.client %q must be a relative path", raw)
	}
	clean := strings.TrimPrefix(trimmed, "./")
	if clean == "" || path.Clean(clean) != clean || strings.HasPrefix(clean, "../") || clean == ".." || strings.Contains(clean, "..") {
		return fmt.Errorf("manifest.client %q must be a clean relative path without '..'", raw)
	}
	for _, segment := range strings.Split(clean, "/") {
		if segment == "node_modules" {
			return fmt.Errorf("manifest.client %q cannot reference node_modules", raw)
		}
	}
	lower := strings.ToLower(clean)
	if !strings.HasSuffix(lower, ".js") && !strings.HasSuffix(lower, ".mjs") {
		return fmt.Errorf("manifest.client %q must end with .js or .mjs", raw)
	}
	return nil
}

// ParsePluginPackageDir reads an unpacked npm/pi plugin directory containing a
// package.json with a "beeftv" manifest block.
func ParsePluginPackageDir(rootDir string) (PluginPackage, error) {
	trimmedRoot := strings.TrimSpace(rootDir)
	if trimmedRoot == "" {
		return PluginPackage{}, fmt.Errorf("plugin package directory is required")
	}
	absRoot, err := filepath.Abs(filepath.Clean(trimmedRoot))
	if err != nil {
		return PluginPackage{}, fmt.Errorf("resolve plugin package directory: %w", err)
	}
	pkgJSONBytes, err := os.ReadFile(filepath.Join(absRoot, "package.json"))
	if err != nil {
		return PluginPackage{}, fmt.Errorf("read package.json: %w", err)
	}
	var pkgJSON struct {
		Name        string `json:"name"`
		Version     string `json:"version"`
		Description string `json:"description"`
		Author      any    `json:"author"`
		Pi          struct {
			Extensions []string `json:"extensions"`
			Skills     []string `json:"skills"`
		} `json:"pi"`
		BeefTV json.RawMessage `json:"beeftv"`
	}
	if err := json.Unmarshal(pkgJSONBytes, &pkgJSON); err != nil {
		return PluginPackage{}, fmt.Errorf("decode package.json: %w", err)
	}
	// A plain pi package (assistant tools and skills only) has no beeftv field;
	// it installs with an empty BeefTV manifest and its pi resources.
	beeftvRaw := bytes.TrimSpace(pkgJSON.BeefTV)
	if len(beeftvRaw) == 0 || string(beeftvRaw) == "null" {
		beeftvRaw = []byte("{}")
	}
	if beeftvRaw[0] != '{' {
		return PluginPackage{}, fmt.Errorf("package.json beeftv must be an object")
	}
	var manifest Manifest
	if err := json.Unmarshal(beeftvRaw, &manifest); err != nil {
		return PluginPackage{}, fmt.Errorf("decode package.json beeftv manifest: %w", err)
	}
	var beeftvExtra struct {
		DisplayName string `json:"displayName"`
		Author      any    `json:"author"`
	}
	_ = json.Unmarshal(beeftvRaw, &beeftvExtra)

	if strings.TrimSpace(manifest.APIVersion) == "" {
		manifest.APIVersion = "beeftv.plugin/v3"
	}
	if strings.TrimSpace(manifest.Metadata.ID) == "" {
		manifest.Metadata.ID = PackageIDFromName(pkgJSON.Name)
	}
	if strings.TrimSpace(manifest.Metadata.Version) == "" {
		manifest.Metadata.Version = strings.TrimSpace(pkgJSON.Version)
	}
	if strings.TrimSpace(manifest.Metadata.Name) == "" {
		manifest.Metadata.Name = firstNonEmptyText(beeftvExtra.DisplayName, pkgJSON.Name, manifest.Metadata.ID)
	}
	if strings.TrimSpace(manifest.Metadata.Description) == "" {
		manifest.Metadata.Description = strings.TrimSpace(pkgJSON.Description)
	}
	if strings.TrimSpace(manifest.Metadata.Vendor) == "" {
		manifest.Metadata.Vendor = firstNonEmptyText(extractPackageAuthor(beeftvExtra.Author), extractPackageAuthor(pkgJSON.Author))
	}
	if strings.TrimSpace(manifest.Metadata.Documentation) == "" {
		if readmeBytes, err := os.ReadFile(filepath.Join(absRoot, "README.md")); err == nil {
			manifest.Metadata.Documentation = strings.TrimSpace(string(readmeBytes))
		}
	}

	var skillDirs []string
	var relSkills []string
	if len(pkgJSON.Pi.Skills) > 0 {
		for _, rawSkill := range pkgJSON.Pi.Skills {
			absPath, relPath, err := resolvePackageSubpath(absRoot, rawSkill)
			if err != nil {
				return PluginPackage{}, fmt.Errorf("invalid pi.skills path %q: %w", rawSkill, err)
			}
			info, err := os.Stat(absPath)
			if err != nil || !info.IsDir() {
				return PluginPackage{}, fmt.Errorf("pi.skills directory %q does not exist", rawSkill)
			}
			skillDirs = append(skillDirs, absPath)
			relSkills = append(relSkills, relPath)
		}
	} else if info, err := os.Stat(filepath.Join(absRoot, "skills")); err == nil && info.IsDir() {
		skillDirs = append(skillDirs, filepath.Join(absRoot, "skills"))
		relSkills = append(relSkills, "skills")
	}

	var extensionPaths []string
	var relExtensions []string
	if len(pkgJSON.Pi.Extensions) > 0 {
		for _, rawExt := range pkgJSON.Pi.Extensions {
			absPath, relPath, err := resolvePackageSubpath(absRoot, rawExt)
			if err != nil {
				return PluginPackage{}, fmt.Errorf("invalid pi.extensions path %q: %w", rawExt, err)
			}
			if _, err := os.Stat(absPath); err != nil {
				return PluginPackage{}, fmt.Errorf("pi.extensions path %q does not exist", rawExt)
			}
			extensionPaths = append(extensionPaths, absPath)
			relExtensions = append(relExtensions, relPath)
		}
	} else if _, err := os.Stat(filepath.Join(absRoot, "extensions")); err == nil {
		extensionPaths = append(extensionPaths, filepath.Join(absRoot, "extensions"))
		relExtensions = append(relExtensions, "extensions")
	}

	if len(manifest.Contributes.Skills) == 0 && len(relSkills) > 0 {
		manifest.Contributes.Skills = relSkills
	}
	if len(manifest.Contributes.Extensions) == 0 && len(relExtensions) > 0 {
		manifest.Contributes.Extensions = relExtensions
	}
	for index := range manifest.Contributes.CanvasNodes {
		manifest.Contributes.CanvasNodes[index].Normalize()
	}

	if err := ValidateManifest(manifest); err != nil {
		return PluginPackage{}, err
	}
	if strings.TrimSpace(manifest.Client) != "" {
		clientAbs, _, err := resolvePackageSubpath(absRoot, manifest.Client)
		if err != nil {
			return PluginPackage{}, err
		}
		info, err := os.Stat(clientAbs)
		if err != nil || !info.Mode().IsRegular() {
			return PluginPackage{}, fmt.Errorf("manifest.client %q is missing from package directory", manifest.Client)
		}
	}

	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		return PluginPackage{}, fmt.Errorf("encode package manifest: %w", err)
	}
	sum, err := hashPluginPackageDir(absRoot)
	if err != nil {
		return PluginPackage{}, err
	}
	return PluginPackage{
		Manifest:       manifest,
		ManifestRaw:    manifestRaw,
		RootDir:        absRoot,
		PackageName:    strings.TrimSpace(pkgJSON.Name),
		SkillDirs:      skillDirs,
		ExtensionPaths: extensionPaths,
		SHA256:         sum,
	}, nil
}

// PackageIDFromName derives a plugin ID from an npm package name when the
// package does not set beeftv.id: "@scope/name" becomes "scope-name", so two
// scopes publishing the same name never replace each other.
func PackageIDFromName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "@") {
		return strings.Replace(strings.TrimPrefix(trimmed, "@"), "/", "-", 1)
	}
	return trimmed
}

func extractPackageAuthor(raw any) string {
	switch typed := raw.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		if name, ok := typed["name"].(string); ok {
			return strings.TrimSpace(name)
		}
	}
	return ""
}

func resolvePackageSubpath(absRoot string, rel string) (string, string, error) {
	trimmed := strings.TrimSpace(rel)
	if trimmed == "" || strings.ContainsRune(trimmed, '\\') || strings.HasPrefix(trimmed, "/") || path.IsAbs(trimmed) {
		return "", "", fmt.Errorf("path %q must be relative to package root", rel)
	}
	clean := strings.TrimPrefix(trimmed, "./")
	if clean == "" || path.Clean(clean) != clean || strings.HasPrefix(clean, "../") || clean == ".." || strings.Contains(clean, "..") {
		return "", "", fmt.Errorf("path %q escapes package root", rel)
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == "node_modules" || seg == ".git" {
			return "", "", fmt.Errorf("path %q cannot reference %s", rel, seg)
		}
	}
	absTarget := filepath.Join(absRoot, filepath.FromSlash(clean))
	relCheck, err := filepath.Rel(absRoot, absTarget)
	if err != nil || strings.HasPrefix(relCheck, "..") || filepath.IsAbs(relCheck) {
		return "", "", fmt.Errorf("path %q escapes package root", rel)
	}
	return absTarget, clean, nil
}

func hashPluginPackageDir(absRoot string) (string, error) {
	var relPaths []string
	err := filepath.WalkDir(absRoot, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == absRoot {
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			if name == "node_modules" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(absRoot, current)
		if err != nil {
			return err
		}
		relPaths = append(relPaths, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash plugin package directory: %w", err)
	}
	sort.Strings(relPaths)
	hasher := sha256.New()
	for _, rel := range relPaths {
		content, err := os.ReadFile(filepath.Join(absRoot, filepath.FromSlash(rel)))
		if err != nil {
			return "", fmt.Errorf("hash plugin file %q: %w", rel, err)
		}
		_, _ = io.WriteString(hasher, rel)
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(content)
		_, _ = hasher.Write([]byte{0})
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func setMapPath(target map[string]any, path string, value any) {
	parts := strings.Split(strings.Trim(path, "."), ".")
	current := target
	for _, part := range parts[:len(parts)-1] {
		next, ok := current[part].(map[string]any)
		if !ok {
			next = map[string]any{}
			current[part] = next
		}
		current = next
	}
	if len(parts) > 0 {
		current[parts[len(parts)-1]] = value
	}
}

func validManifestIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 96 {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			if index == 0 && (char == '-' || char == '_' || char == '.') {
				return false
			}
			continue
		}
		return false
	}
	return true
}
