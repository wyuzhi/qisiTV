package skills

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"

	"gorm.io/gorm"
)

const (
	maxSkillPackageBytes       = 20 << 20
	maxSkillFileBytes          = 8 << 20
	maxSkillPackageFiles       = 512
	maxSkillPreviewBytes       = 512 << 10
	SkillPackageUploadMaxBytes = maxSkillPackageBytes + (1 << 20)
)

type SkillInstallRequest struct {
	Name        string
	Description string
	Tag         string
	IsPrivate   bool
}

type SkillGitHubInstallRequest struct {
	URL        string `json:"url"`
	Ref        string `json:"ref"`
	Subdir     string `json:"subdir"`
	Tag        string `json:"tag"`
	IsPrivate  bool   `json:"isPrivate"`
	AutoUpdate bool   `json:"autoUpdate"`
}

type SkillPackageFileItem struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type SkillPackageFileContent struct {
	File    SkillPackageFileItem `json:"file"`
	Content string               `json:"content"`
	Binary  bool                 `json:"binary"`
}

type SkillPackageBundleFile struct {
	Path          string `json:"path"`
	MimeType      string `json:"mimeType"`
	ContentBase64 string `json:"contentBase64"`
}

type SkillPackageBundle struct {
	SkillID       string                   `json:"skillId"`
	Name          string                   `json:"name"`
	Description   string                   `json:"description"`
	VersionID     string                   `json:"versionId"`
	Version       string                   `json:"version"`
	ContentHash   string                   `json:"contentHash"`
	Files         []SkillPackageBundleFile `json:"files"`
	MarketRelease *skillhub.Release        `json:"marketRelease,omitempty"`
}

type SkillFileSearchResult struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Snippet string `json:"snippet"`
}

type skillPackageArchive struct {
	Files       map[string][]byte
	Metadata    skillPackageMetadata
	ContentHash string
	TotalBytes  int64
}

type githubSkillSpec struct {
	Owner  string
	Repo   string
	Ref    string
	Subdir string
}

func (s *Service) EnsureSkillPackages() error {
	skills, err := s.repo.SkillsForPackageEnsure(skillSourceUser)
	if err != nil {
		return err
	}
	builtinFiles, err := builtinSkillAuxiliaryFiles()
	if err != nil {
		return err
	}
	for index := range skills {
		skill := &skills[index]
		var extraFiles map[string][]byte
		if skill.Source != skillSourceUser {
			extraFiles = builtinFiles[skill.ID]
		}
		archive, err := archiveFromMarkdownWithFiles([]byte(skill.Instruction), skill.Name, skill.Description, extraFiles)
		if err != nil {
			return fmt.Errorf("迁移技能 %s 文件包失败: %w", skill.ID, err)
		}
		if skill.CurrentVersionID != "" && skill.ContentHash == archive.ContentHash {
			continue
		}
		sourceType := "builtin"
		if skill.Source == skillSourceUser {
			sourceType = "markdown"
		}
		if err := s.addSkillArchiveVersion(skill, archive, sourceType, "", "", "", "", false); err != nil {
			return fmt.Errorf("保存技能 %s 文件包失败: %w", skill.ID, err)
		}
	}
	if err := s.ensureDefaultAddedBuiltinSkills(); err != nil {
		return err
	}
	return s.ensureSkillDisplayNames()
}

