package skills

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skillhub"
	"io"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"
)

type skillPackageMetadata struct {
	Name          string
	TechnicalName string
	Description   string
	Version       string
	MarketRelease *skillhub.Release
}

func archiveFromMarkdown(data []byte, fallbackName string, fallbackDescription string) (skillPackageArchive, error) {
	return archiveFromMarkdownWithFiles(data, fallbackName, fallbackDescription, nil)
}

func archiveFromMarkdownWithFiles(data []byte, fallbackName string, fallbackDescription string, extraFiles map[string][]byte) (skillPackageArchive, error) {
	if len(data) == 0 || len(data) > maxSkillPackageBytes || !utf8.Valid(data) {
		return skillPackageArchive{}, kernel.BadAuthRequest("Markdown 文件为空、过大或不是 UTF-8")
	}
	metadata := parseSkillPackageMetadata(data)
	if metadata.Name == "" {
		metadata.Name = strings.TrimSpace(fallbackName)
	}
	if metadata.Description == "" {
		metadata.Description = strings.TrimSpace(fallbackDescription)
	}
	files := make(map[string][]byte, len(extraFiles)+1)
	for filePath, content := range extraFiles {
		if filePath == "SKILL.md" {
			continue
		}
		files[filePath] = content
	}
	files["SKILL.md"] = data
	return finalizeSkillArchive(files, metadata)
}

func archiveFromZip(data []byte, subdir string) (skillPackageArchive, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return skillPackageArchive{}, kernel.BadAuthRequest("ZIP 文件无法解析")
	}
	raw := make(map[string][]byte)
	var total int64
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		if entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() {
			return skillPackageArchive{}, kernel.BadAuthRequest("技能包不能包含软链接或特殊文件")
		}
		entryPath, err := normalizeSkillPath(entry.Name)
		if err != nil {
			return skillPackageArchive{}, err
		}
		if strings.HasPrefix(entryPath, "__MACOSX/") || path.Base(entryPath) == ".DS_Store" {
			continue
		}
		if _, exists := raw[entryPath]; exists {
			return skillPackageArchive{}, kernel.BadAuthRequest("技能包包含重复文件路径")
		}
		// 声明的大小可能是假的，按实际读到的字节数算总量。
		file, err := entry.Open()
		if err != nil {
			return skillPackageArchive{}, err
		}
		content, readErr := io.ReadAll(io.LimitReader(file, maxSkillPackageBytes-total+1))
		closeErr := file.Close()
		if readErr != nil {
			return skillPackageArchive{}, readErr
		}
		if closeErr != nil {
			return skillPackageArchive{}, closeErr
		}
		total += int64(len(content))
		if total > maxSkillPackageBytes {
			return skillPackageArchive{}, errSkillPackageTooLarge()
		}
		raw[entryPath] = content
	}
	files, err := normalizeSkillArchiveRoot(raw, subdir)
	if err != nil {
		return skillPackageArchive{}, err
	}
	metadata := parseSkillPackageMetadata(files["SKILL.md"])
	return finalizeSkillArchive(files, metadata)
}

