package skills

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// ApplyPluginSkills is the plugin runtime's skill hook: enabled packages keep
// their skills in the catalog, disabled or removed ones lose them.
func (s *Service) ApplyPluginSkills(pluginID, pluginName, version string, skillDirs []string, enabled bool) {
	var err error
	if enabled && len(skillDirs) > 0 {
		err = s.SyncPluginSkills(pluginID, pluginName, version, skillDirs)
	} else {
		err = s.RemovePluginSkills(pluginID)
	}
	if err != nil {
		log.Printf("同步插件 %s 的技能失败：%v", pluginID, err)
	}
}

// SyncPluginSkills registers or updates skills contributed by an enabled plugin
// package and removes any stale skills previously registered by the same plugin.
func (s *Service) SyncPluginSkills(pluginID string, pluginName string, version string, skillDirs []string) error {
	if s == nil || s.repo == nil || s.repo.DB() == nil {
		return nil
	}
	pluginID = strings.TrimSpace(pluginID)
	if pluginID == "" {
		return nil
	}
	authorName := strings.TrimSpace(pluginName)
	if authorName == "" {
		authorName = pluginID
	}
	return s.syncDirectorySkills(skillDirSource{
		sourceType: skillSourceTypePlugin, sourceURL: "plugin://" + pluginID, idPrefix: "plugin-" + sanitizePluginSkillSlug(pluginID) + "-",
		ownerFallback: "plugin:" + pluginID, authorName: authorName, version: version, fallbackDescription: authorName + " 插件技能",
	}, skillDirs)
}

const (
	skillSourceTypePlugin = "plugin"
	skillSourceTypeLocal  = "local"
)

// skillDirSource 说明一批文件夹技能从哪来。插件包和本机技能目录走同一条登记路径，只有这些字段不同。
type skillDirSource struct {
	sourceType          string
	sourceURL           string
	idPrefix            string
	ownerFallback       string
	authorName          string
	version             string
	fallbackDescription string
	// private 表示技能只在这台电脑上，不算公开内容。
	private bool
	// skipBroken 让读不出来的技能只跳过它自己。本机目录里的内容不归 BeefTV 管，一个坏技能不能拖累别的。
	skipBroken bool
}

// syncDirectorySkills 把文件夹里的技能登记进技能库，并删掉这个来源下已经不存在的技能。
func (s *Service) syncDirectorySkills(source skillDirSource, skillDirs []string) error {
	discovered, err := discoverPluginSkillDirectories(skillDirs)
	if err != nil {
		return err
	}
	userID := ""
	if ws, wsErr := s.repo.DefaultWorkspace(); wsErr == nil && ws != nil {
		userID = strings.TrimSpace(ws.ID)
	}
	seenIDs := make(map[string]struct{}, len(discovered))
	for _, entry := range discovered {
		skillID := source.idPrefix + sanitizePluginSkillSlug(entry.slug)
		seenIDs[skillID] = struct{}{}
		if err := s.syncDirectorySkill(source, userID, skillID, entry); err != nil {
			if !source.skipBroken {
				return err
			}
			log.Printf("跳过技能 %s：%v", entry.slug, err)
		}
	}
	var existingRows []model.Skill
	if err := s.repo.DB().Where("source_type = ? AND source_url = ?", source.sourceType, source.sourceURL).Find(&existingRows).Error; err != nil {
		return err
	}
	for _, row := range existingRows {
		if _, keep := seenIDs[row.ID]; !keep {
			if err := s.repo.DeleteSkill(row.ID); err != nil {
				return err
			}
			_ = os.RemoveAll(filepath.Join(s.dataDir, "skill-packages", row.ID))
		}
	}
	return nil
}