func (s *Service) ensureDefaultAddedBuiltinSkills() error {
	defaultAddedIDs, err := builtinDefaultAddedSkillIDs()
	if err != nil || len(defaultAddedIDs) == 0 {
		return err
	}
	seededSkills := make([]*model.Skill, 0, len(defaultAddedIDs))
	for _, skillID := range defaultAddedIDs {
		skill, err := s.repo.Skill(skillID)
		if err != nil || skill == nil || skill.CurrentVersionID == "" {
			continue
		}
		seededSkills = append(seededSkills, skill)
	}
	if len(seededSkills) == 0 {
		return nil
	}
	ws, err := s.repo.DefaultWorkspace()
	if err != nil || ws == nil || strings.TrimSpace(ws.ID) == "" {
		return nil
	}
	userID := strings.TrimSpace(ws.ID)
	for _, skill := range seededSkills {
		state, err := s.repo.UserSkillState(userID, skill.ID)
		if err != nil {
			return err
		}
		if state == nil {
			added := true
			if existingMarket, mErr := s.repo.MarketSkill(userID, skill.ID); mErr == nil && existingMarket != nil {
				added = false
			}
			state = &model.UserSkillState{
				ID:                 kernel.NewID(),
				UserID:             userID,
				SkillID:            skill.ID,
				Added:              added,
				InstalledVersionID: skill.CurrentVersionID,
				AutoUpdate:         false,
			}
			if err := s.repo.SetUserSkillAdded(state); err != nil {
				return err
			}
			continue
		}
		if state.InstalledVersionID != skill.CurrentVersionID {
			state.InstalledVersionID = skill.CurrentVersionID
			if err := s.repo.SetUserSkillAdded(state); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) InstallSkillUpload(userID string, sourceType string, header *multipart.FileHeader, req SkillInstallRequest) (*SkillItem, error) {
	sourceType = strings.ToLower(strings.TrimSpace(sourceType))
	if sourceType == "" && header != nil {
		switch strings.ToLower(path.Ext(header.Filename)) {
		case ".md", ".markdown":
			sourceType = "markdown"
		case ".zip":
			sourceType = "zip"
		}
	}
	if sourceType != "markdown" && sourceType != "zip" {
		return nil, kernel.BadAuthRequest("技能文件仅支持 Markdown 或 ZIP")
	}
	if header == nil || header.Size <= 0 || header.Size > maxSkillPackageBytes {
		return nil, kernel.BadAuthRequest("技能文件大小必须在 1B-20MB 之间")
	}
	file, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSkillPackageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSkillPackageBytes {
		return nil, kernel.BadAuthRequest("技能文件不能超过 20MB")
	}
	var archive skillPackageArchive
	if sourceType == "markdown" {
		archive, err = archiveFromMarkdown(data, req.Name, req.Description)
	} else {
		archive, err = archiveFromZip(data, "")
	}
	if err != nil {
		return nil, err
	}
	return s.createSkillFromArchive(userID, archive, req, sourceType, "", "", "", "", false)
}

func (s *Service) InstallGitHubSkill(userID string, req SkillGitHubInstallRequest) (*SkillItem, error) {
	spec, err := parseGitHubSkillURL(req.URL, req.Ref, req.Subdir)
	if err != nil {
		return nil, err
	}
	archive, commit, canonicalURL, resolvedRef, err := fetchGitHubSkillArchive(context.Background(), spec)
	if err != nil {
		var appErr *kernel.AppError
		if errors.As(err, &appErr) {
			return nil, err
		}
		return nil, kernel.WrapAppError(http.StatusBadGateway, "GitHub 技能读取失败，请检查仓库地址和网络", err)
	}
	return s.createSkillFromArchive(userID, archive, SkillInstallRequest{Tag: req.Tag, IsPrivate: req.IsPrivate}, "github", canonicalURL, resolvedRef, spec.Subdir, commit, req.AutoUpdate)
}

func (s *Service) SyncGitHubSkill(userID string, skillID string) (*SkillItem, error) {
	skill, err := s.ownedSkill(userID, skillID)
	if err != nil {
		return nil, err
	}
	if skill.SourceType != "github" {
		return nil, kernel.BadAuthRequest("只有 GitHub 技能可以同步")
	}
	if err := s.syncGitHubSkill(skill); err != nil {
		var appErr *kernel.AppError
		if errors.As(err, &appErr) {
			return nil, err
		}
		return nil, kernel.WrapAppError(http.StatusBadGateway, "GitHub 技能同步失败，请稍后重试", err)
	}
	return s.SkillDetail(userID, skill.ID)
}

func (s *Service) StartSyncWorker(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				skills, err := s.repo.AutoUpdatingGitHubSkills()
				if err != nil {
					continue
				}
				for index := range skills {
					_ = s.syncGitHubSkillWithContext(ctx, &skills[index])
				}
			}
		}
	})
}

func (s *Service) syncGitHubSkill(skill *model.Skill) error {
	return s.syncGitHubSkillWithContext(context.Background(), skill)
}

