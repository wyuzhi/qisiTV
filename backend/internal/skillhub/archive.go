package skillhub

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/goccy/go-yaml"
)

var privateLiteral = regexp.MustCompile(`btvpub_[A-Za-z0-9_-]{20,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----`)

func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func SafeFilePath(name string) bool {
	if name == "" || len(name) > 512 || !utf8.ValidString(name) || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "\\:\x00") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "." || part == ".." || part == "" || strings.HasPrefix(part, ".") || part == "__MACOSX" {
			return false
		}
		if strings.TrimRight(part, " .") != part || strings.ContainsAny(part, "<>\"|?*\r\n") {
			return false
		}
		device := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if device == "CON" || device == "PRN" || device == "AUX" || device == "NUL" || (len(device) == 4 && (strings.HasPrefix(device, "COM") || strings.HasPrefix(device, "LPT")) && device[3] >= '1' && device[3] <= '9') {
			return false
		}
	}
	return true
}

// DataFilePath validates package paths and rejects node_modules and secret files.
func DataFilePath(name string) bool {
	if !SafeFilePath(name) {
		return false
	}
	for _, part := range strings.Split(strings.ToLower(name), "/") {
		if part == "node_modules" {
			return false
		}
	}
	base := strings.ToLower(path.Base(name))
	if base == "credentials.json" || base == "tokens.json" || base == "secrets.json" || base == "auth.json" || base == ".env" || strings.HasPrefix(base, ".env.") || strings.Contains(base, "private_key") || base == "id_rsa" || base == "id_ed25519" || strings.HasSuffix(base, ".pem") || strings.HasSuffix(base, ".key") {
		return false
	}
	return true
}

func ContainsPrivateData(data []byte) bool {
	return privateLiteral.Match(data) || (bytes.Contains(data, []byte(`"market"`)) && bytes.Contains(data, []byte(`"deviceCode"`)))
}

type SkillMarkdownMetadata struct {
	Name                 string
	TechnicalName        string
	Description          string
	Version              string
	MalformedFrontmatter bool
}

func ParseSkillMarkdown(data []byte) SkillMarkdownMetadata {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	metadata := SkillMarkdownMetadata{}
	bodyStart := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		closed := false
		for index := 1; index < len(lines); index++ {
			if strings.TrimSpace(lines[index]) == "---" {
				bodyStart = index + 1
				closed = true
				parseFrontmatterBlock(lines[1:index], &metadata)
				break
			}
		}
		if !closed {
			metadata.MalformedFrontmatter = true
		}
	}
	body := lines[bodyStart:]
	metadata.TechnicalName, metadata.Name = strings.TrimSpace(metadata.Name), displaySkillName(strings.TrimSpace(metadata.Name), body)
	if metadata.Name == "" {
		metadata.Name = firstMarkdownTitle(body)
	}
	if metadata.Description == "" {
		paragraph := make([]string, 0, 4)
		for _, line := range body {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				if len(paragraph) > 0 {
					break
				}
				continue
			}
			if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "```") {
				continue
			}
			paragraph = append(paragraph, trimmed)
		}
		metadata.Description = fitSkillRunes(strings.Join(paragraph, " "), MaxDescriptionRunes)
	}
	metadata.Name = strings.TrimSpace(metadata.Name)
	metadata.Description = strings.TrimSpace(metadata.Description)
	metadata.Version = strings.TrimSpace(metadata.Version)
	return metadata
}

func parseFrontmatterBlock(frontLines []string, metadata *SkillMarkdownMetadata) {
	var parsed struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
		Version     string `yaml:"version"`
		Metadata    struct {
			Version string `yaml:"version"`
		} `yaml:"metadata"`
	}
	rawFront := strings.Join(frontLines, "\n")
	if err := yaml.Unmarshal([]byte(rawFront), &parsed); err == nil {
		metadata.Name = strings.TrimSpace(parsed.Name)
		metadata.Description = strings.TrimSpace(parsed.Description)
		metadata.Version = strings.TrimSpace(parsed.Version)
		if metadata.Version == "" {
			metadata.Version = strings.TrimSpace(parsed.Metadata.Version)
		}
	}
	metadataIndent := -1
	for _, line := range frontLines {
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		if indent == 0 {
			metadataIndent = -1
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = yamlScalarValue(value)
		if value == "" {
			if indent == 0 && key == "metadata" {
				metadataIndent = indent
			}
			continue
		}
		switch {
		case indent == 0 && key == "name" && metadata.Name == "":
			metadata.Name = value
		case indent == 0 && key == "description" && metadata.Description == "":
			metadata.Description = value
		case indent == 0 && key == "version" && metadata.Version == "":
			metadata.Version = value
		case indent == 0 && key == "metadata":
			metadataIndent = indent
		case metadataIndent >= 0 && indent > metadataIndent && key == "version" && metadata.Version == "":
			metadata.Version = value
		}
	}
}

func fitSkillRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func isTechnicalSkillName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func displaySkillName(name string, body []string) string {
	if !isTechnicalSkillName(name) {
		return name
	}
	title := firstMarkdownTitle(body)
	if strings.ContainsFunc(title, func(r rune) bool { return unicode.Is(unicode.Han, r) }) && utf8.RuneCountInString(title) <= MaxNameRunes {
		return title
	}
	return name
}