func (s *Service) syncDirectorySkill(source skillDirSource, userID, skillID string, entry discoveredPluginSkillDir) error {
	files, err := readSkillDirectoryFiles(entry.dir)
	if err != nil {
		return err
	}
	meta := parseSkillPackageMetadata(files["SKILL.md"])
	if meta.Name == "" {
		meta.Name = entry.slug
	}
	if meta.Description == "" {
		meta.Description = source.fallbackDescription
	}
	if strings.TrimSpace(source.version) != "" {
		meta.Version = strings.TrimSpace(source.version)
	}
	archive, err := finalizeSkillArchive(files, meta)
	if err != nil {
		return err
	}
	versionLabel := archive.Metadata.Version
	if versionLabel == "" {
		versionLabel = "1.0.0"
	}
	existing, err := s.repo.Skill(skillID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		versionID := kernel.NewID()
		packageKey, versionModel, fileModels, err := s.persistSkillArchive(skillID, versionID, archive, "")
		if err != nil {
			return err
		}
		versionModel.VersionLabel = versionLabel
		now := time.Now()
		ownerID := userID
		if ownerID == "" {
			ownerID = source.ownerFallback
		}
		skill := &model.Skill{
			ID: skillID, OwnerID: ownerID, AuthorName: source.authorName, Name: archive.Metadata.Name,
			Description: archive.Metadata.Description, Instruction: string(archive.Files["SKILL.md"]),
			CurrentVersionID: versionID, VersionLabel: versionLabel, ContentHash: archive.ContentHash,
			FileCount: len(archive.Files), TotalBytes: archive.TotalBytes, SourceType: source.sourceType,
			SourceURL: source.sourceURL, SourceRef: versionLabel, SourceSubdir: entry.slug, SyncStatus: "synced",
			LastCheckedAt: &now, LastSyncedAt: &now, Status: skillStatusEnabled, Source: 3, Tag: "others",
			ShowcaseMediaJSON: "[]", IsPrivate: source.private,
		}
		var state *model.UserSkillState
		if userID != "" {
			state = &model.UserSkillState{ID: kernel.NewID(), UserID: userID, SkillID: skillID, Added: true, InstalledVersionID: versionID}
		}
		if err := s.repo.CreateSkillWithPackage(skill, versionModel, fileModels, state); err != nil {
			_ = os.Remove(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(packageKey)))
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	existing.Name, existing.Description = archive.Metadata.Name, archive.Metadata.Description
	existing.Instruction, existing.AuthorName = string(archive.Files["SKILL.md"]), source.authorName
	if existing.ContentHash != archive.ContentHash || existing.CurrentVersionID == "" {
		if err := s.addSkillArchiveVersion(existing, archive, source.sourceType, source.sourceURL, versionLabel, entry.slug, "", false); err != nil {
			return err
		}
	} else {
		existing.VersionLabel, existing.SourceRef = versionLabel, versionLabel
		if err := s.repo.SaveSkill(existing); err != nil {
			return err
		}
	}
	if userID != "" {
		state, err := s.repo.UserSkillState(userID, skillID)
		if err != nil {
			return err
		}
		if state == nil {
			state = &model.UserSkillState{ID: kernel.NewID(), UserID: userID, SkillID: skillID, Added: true}
		}
		// 同步只换版本。用户停用过的技能，不能被同步重新打开。
		state.InstalledVersionID = existing.CurrentVersionID
		if err := s.repo.SetUserSkillAdded(state); err != nil {
			return err
		}
	}
	return nil
}

// RemovePluginSkills deletes all skills registered by pluginID.
func (s *Service) RemovePluginSkills(pluginID string) error {
	return s.SyncPluginSkills(pluginID, "", "", nil)
}

type discoveredPluginSkillDir struct {
	slug string
	dir  string
}

func discoverPluginSkillDirectories(skillDirs []string) ([]discoveredPluginSkillDir, error) {
	var result []discoveredPluginSkillDir
	seenDirs := map[string]struct{}{}
	for _, rawDir := range skillDirs {
		cleaned := filepath.Clean(strings.TrimSpace(rawDir))
		if cleaned == "" || cleaned == "." {
			continue
		}
		info, err := os.Stat(cleaned)
		if err != nil || !info.IsDir() {
			continue
		}
		if mdInfo, err := os.Stat(filepath.Join(cleaned, "SKILL.md")); err == nil && mdInfo.Mode().IsRegular() {
			if _, dup := seenDirs[cleaned]; !dup {
				seenDirs[cleaned] = struct{}{}
				result = append(result, discoveredPluginSkillDir{slug: filepath.Base(cleaned), dir: cleaned})
			}
			continue
		}
		entries, err := os.ReadDir(cleaned)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			subDir := filepath.Join(cleaned, entry.Name())
			mdInfo, err := os.Stat(filepath.Join(subDir, "SKILL.md"))
			if err != nil || !mdInfo.Mode().IsRegular() {
				continue
			}
			if _, dup := seenDirs[subDir]; dup {
				continue
			}
			seenDirs[subDir] = struct{}{}
			result = append(result, discoveredPluginSkillDir{slug: entry.Name(), dir: subDir})
		}
	}
	return result, nil
}

func readSkillDirectoryFiles(rootDir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	var total int64
	err := filepath.WalkDir(rootDir, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == rootDir {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "__MACOSX" {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || entry.Name() == ".DS_Store" {
			return nil
		}
		rel, err := filepath.Rel(rootDir, current)
		if err != nil {
			return err
		}
		normPath, err := normalizeSkillPath(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		content, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		total += int64(len(content))
		if total > maxSkillPackageBytes {
			return errSkillPackageTooLarge()
		}
		files[normPath] = content
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func sanitizePluginSkillSlug(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		return "skill"
	}
	return out
}