func normalizeSkillArchiveRoot(raw map[string][]byte, subdir string) (map[string][]byte, error) {
	if len(raw) == 0 {
		return nil, kernel.BadAuthRequest("技能包为空")
	}
	paths := sortedSkillPaths(raw)
	firstParts := strings.SplitN(paths[0], "/", 2)
	if len(firstParts) == 2 {
		wrapper := firstParts[0] + "/"
		allWrapped := true
		for _, filePath := range paths {
			if !strings.HasPrefix(filePath, wrapper) {
				allWrapped = false
				break
			}
		}
		if allWrapped {
			next := make(map[string][]byte, len(raw))
			for filePath, content := range raw {
				next[strings.TrimPrefix(filePath, wrapper)] = content
			}
			raw = next
		}
	}
	subdir = strings.Trim(strings.ReplaceAll(strings.TrimSpace(subdir), "\\", "/"), "/")
	if subdir != "" {
		normalized, err := normalizeSkillPath(subdir)
		if err != nil {
			return nil, err
		}
		prefix := normalized + "/"
		filtered := make(map[string][]byte)
		for filePath, content := range raw {
			if strings.HasPrefix(filePath, prefix) {
				filtered[strings.TrimPrefix(filePath, prefix)] = content
			}
		}
		if len(filtered) == 0 && !strings.Contains(normalized, "/") {
			if matchedRoot := matchSkillSubdirBySkillID(raw, normalized); matchedRoot == "." {
				nestedSkillDirs := make([]string, 0)
				for _, filePath := range sortedSkillPaths(raw) {
					if filePath != "SKILL.md" && path.Base(filePath) == "SKILL.md" {
						nestedSkillDirs = append(nestedSkillDirs, path.Dir(filePath)+"/")
					}
				}
				for filePath, content := range raw {
					inNestedSkill := false
					for _, nestedPrefix := range nestedSkillDirs {
						if strings.HasPrefix(filePath, nestedPrefix) {
							inNestedSkill = true
							break
						}
					}
					if !inNestedSkill {
						filtered[filePath] = content
					}
				}
			} else if matchedRoot != "" {
				matchedPrefix := matchedRoot + "/"
				for filePath, content := range raw {
					if strings.HasPrefix(filePath, matchedPrefix) {
						filtered[strings.TrimPrefix(filePath, matchedPrefix)] = content
					}
				}
			}
		}
		if len(filtered) == 0 {
			return nil, kernel.BadAuthRequest("GitHub 子目录不存在或为空")
		}
		raw = filtered
	}
	skillRoots := make([]string, 0, 2)
	for filePath := range raw {
		if filePath == "SKILL.md" {
			skillRoots = []string{""}
			break
		}
		if path.Base(filePath) == "SKILL.md" {
			skillRoots = append(skillRoots, path.Dir(filePath))
		}
	}
	if len(skillRoots) == 0 {
		return nil, kernel.BadAuthRequest("技能包中缺少 SKILL.md")
	}
	if len(skillRoots) > 1 {
		return nil, kernel.BadAuthRequest("技能包包含多个 SKILL.md，请指定单个技能目录")
	}
	root := skillRoots[0]
	files := make(map[string][]byte)
	for filePath, content := range raw {
		if root != "" {
			prefix := root + "/"
			if !strings.HasPrefix(filePath, prefix) {
				continue
			}
			filePath = strings.TrimPrefix(filePath, prefix)
		}
		files[filePath] = content
	}
	return files, nil
}

func matchSkillSubdirBySkillID(raw map[string][]byte, skillID string) string {
	for _, filePath := range sortedSkillPaths(raw) {
		if path.Base(filePath) != "SKILL.md" {
			continue
		}
		dir := path.Dir(filePath)
		if dir != "." && strings.EqualFold(path.Base(dir), skillID) {
			return dir
		}
		parsed := skillhub.ParseSkillMarkdown(raw[filePath])
		if strings.EqualFold(parsed.TechnicalName, skillID) || strings.EqualFold(parsed.Name, skillID) {
			return dir
		}
	}
	return ""
}

func finalizeSkillArchive(files map[string][]byte, metadata skillPackageMetadata) (skillPackageArchive, error) {
	if _, ok := files["SKILL.md"]; !ok {
		return skillPackageArchive{}, kernel.BadAuthRequest("技能包入口必须是 SKILL.md")
	}
	if metadata.Name == "" {
		return skillPackageArchive{}, kernel.BadAuthRequest("SKILL.md 缺少 name，且无法从标题推断")
	}
	if metadata.Description == "" {
		return skillPackageArchive{}, kernel.BadAuthRequest("SKILL.md 缺少 description，且无法从正文推断")
	}
	if utf8.RuneCountInString(metadata.Name) > maxSkillNameRunes {
		return skillPackageArchive{}, kernel.BadAuthRequest("技能名称超过长度限制")
	}
	metadata.Description = fitRunes(metadata.Description, maxSkillDescriptionRunes)
	hash := sha256.New()
	var total int64
	for _, filePath := range sortedSkillPaths(files) {
		content := files[filePath]
		total += int64(len(content))
		if total > maxSkillPackageBytes {
			return skillPackageArchive{}, errSkillPackageTooLarge()
		}
		hash.Write([]byte(filePath))
		hash.Write([]byte{0})
		hash.Write(content)
		hash.Write([]byte{0})
	}
	return skillPackageArchive{Files: files, Metadata: metadata, ContentHash: hex.EncodeToString(hash.Sum(nil)), TotalBytes: total}, nil
}

func encodeSkillArchive(files map[string][]byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, filePath := range sortedSkillPaths(files) {
		header := &zip.FileHeader{Name: filePath, Method: zip.Deflate}
		header.SetMode(0o600)
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err := entry.Write(files[filePath]); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func parseSkillPackageMetadata(data []byte) skillPackageMetadata {
	parsed := skillhub.ParseSkillMarkdown(data)
	return skillPackageMetadata{
		Name:          fitRunes(parsed.Name, maxSkillNameRunes),
		TechnicalName: parsed.TechnicalName,
		Description:   fitRunes(parsed.Description, maxSkillDescriptionRunes),
		Version:       kernel.TruncateRunes(parsed.Version, 64),
	}
}

func errSkillPackageTooLarge() error {
	return kernel.BadAuthRequest("技能包解压后不能超过 200MB")
}

// fitRunes 把超长文本截到上限以内（省略号也算在内），截完不会再被打包校验判为超长。
func fitRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