func (s *Service) syncGitHubSkillWithContext(ctx context.Context, skill *model.Skill) error {
	now := time.Now()
	spec, err := parseGitHubSkillURL(skill.SourceURL, skill.SourceRef, skill.SourceSubdir)
	if err != nil {
		skill.SyncStatus = "failed"
		skill.SyncError = err.Error()
		skill.LastCheckedAt = &now
		_ = s.repo.SaveSkill(skill)
		return err
	}
	archive, commit, canonicalURL, resolvedRef, err := fetchGitHubSkillArchive(ctx, spec)
	skill.LastCheckedAt = &now
	if err != nil {
		skill.SyncStatus = "failed"
		skill.SyncError = err.Error()
		_ = s.repo.SaveSkill(skill)
		return err
	}
	if commit == skill.SourceCommit {
		skill.SyncStatus = "synced"
		skill.SyncError = ""
		return s.repo.SaveSkill(skill)
	}
	skill.Name = archive.Metadata.Name
	skill.Description = archive.Metadata.Description
	skill.Instruction = string(archive.Files["SKILL.md"])
	if err := s.addSkillArchiveVersion(skill, archive, "github", canonicalURL, resolvedRef, spec.Subdir, commit, skill.AutoUpdate); err != nil {
		skill.SyncStatus = "failed"
		skill.SyncError = err.Error()
		_ = s.repo.SaveSkill(skill)
		return err
	}
	return nil
}

func (s *Service) createSingleMarkdownSkill(userID string, req SkillMutationRequest) (*SkillItem, error) {
	archive, err := archiveFromMarkdown([]byte(req.Instruction), req.SkillName, req.Description)
	if err != nil {
		return nil, err
	}
	return s.createSkillFromArchive(userID, archive, SkillInstallRequest{Name: req.SkillName, Description: req.Description, Tag: req.Tag, IsPrivate: req.IsPrivate}, "markdown", req.MarkdownURL, "", "", "", false)
}

func (s *Service) updateSingleMarkdownSkill(skill *model.Skill, req SkillMutationRequest) error {
	if strings.TrimSpace(req.Instruction) == "" {
		return s.repo.SaveSkill(skill)
	}
	archive, err := archiveFromMarkdown([]byte(req.Instruction), req.SkillName, req.Description)
	if err != nil {
		return err
	}
	// Editing a private fork keeps its references and license alongside SKILL.md.
	if skill.CurrentVersionID != "" {
		bundle, e := s.SkillPackageBundle(skill.OwnerID, skill.ID)
		if e != nil {
			return e
		}
		for _, f := range bundle.Files {
			if f.Path == "SKILL.md" {
				continue
			}
			b, e := base64.StdEncoding.DecodeString(f.ContentBase64)
			if e != nil {
				return e
			}
			archive.Files[f.Path] = b
		}
		archive.Metadata.MarketRelease = bundle.MarketRelease
		archive, err = finalizeSkillArchive(archive.Files, archive.Metadata)
		if err != nil {
			return err
		}
	}
	skill.Instruction = req.Instruction
	return s.addSkillArchiveVersion(skill, archive, "markdown", req.MarkdownURL, "", "", "", false)
}

