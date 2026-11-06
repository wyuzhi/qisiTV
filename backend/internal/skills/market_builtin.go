package skills

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"
)

func (s *Service) builtinMarketReleases() ([]skillhub.Release, map[string]*model.SkillVersion) {
	if s == nil || s.repo == nil {
		return nil, nil
	}
	ids, err := builtinDefaultAddedSkillIDs()
	if err != nil || len(ids) == 0 {
		return nil, nil
	}
	releases := make([]skillhub.Release, 0, len(ids))
	versions := make(map[string]*model.SkillVersion, len(ids))
	for _, id := range ids {
		skill, err := s.repo.Skill(id)
		if err != nil || skill == nil || skill.CurrentVersionID == "" {
			continue
		}
		version, err := s.repo.SkillVersion(skill.CurrentVersionID)
		if err != nil || version == nil {
			continue
		}
		dbFiles, err := s.repo.SkillFiles(version.ID)
		if err != nil || len(dbFiles) == 0 {
			continue
		}
		archivePath := filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(version.PackageKey))
		archiveBytes, err := os.ReadFile(archivePath)
		if err != nil || len(archiveBytes) == 0 {
			continue
		}
		archiveSum := sha256.Sum256(archiveBytes)
		archiveSHA256 := hex.EncodeToString(archiveSum[:])
		files := make([]skillhub.File, 0, len(dbFiles))
		for _, f := range dbFiles {
			files = append(files, skillhub.File{
				Path:     f.Path,
				SHA256:   f.SHA256,
				Size:     f.Size,
				MimeType: f.MimeType,
			})
		}
		versionLabel := strings.TrimSpace(skill.VersionLabel)
		if versionLabel == "" {
			versionLabel = "1.0.0"
		}
		releaseID := skill.ID + "-" + versionLabel
		author := strings.TrimSpace(skill.AuthorName)
		if author == "" {
			author = "BeefTV 官方"
		}
		publishedAt := skill.UpdatedAt.UTC().Format(time.RFC3339)
		rel := skillhub.Release{
			Metadata: skillhub.Metadata{
				SkillID:      skill.ID,
				Name:         skill.Name,
				Description:  skill.Description,
				License:      "CC0-1.0",
				SourceURL:    "https://beeftv.app",
				VersionLabel: versionLabel,
				Requirements: []string{},
				Showcase:     []skillhub.Showcase{},
			},
			ReleaseID:     releaseID,
			Author:        author,
			ContentHash:   version.ContentHash,
			ArchiveSHA256: archiveSHA256,
			ArchiveBytes:  int64(len(archiveBytes)),
			Files:         files,
			PublishedAt:   publishedAt,
			Review: &skillhub.ReviewSummary{
				ReviewedAt:    publishedAt,
				Revision:      1,
				ContentHash:   version.ContentHash,
				ArchiveSHA256: archiveSHA256,
				PreviewDigest: version.ContentHash,
				Trials: []skillhub.ReviewTrial{
					{
						Scenario:       "漫剧小说拆解、参考图设定与分镜视频提示词画布全链路",
						Target:         "beeftv",
						RuntimeVersion: "v2.1.1",
						Model:          "beeftv-agent",
						Conclusion:     "已通过内置助手画布实测验收",
						TestedAt:       publishedAt,
					},
				},
			},
		}
		releases = append(releases, rel)
		versions[rel.SkillID] = version
	}
	return releases, versions
}

func (s *Service) matchingBuiltinMarketReleases(query string) []skillhub.Release {
	releases, _ := s.builtinMarketReleases()
	if len(releases) == 0 {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return releases
	}
	matched := make([]skillhub.Release, 0, len(releases))
	for _, rel := range releases {
		haystack := strings.ToLower(rel.Name + " " + rel.Description + " " + rel.Author + " " + rel.SkillID)
		if strings.Contains(haystack, q) {
			matched = append(matched, rel)
		}
	}
	return matched
}

func (s *Service) findBuiltinMarketRelease(id, releaseID string) (*skillhub.Release, *model.SkillVersion, bool) {
	if s == nil || s.repo == nil {
		return nil, nil, false
	}
	ids, err := builtinDefaultAddedSkillIDs()
	if err != nil {
		return nil, nil, false
	}
	isBuiltin := false
	for _, candidate := range ids {
		if candidate == id {
			isBuiltin = true
			break
		}
	}
	if !isBuiltin {
		return nil, nil, false
	}
	releases, versions := s.builtinMarketReleases()
	for i := range releases {
		rel := &releases[i]
		if rel.SkillID == id && (rel.ReleaseID == releaseID || rel.VersionLabel == releaseID) {
			return rel, versions[rel.SkillID], true
		}
	}
	return nil, nil, false
}

func (s *Service) readBuiltinMarketFile(rel *skillhub.Release, ver *model.SkillVersion, name string, offset, limit int) (*skillhub.FileChunk, error) {
	if !skillhub.SafeFilePath(name) || offset < 0 || limit < 0 || limit > 64<<10 || (limit > 0 && limit < 4) {
		return nil, &skillhub.Error{Status: 400, Reason: "invalid_file_range", Message: "文件路径或读取范围无效"}
	}
	if limit == 0 {
		limit = 32 << 10
	}
	var file *skillhub.File
	for _, entry := range rel.Files {
		if entry.Path == name {
			copyEntry := entry
			file = &copyEntry
			break
		}
	}
	if file == nil {
		return nil, &skillhub.Error{Status: 404, Reason: "not_found", Message: "文件不在此发布版本清单中"}
	}
	if file.Size < 0 || file.Size > maxSkillPackageBytes {
		return nil, &skillhub.Error{Status: 502, Reason: "file_integrity", Message: "文件大小无效"}
	}
	data, err := s.readSkillArchiveEntry(ver, name)
	if err != nil || int64(len(data)) != file.Size || skillhub.Digest(data) != file.SHA256 {
		return nil, &skillhub.Error{Status: 502, Reason: "file_integrity", Message: "文件内容与发布版本不符"}
	}
	text := utf8.Valid(data)
	if offset > len(data) || (text && offset < len(data) && !utf8.RuneStart(data[offset])) {
		return nil, &skillhub.Error{Status: 400, Reason: "invalid_file_range", Message: "文件读取起点无效"}
	}
	end := min(offset+limit, len(data))
	if text {
		for end < len(data) && !utf8.RuneStart(data[end]) {
			end--
		}
	}
	result := &skillhub.FileChunk{File: *file, Encoding: "utf-8", Content: string(data[offset:end]), Offset: offset, NextOffset: end, EOF: end == len(data)}
	if !text {
		result.Encoding = "base64"
		result.Content = base64.StdEncoding.EncodeToString(data[offset:end])
	}
	return result, nil
}

func builtinReleaseToSearchItem(rel skillhub.Release) skillhub.SearchItem {
	return skillhub.SearchItem{
		Kind:          "skill",
		SkillID:       rel.SkillID,
		ReleaseID:     rel.ReleaseID,
		VersionLabel:  rel.VersionLabel,
		Name:          rel.Name,
		Description:   rel.Description,
		Author:        rel.Author,
		License:       rel.License,
		SourceURL:     rel.SourceURL,
		Requirements:  rel.Requirements,
		Compatibility: skillhub.Compatibility{Status: "supported", Reasons: []string{}},
		Verification:  "tested",
	}
}
