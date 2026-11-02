package plugins

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

type EnabledPackageView struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Version    string   `json:"version"`
	PackageDir string   `json:"packageDir"`
	SkillDirs  []string `json:"skillDirs,omitempty"`
	Client     string   `json:"client,omitempty"`
}

type MarketPluginItem struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	PackageName string   `json:"packageName"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Author      string   `json:"author,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`
	Installed   bool     `json:"installed"`
	Enabled     bool     `json:"enabled"`
}

func (s *Service) SetSkillSyncHook(hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool)) {
	if s == nil || s.runtime == nil {
		return
	}
	s.runtime.SetSkillSyncHook(hook)
}

func (c *Runtime) SetSkillSyncHook(hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.skillSyncHook = hook
	current := make(map[string]Record, len(c.plugins))
	for k, v := range c.plugins {
		current[k] = v
	}
	c.mu.Unlock()
	if hook != nil {
		dispatchPluginSkillSync(hook, nil, current)
	}
}

func dispatchPluginSkillSync(
	hook func(pluginID string, pluginName string, version string, skillDirs []string, enabled bool),
	previous map[string]Record,
	current map[string]Record,
) {
	seen := make(map[string]struct{}, len(previous)+len(current))
	ids := make([]string, 0, len(previous)+len(current))
	for id := range previous {
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range current {
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		rec, exists := current[id]
		if !exists {
			prev := previous[id]
			if len(prev.SkillDirs) > 0 || prev.Source == OriginPackage || prev.PackageDir != "" {
				hook(id, prev.Metadata.Name, prev.Metadata.Version, nil, false)
			}
			continue
		}
		if len(rec.SkillDirs) == 0 && rec.Source != OriginPackage && rec.PackageDir == "" {
			continue
		}
		enabled := rec.Status == StatusEnabled && len(rec.SkillDirs) > 0
		hook(id, rec.Metadata.Name, rec.Metadata.Version, rec.SkillDirs, enabled)
	}
}

func syncPluginCanvasCapabilities(plugins map[string]Record) {
	capRegistry := capability.BuiltinRegistry()
	if capRegistry == nil {
		return
	}
	capRegistry.ResetPluginDescriptors()
	ids := make([]string, 0, len(plugins))
	for id := range plugins {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		record := plugins[id]
		if record.Status != StatusEnabled {
			continue
		}
		var manifest protocol.Manifest
		if err := json.Unmarshal(record.Raw, &manifest); err != nil {
			continue
		}
		if len(manifest.Contributes.CanvasNodes) == 0 {
			continue
		}
		descriptors := make([]capability.Descriptor, 0, len(manifest.Contributes.CanvasNodes))
		for _, node := range manifest.Contributes.CanvasNodes {
			w, h := node.NodeDimensions()
			if w <= 0 {
				w = 360
			}
			if h <= 0 {
				h = 260
			}
			patchFields := map[string]capability.PatchField{
				"title": {
					Path: "title", Kind: "string", Label: "节点名称", Order: 10, Description: "节点标题", MaxRunes: 240,
				},
				"content": {
					Path: "metadata.content", Kind: "string", Label: "内容", Order: 20, Description: "节点内容", MaxRunes: 16000,
				},
			}
			for idx, field := range node.Fields {
				fieldName := strings.TrimSpace(field.Name)
				if fieldName == "" || fieldName == "title" || fieldName == "content" {
					continue
				}
				kind := "string"
				switch strings.ToLower(strings.TrimSpace(field.Type)) {
				case "number", "int", "integer", "float":
					kind = "number"
				case "boolean", "bool":
					kind = "boolean"
				}
				label := strings.TrimSpace(field.Label)
				if label == "" {
					label = fieldName
				}
				patchFields[fieldName] = capability.PatchField{
					Path:        "metadata.pluginData." + fieldName,
					Kind:        kind,
					Label:       label,
					Order:       30 + idx,
					Description: strings.TrimSpace(field.Description),
				}
			}
			purpose := strings.TrimSpace(manifest.Metadata.Description)
			if purpose == "" {
				purpose = node.NodeLabel()
			}
			version := strings.TrimSpace(manifest.Metadata.Version)
			if version == "" {
				version = "1"
			}
			descriptors = append(descriptors, capability.Descriptor{
				Type:          node.NodeType(),
				Version:       version,
				Label:         node.NodeLabel(),
				Purpose:       purpose,
				DefaultWidth:  float64(w),
				DefaultHeight: float64(h),
				InputKind:     "text",
				Connection: capability.ConnectionPolicy{
					CanSource:          true,
					CanTarget:          true,
					AcceptedInputKinds: []string{"text", "image", "video", "audio"},
				},
				CanUpdate:     true,
				SummaryFields: []string{"content", "pluginData"},
				DetailFields:  []string{"content", "pluginData"},
				PatchFields:   patchFields,
			})
		}
		_ = capRegistry.SetPluginDescriptors(id, descriptors)
	}
}

func (s *Service) EnabledPackages() []EnabledPackageView {
	if s == nil || s.runtime == nil {
		return []EnabledPackageView{}
	}
	return s.runtime.EnabledPackages()
}

func (c *Runtime) EnabledPackages() []EnabledPackageView {
	if c == nil {
		return []EnabledPackageView{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	items := make([]EnabledPackageView, 0)
	for _, record := range c.plugins {
		if record.Status != StatusEnabled || strings.TrimSpace(record.PackageDir) == "" {
			continue
		}
		var manifest protocol.Manifest
		_ = json.Unmarshal(record.Raw, &manifest)
		items = append(items, EnabledPackageView{
			ID:         record.Metadata.ID,
			Name:       record.Metadata.Name,
			Version:    record.Metadata.Version,
			PackageDir: record.PackageDir,
			SkillDirs:  cloneStringSlice(record.SkillDirs),
			Client:     manifest.Client,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

func (s *Service) InstallPackageFromDir(sourceDir string, sourceSpec string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	view, err := s.runtime.InstallPackageFromDir(sourceDir, sourceSpec)
	if err != nil {
		return View{}, err
	}
	view.Management = ManagementFromView(view)
	return view, nil
}

func (c *Runtime) InstallPackageFromDir(sourceDir string, sourceSpec string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	parsed, err := protocol.ParsePluginPackageDir(sourceDir)
	if err != nil {
		return View{}, err
	}
	id := parsed.Manifest.Metadata.ID
	if IsReservedApplication(id) {
		return View{}, fmt.Errorf("插件 ID %q 由官方应用保留", id)
	}
	c.beginMutation()
	defer c.endMutation()

	c.mu.RLock()
	existing, exists := c.plugins[id]
	c.mu.RUnlock()
	if exists && IsBuiltInSource(existing.Source) {
		return View{}, fmt.Errorf("内置插件 %q 不能通过安装包覆盖", id)
	}

	pluginsRoot := filepath.Join(c.dataDir, "plugins")
	if err := os.MkdirAll(pluginsRoot, 0o755); err != nil {
		return View{}, fmt.Errorf("创建插件目录失败：%w", err)
	}
	targetDir := filepath.Join(pluginsRoot, id)
	cleanSource, _ := filepath.Abs(filepath.Clean(sourceDir))
	cleanTarget, _ := filepath.Abs(filepath.Clean(targetDir))
	if cleanSource != cleanTarget {
		stagingDir, err := os.MkdirTemp(pluginsRoot, ".stage-"+id+"-*")
		if err != nil {
			return View{}, fmt.Errorf("创建插件暂存目录失败：%w", err)
		}
		defer os.RemoveAll(stagingDir)
		if err := copyPackageDirectory(cleanSource, stagingDir); err != nil {
			return View{}, fmt.Errorf("复制插件目录失败：%w", err)
		}
		backupDir := ""
		if _, err := os.Stat(cleanTarget); err == nil {
			backupDir = cleanTarget + ".bak-" + fmt.Sprintf("%d", time.Now().UnixNano())
			if err := os.Rename(cleanTarget, backupDir); err != nil {
				return View{}, fmt.Errorf("备份旧插件目录失败：%w", err)
			}
		}
		if err := os.Rename(stagingDir, cleanTarget); err != nil {
			if backupDir != "" {
				_ = os.Rename(backupDir, cleanTarget)
			}
			return View{}, fmt.Errorf("启用新插件目录失败：%w", err)
		}
		if backupDir != "" {
			_ = os.RemoveAll(backupDir)
		}
	}

	installedPkg, err := protocol.ParsePluginPackageDir(cleanTarget)
	if err != nil {
		return View{}, err
	}
	manifest := installedPkg.Manifest
	manifest.Metadata.Enabled = !exists || existing.Metadata.Enabled
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return View{}, err
	}
	stored, err := c.currentRecords()
	if err != nil {
		return View{}, err
	}
	now := time.Now().UTC()
	spec := strings.TrimSpace(sourceSpec)
	if spec == "" {
		if exists && strings.TrimSpace(existing.PackageSpec) != "" {
			spec = existing.PackageSpec
		} else if installedPkg.PackageName != "" {
			spec = installedPkg.PackageName
		} else {
			spec = cleanSource
		}
	}
	newRecord := RegistryRecord{
		ID:            id,
		Raw:           manifestData,
		Source:        OriginPackage,
		PackageDir:    installedPkg.RootDir,
		PackageSpec:   spec,
		PackageSHA256: installedPkg.SHA256,
		SkillDirs:     installedPkg.SkillDirs,
		LoadError:     "",
		InstalledAt:   now,
		UpdatedAt:     now,
	}
	if exists {
		newRecord.InstalledAt = existing.InstalledAt
		replaced := false
		for index := range stored {
			if stored[index].ID == id {
				stored[index] = newRecord
				replaced = true
				break
			}
		}
		if !replaced {
			stored = append(stored, newRecord)
		}
	} else {
		stored = append(stored, newRecord)
	}
	pluginsMap, registry, err := c.build(stored)
	if err != nil {
		return View{}, err
	}
	view, err := viewFromPlugins(pluginsMap, id)
	if err != nil {
		return View{}, err
	}
	stage := stagedMutation{
		previousLive: c.captureLive(),
		nextDisk:     stored,
		nextPlugins:  pluginsMap,
		nextRegistry: registry,
		view:         view,
	}
	extras := persistExtras{}
	if c.store != nil {
		extras.platform = &model.PluginPlatformState{
			PluginID:  id,
			Available: view.Status == StatusEnabled,
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	if err := c.commitAndPublish(&stage, extras); err != nil {
		c.abortUncommitted(&stage)
		return View{}, err
	}
	return stage.view, nil
}

func (s *Service) InstallPackageFromArchive(data []byte, fileName string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	view, err := s.runtime.InstallPackageFromArchive(data, fileName)
	if err != nil {
		return View{}, err
	}
	view.Management = ManagementFromView(view)
	return view, nil
}

func (c *Runtime) InstallPackageFromArchive(data []byte, fileName string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	if len(data) == 0 || len(data) > protocol.PluginPackageMaxBytes {
		return View{}, fmt.Errorf("插件归档大小必须在 1 到 %d 字节之间", protocol.PluginPackageMaxBytes)
	}
	tmpDir, err := os.MkdirTemp("", "beeftv-plugin-archive-*")
	if err != nil {
		return View{}, err
	}
	defer os.RemoveAll(tmpDir)

	lowerName := strings.ToLower(strings.TrimSpace(fileName))
	if strings.HasSuffix(lowerName, ".zip") || (len(data) >= 4 && string(data[:4]) == "PK\x03\x04") {
		if err := extractZipToDir(data, tmpDir); err != nil {
			return View{}, err
		}
	} else {
		if err := extractTarGzToDir(data, tmpDir); err != nil {
			return View{}, err
		}
	}
	pkgRoot, err := locatePackageJSONRoot(tmpDir)
	if err != nil {
		return View{}, err
	}
	return c.InstallPackageFromDir(pkgRoot, fileName)
}

func (s *Service) InstallPackageFromSource(source string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	view, err := s.runtime.InstallPackageFromSource(source)
	if err != nil {
		return View{}, err
	}
	view.Management = ManagementFromView(view)
	return view, nil
}

func (c *Runtime) InstallPackageFromSource(source string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	source = strings.TrimSpace(source)
	source = strings.TrimPrefix(source, "npm:")
	source = strings.TrimSpace(source)
	if source == "" {
		return View{}, fmt.Errorf("插件来源不能为空")
	}
	candidates := []string{source}
	if officialDir, err := officialPluginPackageDir(); err == nil {
		trimmedRel := strings.TrimPrefix(filepath.ToSlash(source), "plugin-packages/")
		candidates = append(candidates, filepath.Join(officialDir, filepath.FromSlash(trimmedRel)))
		baseSpec := trimmedRel
		if at := strings.LastIndex(baseSpec, "@"); at > 0 {
			baseSpec = baseSpec[:at]
		}
		if slash := strings.LastIndex(baseSpec, "/"); slash >= 0 {
			baseSpec = baseSpec[slash+1:]
		}
		if baseSpec != "" {
			candidates = append(candidates, filepath.Join(officialDir, baseSpec))
		}
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil {
			if info.IsDir() {
				absSource, absErr := filepath.Abs(candidate)
				if absErr == nil {
					candidate = absSource
				}
				return c.InstallPackageFromDir(candidate, source)
			}
			data, err := os.ReadFile(candidate)
			if err != nil {
				return View{}, err
			}
			if strings.HasSuffix(strings.ToLower(candidate), protocol.PluginPackageExtension) {
				return c.Install(data, filepath.Base(candidate))
			}
			view, err := c.InstallPackageFromArchive(data, filepath.Base(candidate))
			if err != nil {
				return View{}, err
			}
			return view, nil
		}
	}
	if strings.HasPrefix(source, "-") || strings.ContainsAny(source, " \t\r\n;|&$`><") {
		return View{}, fmt.Errorf("无效的 npm 插件包标识 %q", source)
	}
	tmpDir, err := os.MkdirTemp("", "beeftv-npm-pack-*")
	if err != nil {
		return View{}, err
	}
	defer os.RemoveAll(tmpDir)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "npm", "pack", source, "--pack-destination", tmpDir)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return View{}, fmt.Errorf("下载 npm 插件包 %q 失败：%s", source, strings.TrimSpace(string(output)))
	}
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return View{}, err
	}
	for _, entry := range entries {
		if !entry.IsDir() && (strings.HasSuffix(entry.Name(), ".tgz") || strings.HasSuffix(entry.Name(), ".tar.gz")) {
			data, err := os.ReadFile(filepath.Join(tmpDir, entry.Name()))
			if err != nil {
				return View{}, err
			}
			return c.InstallPackageFromArchive(data, source)
		}
	}
	return View{}, fmt.Errorf("npm pack 未生成有效的插件归档")
}

func (s *Service) UpdatePackage(id string) (View, error) {
	if s == nil || s.runtime == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	view, err := s.runtime.UpdatePackage(id)
	if err != nil {
		return View{}, err
	}
	view.Management = ManagementFromView(view)
	return view, nil
}

func (c *Runtime) UpdatePackage(id string) (View, error) {
	if c == nil {
		return View{}, fmt.Errorf("插件运行时未初始化")
	}
	c.mu.RLock()
	record, ok := c.plugins[strings.TrimSpace(id)]
	c.mu.RUnlock()
	if !ok {
		return View{}, fmt.Errorf("插件 %q 不存在", id)
	}
	spec := strings.TrimSpace(record.PackageSpec)
	if spec == "" {
		spec = strings.TrimSpace(record.PackageDir)
	}
	if spec == "" {
		return View{}, fmt.Errorf("插件 %q 不支持在线更新", id)
	}
	if IsBuiltInSource(record.Source) && record.PackageDir != "" {
		// Re-parse bundled directory and refresh registry record
		pkg, err := protocol.ParsePluginPackageDir(record.PackageDir)
		if err != nil {
			return View{}, err
		}
		return c.SetEnabled(id, pkg.Manifest.Metadata.Enabled && record.Status == StatusEnabled)
	}
	return c.InstallPackageFromSource(spec)
}

func (c *Runtime) cleanupUninstalledPackageDir(previous map[string]Record, next map[string]Record) {
	if c == nil || strings.TrimSpace(c.dataDir) == "" {
		return
	}
	pluginsRoot, err := filepath.Abs(filepath.Join(c.dataDir, "plugins"))
	if err != nil {
		return
	}
	for id, prev := range previous {
		if _, stillInstalled := next[id]; stillInstalled {
			continue
		}
		if prev.Source != OriginPackage || strings.TrimSpace(prev.PackageDir) == "" {
			continue
		}
		absPkgDir, err := filepath.Abs(prev.PackageDir)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(pluginsRoot, absPkgDir)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			continue
		}
		_ = os.RemoveAll(absPkgDir)
	}
}

func copyPackageDirectory(srcRoot string, dstRoot string) error {
	return filepath.WalkDir(srcRoot, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == srcRoot {
			return nil
		}
		if entry.Name() == ".git" || entry.Name() == "node_modules" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(srcRoot, current)
		if err != nil {
			return err
		}
		target := filepath.Join(dstRoot, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("插件目录不能包含软链接或特殊文件 %q", rel)
		}
		data, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func extractTarGzToDir(data []byte, dstDir string) error {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("解压插件归档失败：%w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var totalBytes int64
	fileCount := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取 tar 归档失败：%w", err)
		}
		if hdr.Typeflag == tar.TypeDir || hdr.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			return fmt.Errorf("插件归档不能包含软链接或特殊文件 %q", hdr.Name)
		}
		fileCount++
		if fileCount > 512 {
			return fmt.Errorf("插件归档文件数超过上限")
		}
		target, err := safeArchiveExtractPath(dstDir, hdr.Name)
		if err != nil {
			return err
		}
		content, err := io.ReadAll(io.LimitReader(tr, (16<<20)+1))
		if err != nil {
			return err
		}
		if len(content) > 16<<20 {
			return fmt.Errorf("插件归档单文件超过 16MB")
		}
		totalBytes += int64(len(content))
		if totalBytes > protocol.PluginPackageMaxBytes {
			return fmt.Errorf("插件归档解压后超过大小上限")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func extractZipToDir(data []byte, dstDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("解压 zip 插件归档失败：%w", err)
	}
	if len(zr.File) > 512 {
		return fmt.Errorf("插件归档文件数超过上限")
	}
	var totalBytes int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 || !f.Mode().IsRegular() {
			return fmt.Errorf("插件归档不能包含软链接或特殊文件 %q", f.Name)
		}
		target, err := safeArchiveExtractPath(dstDir, f.Name)
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		content, readErr := io.ReadAll(io.LimitReader(rc, (16<<20)+1))
		_ = rc.Close()
		if readErr != nil {
			return readErr
		}
		if len(content) > 16<<20 {
			return fmt.Errorf("插件归档单文件超过 16MB")
		}
		totalBytes += int64(len(content))
		if totalBytes > protocol.PluginPackageMaxBytes {
			return fmt.Errorf("插件归档解压后超过大小上限")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func safeArchiveExtractPath(dstDir string, entryName string) (string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(entryName), "\\", "/")
	normalized = strings.TrimPrefix(normalized, "/")
	clean := path.Clean(normalized)
	if clean == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "..") {
		return "", fmt.Errorf("归档文件路径非法 %q", entryName)
	}
	target := filepath.Join(dstDir, filepath.FromSlash(clean))
	rel, err := filepath.Rel(dstDir, target)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("归档文件路径越界 %q", entryName)
	}
	return target, nil
}

func locatePackageJSONRoot(extractDir string) (string, error) {
	if _, err := os.Stat(filepath.Join(extractDir, "package.json")); err == nil {
		return extractDir, nil
	}
	if _, err := os.Stat(filepath.Join(extractDir, "package", "package.json")); err == nil {
		return filepath.Join(extractDir, "package"), nil
	}
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			candidate := filepath.Join(extractDir, entry.Name())
			if _, err := os.Stat(filepath.Join(candidate, "package.json")); err == nil {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf("插件归档中未找到 package.json")
}