func (s *Service) createSkillFromArchive(userID string, archive skillPackageArchive, req SkillInstallRequest, sourceType string, sourceURL string, sourceRef string, sourceSubdir string, sourceCommit string, autoUpdate bool) (*SkillItem, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = archive.Metadata.Name
	}
	description := strings.TrimSpace(req.Description)
	if description == "" {
		description = archive.Metadata.Description
	}
	if utf8.RuneCountInString(name) == 0 || utf8.RuneCountInString(name) > maxSkillNameRunes {
		return nil, kernel.BadAuthRequest("技能名称必须为 1-80 个字符")
	}
	if utf8.RuneCountInString(description) == 0 || utf8.RuneCountInString(description) > maxSkillDescriptionRunes {
		return nil, kernel.BadAuthRequest("技能简介必须为 1-500 个字符")
	}
	tag := strings.TrimSpace(req.Tag)
	if _, ok := skillCategoryLabels[tag]; !ok {
		tag = "others"
	}
	skillID := kernel.NewID()
	versionID := kernel.NewID()
	packageKey, version, files, err := s.persistSkillArchive(skillID, versionID, archive, sourceCommit)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	versionLabel := archive.Metadata.Version
	if versionLabel == "" {
		versionLabel = "1"
		if sourceCommit != "" {
			versionLabel = shortCommit(sourceCommit)
		}
	}
	version.VersionLabel = versionLabel
	skill := &model.Skill{
		ID: skillID, OwnerID: userID, Name: name, Description: description, Instruction: string(archive.Files["SKILL.md"]),
		CurrentVersionID: versionID, VersionLabel: versionLabel, ContentHash: archive.ContentHash, FileCount: len(archive.Files), TotalBytes: archive.TotalBytes,
		SourceType: sourceType, SourceURL: sourceURL, SourceRef: sourceRef, SourceSubdir: sourceSubdir, SourceCommit: sourceCommit,
		SyncStatus: "synced", AutoUpdate: autoUpdate, LastCheckedAt: &now, LastSyncedAt: &now,
		Status: skillStatusEnabled, Source: skillSourceUser, Tag: tag, IsPrivate: req.IsPrivate, MarkdownURL: sourceURL, ShowcaseMediaJSON: "[]",
	}
	state := &model.UserSkillState{ID: kernel.NewID(), UserID: userID, SkillID: skillID, Added: true, InstalledVersionID: versionID, AutoUpdate: autoUpdate}
	if err := s.repo.CreateSkillWithPackage(skill, version, files, state); err != nil {
		_ = os.Remove(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(packageKey)))
		return nil, err
	}
	return s.SkillDetail(userID, skillID)
}

func (s *Service) addSkillArchiveVersion(skill *model.Skill, archive skillPackageArchive, sourceType string, sourceURL string, sourceRef string, sourceSubdir string, sourceCommit string, autoUpdate bool) error {
	versionID := kernel.NewID()
	packageKey, version, files, err := s.persistSkillArchive(skill.ID, versionID, archive, sourceCommit)
	if err != nil {
		return err
	}
	versionLabel := archive.Metadata.Version
	if versionLabel == "" {
		versionLabel = "1"
		if sourceCommit != "" {
			versionLabel = shortCommit(sourceCommit)
		} else if skill.CurrentVersionID != "" {
			versionLabel = time.Now().UTC().Format("20060102-150405")
		}
	}
	version.VersionLabel = versionLabel
	now := time.Now()
	skill.CurrentVersionID = versionID
	skill.VersionLabel = versionLabel
	skill.ContentHash = archive.ContentHash
	skill.FileCount = len(archive.Files)
	skill.TotalBytes = archive.TotalBytes
	skill.SourceType = sourceType
	skill.SourceURL = sourceURL
	skill.SourceRef = sourceRef
	skill.SourceSubdir = sourceSubdir
	skill.SourceCommit = sourceCommit
	skill.SyncStatus = "synced"
	skill.SyncError = ""
	skill.AutoUpdate = autoUpdate
	skill.LastCheckedAt = &now
	skill.LastSyncedAt = &now
	var saveErr error
	if sourceType == "market" {
		saveErr = s.repo.AddMarketSkillVersion(skill, version, files)
	} else {
		saveErr = s.repo.AddSkillVersion(skill, version, files)
	}
	if err := saveErr; err != nil {
		_ = os.Remove(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(packageKey)))
		return err
	}
	return nil
}

