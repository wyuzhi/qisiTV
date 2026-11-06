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

func SkillName(markdown []byte) (string, error) {
	text := strings.ReplaceAll(string(markdown), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return "", fmt.Errorf("SKILL.md 缺少元信息")
	}
	front, _, ok := strings.Cut(text[4:], "\n---")
	var metadata struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if !ok || yaml.Unmarshal([]byte(front), &metadata) != nil {
		return "", fmt.Errorf("SKILL.md 元信息无效")
	}
	name := metadata.Name
	if name == "" || utf8.RuneCountInString(name) > 64 || name != strings.ToLower(name) || strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") || strings.Contains(name, "--") || !SafeFilePath(name) || strings.TrimSpace(metadata.Description) == "" || utf8.RuneCountInString(metadata.Description) > MaxDescriptionRunes {
		return "", fmt.Errorf("SKILL.md 名称或简介不符合 Agent Skills 格式")
	}
	for _, char := range name {
		if char != '-' && !unicode.IsLetter(char) && !unicode.IsDigit(char) {
			return "", fmt.Errorf("Skill 名称只能包含小写字母、数字和连字符")
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