func firstMarkdownTitle(body []string) string {
	fenceChar, fenceLen := byte(0), 0
	for _, line := range body {
		content := strings.TrimLeft(line, " ")
		indented := len(line)-len(content) >= 4 || strings.HasPrefix(content, "\t")
		trimmed := strings.TrimSpace(line)
		if char, n := codeFence(trimmed); n > 0 && !indented {
			if fenceLen == 0 {
				fenceChar, fenceLen = char, n
			} else if char == fenceChar && n >= fenceLen && strings.Trim(trimmed, string(char)) == "" {
				fenceLen = 0
			}
			continue
		}
		if fenceLen > 0 || indented || !strings.HasPrefix(trimmed, "# ") {
			continue
		}
		title := strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		if closed := strings.TrimRight(title, "#"); closed == "" || strings.TrimRight(closed, " \t") != closed {
			title = strings.TrimSpace(closed)
		}
		return title
	}
	return ""
}

func codeFence(line string) (byte, int) {
	if len(line) < 3 || line[0] != '`' && line[0] != '~' {
		return 0, 0
	}
	n := len(line) - len(strings.TrimLeft(line, string(line[0])))
	if n < 3 {
		return 0, 0
	}
	return line[0], n
}

func yamlScalarValue(value string) string {
	value = strings.TrimSpace(value)
	switch value {
	case ">", "|", ">-", "|-", ">+", "|+":
		return ""
	}
	if len(value) >= 2 && value[0] == '"' {
		if decoded, err := strconv.Unquote(value); err == nil {
			return strings.TrimSpace(decoded)
		}
	}
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return strings.TrimSpace(value[1 : len(value)-1])
	}
	return value
}

func SkillName(markdown []byte) (string, error) {
	if len(markdown) == 0 || !utf8.Valid(markdown) {
		return "", fmt.Errorf("SKILL.md 缺少元信息")
	}
	metadata := ParseSkillMarkdown(markdown)
	if metadata.MalformedFrontmatter {
		return "", fmt.Errorf("SKILL.md 元信息无效")
	}
	name := metadata.TechnicalName
	if name == "" {
		name = metadata.Name
	}
	if name == "" || utf8.RuneCountInString(name) > MaxNameRunes || utf8.RuneCountInString(metadata.Name) > MaxNameRunes || metadata.Description == "" || utf8.RuneCountInString(metadata.Description) > MaxDescriptionRunes {
		return "", fmt.Errorf("SKILL.md 名称或简介不符合 Agent Skills 格式")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("Skill 名称包含无效控制字符")
		}
	}
	return name, nil
}

func ContentDigest(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		hash.Write([]byte(name))
		hash.Write([]byte{0})
		hash.Write(files[name])
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// VerifyArchive validates every archive entry before any file reaches disk.
func VerifyArchive(raw []byte, release *Release) (map[string][]byte, error) {
	if len(raw) > MaxArchiveBytes || int64(len(raw)) != release.ArchiveBytes || Digest(raw) != release.ArchiveSHA256 {
		return nil, fmt.Errorf("下载包大小或 SHA-256 与指定发布版本不符")
	}
	if len(release.Files) == 0 {
		return nil, fmt.Errorf("发布文件清单无效")
	}
	manifest := map[string]File{}
	caseNames := map[string]bool{}
	var manifestTotal int64
	for _, file := range release.Files {
		key := strings.ToLower(file.Path)
		if !DataFilePath(file.Path) || caseNames[key] || file.Size < 0 || file.Size > MaxPackageBytes-manifestTotal {
			return nil, fmt.Errorf("发布文件路径、数量或大小无效")
		}
		caseNames[key] = true
		manifest[file.Path] = file
		manifestTotal += file.Size
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("下载内容不是有效 ZIP")
	}
	if len(zr.File) != len(manifest) {
		return nil, fmt.Errorf("ZIP 文件数量与清单不符")
	}
	files := map[string][]byte{}
	seen := map[string]bool{}
	var total int64
	for _, entry := range zr.File {
		file, ok := manifest[entry.Name]
		if !ok || seen[entry.Name] || !entry.Mode().IsRegular() || entry.Flags&1 != 0 || entry.UncompressedSize64 != uint64(file.Size) {
			return nil, fmt.Errorf("ZIP 含不在清单中的文件、链接或重复条目")
		}
		seen[entry.Name] = true
		reader, err := entry.Open()
		if err != nil {
			return nil, fmt.Errorf("无法读取 ZIP 文件")
		}
		data, err := io.ReadAll(io.LimitReader(reader, MaxPackageBytes-total+1))
		reader.Close()
		total += int64(len(data))
		if total > MaxPackageBytes {
			return nil, fmt.Errorf("发布文件总大小超过200 MiB")
		}
		if err != nil || int64(len(data)) != file.Size || Digest(data) != file.SHA256 {
			return nil, fmt.Errorf("发布文件 %s 校验失败", file.Path)
		}
		if ContainsPrivateData(data) {
			return nil, fmt.Errorf("发布文件 %s 含敏感凭据或私钥", file.Path)
		}
		files[entry.Name] = data
	}
	if len(files["SKILL.md"]) == 0 || !utf8.Valid(files["SKILL.md"]) || ContentDigest(files) != release.ContentHash {
		return nil, fmt.Errorf("技能正文或内容摘要无效")
	}
	if _, err := SkillName(files["SKILL.md"]); err != nil {
		return nil, err
	}
	return files, nil
}