func (s *Service) persistSkillArchive(skillID string, versionID string, archive skillPackageArchive, sourceCommit string) (string, *model.SkillVersion, []model.SkillFile, error) {
	marketReleaseJSON := ""
	if archive.Metadata.MarketRelease != nil {
		data, err := json.Marshal(archive.Metadata.MarketRelease)
		if err != nil {
			return "", nil, nil, err
		}
		marketReleaseJSON = string(data)
	}
	packageKey := path.Join(skillID, versionID+".zip")
	absolute := filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(packageKey))
	if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
		return "", nil, nil, err
	}
	data, err := encodeSkillArchive(archive.Files)
	if err != nil {
		return "", nil, nil, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(absolute), ".skill-*.zip")
	if err != nil {
		return "", nil, nil, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", nil, nil, err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return "", nil, nil, err
	}
	if err := temporary.Close(); err != nil {
		return "", nil, nil, err
	}
	if err := os.Rename(temporaryPath, absolute); err != nil {
		return "", nil, nil, err
	}
	version := &model.SkillVersion{ID: versionID, SkillID: skillID, ContentHash: archive.ContentHash, EntryPath: "SKILL.md", PackageKey: packageKey, FileCount: len(archive.Files), TotalBytes: archive.TotalBytes, SourceCommit: sourceCommit, MarketReleaseJSON: marketReleaseJSON}
	paths := sortedSkillPaths(archive.Files)
	files := make([]model.SkillFile, 0, len(paths))
	for _, filePath := range paths {
		content := archive.Files[filePath]
		digest := sha256.Sum256(content)
		files = append(files, model.SkillFile{ID: kernel.NewID(), SkillVersionID: versionID, Path: filePath, Kind: skillFileKind(filePath), MimeType: skillFileMime(filePath, content), Size: int64(len(content)), SHA256: hex.EncodeToString(digest[:])})
	}
	return packageKey, version, files, nil
}

func (s *Service) SkillPackageFiles(userID string, skillID string) ([]SkillPackageFileItem, error) {
	skill, err := s.visibleSkill(userID, skillID)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.SkillFiles(skill.CurrentVersionID)
	if err != nil {
		return nil, err
	}
	items := make([]SkillPackageFileItem, 0, len(files))
	for _, file := range files {
		items = append(items, skillFileItem(file))
	}
	return items, nil
}

func (s *Service) SkillPackageFile(userID string, skillID string, filePath string) (*SkillPackageFileContent, error) {
	skill, version, file, content, err := s.readSkillPackageFile(userID, skillID, filePath)
	_ = skill
	_ = version
	if err != nil {
		return nil, err
	}
	binary := !isPreviewText(file.MimeType, file.Path)
	if binary {
		return &SkillPackageFileContent{File: skillFileItem(*file), Binary: true}, nil
	}
	if len(content) > maxSkillPreviewBytes {
		return nil, kernel.BadAuthRequest("文件超过 512KB，请下载后查看")
	}
	return &SkillPackageFileContent{File: skillFileItem(*file), Content: string(content)}, nil
}

func (s *Service) SkillPackageRawFile(userID string, skillID string, filePath string) ([]byte, string, string, error) {
	_, _, file, content, err := s.readSkillPackageFile(userID, skillID, filePath)
	if err != nil {
		return nil, "", "", err
	}
	return content, file.MimeType, path.Base(file.Path), nil
}

func (s *Service) SkillPackageBundle(userID string, skillID string) (*SkillPackageBundle, error) {
	skill, err := s.visibleSkill(userID, skillID)
	if err != nil {
		return nil, err
	}
	version, err := s.repo.SkillVersion(skill.CurrentVersionID)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.SkillFiles(version.ID)
	if err != nil {
		return nil, err
	}
	bundle := &SkillPackageBundle{SkillID: skill.ID, Name: skill.Name, Description: skill.Description, VersionID: version.ID, Version: version.VersionLabel, ContentHash: version.ContentHash, Files: make([]SkillPackageBundleFile, 0, len(files))}
	bundle.MarketRelease, err = marketReleaseMetadata(version.MarketReleaseJSON)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		content, err := s.readSkillArchiveEntry(version, file.Path)
		if err != nil {
			return nil, err
		}
		bundle.Files = append(bundle.Files, SkillPackageBundleFile{Path: file.Path, MimeType: file.MimeType, ContentBase64: base64.StdEncoding.EncodeToString(content)})
	}
	return bundle, nil
}

func (s *Service) SearchSkillPackage(userID string, skillID string, query string) ([]SkillFileSearchResult, error) {
	skill, err := s.visibleSkill(userID, skillID)
	if err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if query == "" || utf8.RuneCountInString(query) > 120 {
		return nil, kernel.BadAuthRequest("搜索关键词必须为 1-120 个字符")
	}
	version, err := s.repo.SkillVersion(skill.CurrentVersionID)
	if err != nil {
		return nil, err
	}
	files, err := s.repo.SkillFiles(version.ID)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(query)
	results := make([]SkillFileSearchResult, 0, 20)
	for _, file := range files {
		if len(results) >= 50 || !isPreviewText(file.MimeType, file.Path) || file.Size > maxSkillPreviewBytes {
			continue
		}
		content, err := s.readSkillArchiveEntry(version, file.Path)
		if err != nil {
			return nil, err
		}
		for lineIndex, line := range strings.Split(string(content), "\n") {
			if strings.Contains(strings.ToLower(line), needle) {
				results = append(results, SkillFileSearchResult{Path: file.Path, Line: lineIndex + 1, Snippet: kernel.TruncateRunes(strings.TrimSpace(line), 240)})
				if len(results) >= 50 {
					break
				}
			}
		}
	}
	return results, nil
}

func (s *Service) readSkillPackageFile(userID string, skillID string, filePath string) (*model.Skill, *model.SkillVersion, *model.SkillFile, []byte, error) {
	skill, err := s.visibleSkill(userID, skillID)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	filePath, err = normalizeSkillPath(filePath)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	version, err := s.repo.SkillVersion(skill.CurrentVersionID)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	files, err := s.repo.SkillFiles(version.ID)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	for index := range files {
		if files[index].Path != filePath {
			continue
		}
		content, err := s.readSkillArchiveEntry(version, filePath)
		return skill, version, &files[index], content, err
	}
	return nil, nil, nil, nil, kernel.BadAuthRequest("技能文件不存在")
}

func (s *Service) readSkillArchiveEntry(version *model.SkillVersion, filePath string) ([]byte, error) {
	absolute := filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(version.PackageKey))
	reader, err := zip.OpenReader(absolute)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if entry.Name != filePath {
			continue
		}
		file, err := entry.Open()
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return io.ReadAll(io.LimitReader(file, maxSkillFileBytes+1))
	}
	return nil, kernel.BadAuthRequest("技能文件不存在")
}

func normalizeSkillPath(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if value == "" || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "/") {
		return "", kernel.BadAuthRequest("技能文件路径无效")
	}
	clean := path.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") || strings.HasPrefix(clean, ".git/") || clean == ".git" {
		return "", kernel.BadAuthRequest("技能文件路径越界或包含禁止目录")
	}
	if utf8.RuneCountInString(clean) > 1000 {
		return "", kernel.BadAuthRequest("技能文件路径过长")
	}
	return clean, nil
}

func skillFileMime(filePath string, content []byte) string {
	if filePath == "SKILL.md" || strings.HasSuffix(strings.ToLower(filePath), ".md") {
		return "text/markdown; charset=utf-8"
	}
	if detected := mime.TypeByExtension(strings.ToLower(path.Ext(filePath))); detected != "" {
		return detected
	}
	return http.DetectContentType(content)
}

func skillFileKind(filePath string) string {
	extension := strings.ToLower(path.Ext(filePath))
	switch extension {
	case ".md", ".mdx":
		return "markdown"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg":
		return "image"
	case ".mp4", ".webm", ".mov":
		return "video"
	case ".mp3", ".wav", ".m4a", ".ogg":
		return "audio"
	case ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".sh", ".json", ".yaml", ".yml", ".toml", ".html", ".css":
		return "code"
	case ".txt", ".csv":
		return "text"
	default:
		return "binary"
	}
}

func isPreviewText(mimeType string, filePath string) bool {
	return strings.HasPrefix(mimeType, "text/") || strings.Contains(mimeType, "json") || strings.Contains(mimeType, "yaml") || strings.Contains(mimeType, "toml") || skillFileKind(filePath) == "code"
}

func skillFileItem(file model.SkillFile) SkillPackageFileItem {
	return SkillPackageFileItem{Path: file.Path, Kind: file.Kind, MimeType: file.MimeType, Size: file.Size, SHA256: file.SHA256}
}

func sortedSkillPaths(files map[string][]byte) []string {
	paths := make([]string, 0, len(files))
	for filePath := range files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	return paths
}

func shortCommit(value string) string {
	if len(value) <= 12 {
		return value
	}
	return value[:12]
}

func isSkillPackageNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, os.ErrNotExist)
}
