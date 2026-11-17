package skills

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/skillhub"
)

// Pin is the exact installed package selected by the user for a business round.
// Instructions are loaded on demand, never persisted as an alternate package.
type Pin struct {
	SkillID     string `json:"skillId"`
	VersionID   string `json:"versionId"`
	ContentHash string `json:"contentHash"`
	// SkillName and Version are display labels captured by ValidateAgentSkills,
	// so a round still names its skill after the package is uninstalled.
	// They never take part in identity or authorization.
	SkillName string `json:"skillName,omitempty"`
	Version   string `json:"version,omitempty"`
}

// Identity drops display labels; compare pins only through it.
func (p Pin) Identity() Pin {
	return Pin{SkillID: p.SkillID, VersionID: p.VersionID, ContentHash: p.ContentHash}
}

type SkillReadOptions struct {
	Offset   int
	Limit    int
	MaxLines int
	MaxBytes int
	Unpaged  bool
}

type verifiedSkillPage struct {
	content    string
	pagination *SkillTextPagination
}

type skillArchiveVerifyCache struct {
	mu         sync.RWMutex
	entries    map[string]verifiedSkillPage
	totalBytes int
	hits       atomic.Uint64
	misses     atomic.Uint64
	opens      atomic.Uint64
}

func newSkillArchiveVerifyCache() *skillArchiveVerifyCache {
	return &skillArchiveVerifyCache{entries: make(map[string]verifiedSkillPage, 64)}
}

func cloneSkillPagination(p *SkillTextPagination) *SkillTextPagination {
	if p == nil {
		return nil
	}
	cp := *p
	return &cp
}

func (s *Service) lookupVerifiedSkillPage(key string) (string, *SkillTextPagination, bool) {
	if s == nil || s.verifiedCache == nil {
		return "", nil, false
	}
	s.verifiedCache.mu.RLock()
	entry, ok := s.verifiedCache.entries[key]
	s.verifiedCache.mu.RUnlock()
	if !ok {
		s.verifiedCache.misses.Add(1)
		return "", nil, false
	}
	s.verifiedCache.hits.Add(1)
	return entry.content, cloneSkillPagination(entry.pagination), true
}

func (s *Service) storeVerifiedSkillPage(key string, content string, pagination *SkillTextPagination) {
	if s == nil || s.verifiedCache == nil || len(content) > DefaultSkillPageMaxBytes {
		return
	}
	s.verifiedCache.mu.Lock()
	if len(s.verifiedCache.entries) >= 128 || s.verifiedCache.totalBytes+len(content) > 4<<20 {
		clear(s.verifiedCache.entries)
		s.verifiedCache.totalBytes = 0
	}
	if prev, exists := s.verifiedCache.entries[key]; exists {
		s.verifiedCache.totalBytes -= len(prev.content)
	}
	s.verifiedCache.entries[key] = verifiedSkillPage{
		content:    content,
		pagination: cloneSkillPagination(pagination),
	}
	s.verifiedCache.totalBytes += len(content)
	s.verifiedCache.mu.Unlock()
}

type SkillTextPagination struct {
	StartLine             int  `json:"startLine"`
	EndLine               int  `json:"endLine"`
	TotalLines            int  `json:"totalLines"`
	Truncated             bool `json:"truncated"`
	FirstLineExceedsLimit bool `json:"firstLineExceedsLimit,omitempty"`
	FirstLineBytes        int  `json:"firstLineBytes,omitempty"`
}

type AgentResource struct {
	Pin                     Pin                    `json:"pin"`
	Name                    string                 `json:"name"`
	Description             string                 `json:"description"`
	Version                 string                 `json:"version"`
	Instruction             string                 `json:"instruction"`
	Pagination              *SkillTextPagination   `json:"pagination,omitempty"`
	Files                   []SkillPackageFileItem `json:"files"`
	UnsupportedCapabilities []string               `json:"unsupportedCapabilities"`
}

type AgentFile struct {
	Pin                Pin                  `json:"pin"`
	File               SkillPackageFileItem `json:"file"`
	Content            string               `json:"content"`
	Pagination         *SkillTextPagination `json:"pagination,omitempty"`
	ExecutionSupported bool                 `json:"executionSupported"`
}

var agentSkillIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

const (
	DefaultSkillPageMaxLines = 2000
	DefaultSkillPageMaxBytes = 50 * 1024
)

// Requirements belong to the selected immutable version, not the current
// package or a model-supplied declaration.
func (s *Service) AgentRequirements(userID string, pin Pin) ([]string, error) {
	_, version, _, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	release, err := marketReleaseMetadata(version.MarketReleaseJSON)
	if err != nil || release == nil {
		return nil, err
	}
	return release.Requirements, nil
}

func ValidatePin(pin Pin) error {
	if !agentSkillIDPattern.MatchString(pin.SkillID) || !agentSkillIDPattern.MatchString(pin.VersionID) || len(pin.ContentHash) != 64 {
		return kernel.BadAuthRequest("技能选择必须包含技能、版本和内容摘要")
	}
	if _, err := hex.DecodeString(pin.ContentHash); err != nil || strings.ToLower(pin.ContentHash) != pin.ContentHash {
		return kernel.BadAuthRequest("技能内容摘要无效")
	}
	return nil
}

func (s *Service) agentPackage(userID string, pin Pin) (*model.Skill, *model.SkillVersion, []model.SkillFile, error) {
	if err := ValidatePin(pin); err != nil {
		return nil, nil, nil, err
	}
	if s == nil || s.repo == nil || strings.TrimSpace(userID) == "" {
		return nil, nil, nil, kernel.Forbidden("无法读取当前用户技能")
	}
	skill, err := s.visibleSkill(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	state, err := s.repo.UserSkillState(userID, pin.SkillID)
	if err != nil {
		return nil, nil, nil, err
	}
	if skill.Status != skillStatusEnabled || state == nil || !state.Added {
		return nil, nil, nil, kernel.Forbidden("技能已停用或未安装，请重新选择可用技能")
	}
	version, err := s.repo.SkillVersion(pin.VersionID)
	if err != nil || version.SkillID != pin.SkillID {
		return nil, nil, nil, kernel.WrapAppError(400, "所选技能版本不存在", err)
	}
	if version.ContentHash != pin.ContentHash {
		return nil, nil, nil, kernel.NewAppError(409, "技能版本内容已变化，请重新选择")
	}
	if version.PackageKey != path.Join(pin.SkillID, pin.VersionID+".zip") {
		return nil, nil, nil, kernel.Forbidden("技能包位置无效")
	}
	files, err := s.repo.SkillFiles(version.ID)
	return skill, version, files, err
}

func IsSkillScriptPath(filePath string) bool {
	normalized, err := normalizeSkillPath(filePath)
	if err != nil || normalized != filePath {
		return false
	}
	for _, prefix := range []string{skillhub.ScriptsPrefix, skillhub.AltScriptsPrefix} {
		if strings.HasPrefix(normalized, prefix) {
			return len(normalized) > len(prefix)
		}
	}
	return false
}

func SkillScriptInterpreter(filePath string) (string, bool) {
	if !IsSkillScriptPath(filePath) {
		return "", false
	}
	switch strings.ToLower(path.Ext(filePath)) {
	case ".py":
		return "python3", true
	case ".sh", ".bash":
		return "bash", true
	case ".js", ".mjs", ".cjs":
		return "node", true
	default:
		return "", false
	}
}

func resolveSkillReadOptions(opts []SkillReadOptions) SkillReadOptions {
	if len(opts) == 0 {
		return SkillReadOptions{}
	}
	return opts[0]
}

func (s *Service) AgentVersion(userID string, pin Pin, opts ...SkillReadOptions) (*AgentResource, error) {
	pin = pin.Identity()
	skill, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	result := &AgentResource{Pin: pin, Name: skill.Name, Description: skill.Description, Version: version.VersionLabel, Files: []SkillPackageFileItem{}, UnsupportedCapabilities: []string{}}
	seenUnsupported := false
	for _, file := range files {
		result.Files = append(result.Files, skillFileItem(file))
		if IsSkillScriptPath(file.Path) {
			if _, ok := SkillScriptInterpreter(file.Path); !ok && !seenUnsupported {
				seenUnsupported = true
				result.UnsupportedCapabilities = append(result.UnsupportedCapabilities, "unsupported_script_interpreter")
			}
		}
	}
	entry, err := s.readAgentPackageFile(pin, version, files, version.EntryPath, resolveSkillReadOptions(opts))
	if err != nil {
		return nil, err
	}
	result.Instruction = entry.Content
	result.Pagination = entry.Pagination
	return result, nil
}

func (s *Service) AgentFile(userID string, pin Pin, filePath string, opts ...SkillReadOptions) (*AgentFile, error) {
	pin = pin.Identity()
	_, version, files, err := s.agentPackage(userID, pin)
	if err != nil {
		return nil, err
	}
	return s.readAgentPackageFile(pin, version, files, filePath, resolveSkillReadOptions(opts))
}

func (s *Service) readAgentPackageFile(pin Pin, version *model.SkillVersion, files []model.SkillFile, filePath string, opts SkillReadOptions) (*AgentFile, error) {
	normalized, err := normalizeSkillPath(filePath)
	if err != nil {
		return nil, err
	}
	if normalized != filePath {
		return nil, kernel.BadAuthRequest("技能文件路径必须是包内相对路径")
	}
	for _, file := range files {
		if file.Path != normalized {
			continue
		}
		if !isPreviewText(file.MimeType, file.Path) {
			return nil, kernel.BadAuthRequest("辅助文件只支持 UTF-8 文本")
		}
		content, pagination, err := s.readSkillArchiveTextPage(version, file, opts)
		if err != nil {
			return nil, err
		}
		_, supported := SkillScriptInterpreter(normalized)
		return &AgentFile{
			Pin:                pin,
			File:               skillFileItem(file),
			Content:            content,
			Pagination:         pagination,
			ExecutionSupported: IsSkillScriptPath(normalized) && supported,
		}, nil
	}
	return nil, kernel.BadAuthRequest("这个文件不在所选技能版本中")
}

// readSkillArchiveTextPage streams only the target ZIP entry in O(page) memory
// while verifying full-file byte count, UTF-8 validity, and SHA-256 integrity,
// and caches immutable verified page slices keyed by version and entry SHA-256.
func (s *Service) readSkillArchiveTextPage(version *model.SkillVersion, file model.SkillFile, opts SkillReadOptions) (string, *SkillTextPagination, error) {
	maxLines := opts.MaxLines
	if maxLines <= 0 {
		maxLines = DefaultSkillPageMaxLines
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultSkillPageMaxBytes
	}
	explicitRange := opts.Offset > 0 || opts.Limit > 0
	startIdx := 0
	if opts.Offset > 1 {
		startIdx = opts.Offset - 1
	}
	requestedLines := maxLines
	if opts.Limit > 0 && opts.Limit < maxLines {
		requestedLines = opts.Limit
	}

	absolute := filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(version.PackageKey))
	zipStat, err := os.Stat(absolute)
	if err != nil {
		return "", nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
	}

	var pageKey string
	if !opts.Unpaged {
		pageKey = version.ID + "\x00" + version.PackageKey + "\x00" + version.ContentHash + "\x00" + file.Path + "\x00" + file.SHA256 + "\x00" + strconv.FormatInt(file.Size, 10) + "\x00" + strconv.Itoa(startIdx) + "\x00" + strconv.Itoa(requestedLines) + "\x00" + strconv.Itoa(maxLines) + "\x00" + strconv.Itoa(maxBytes) + "\x00" + strconv.FormatBool(explicitRange)
		if content, pagination, ok := s.lookupVerifiedSkillPage(pageKey); ok {
			return content, pagination, nil
		}
	}

	if s != nil && s.verifiedCache != nil {
		s.verifiedCache.opens.Add(1)
	}
	f, err := os.Open(absolute)
	if err != nil {
		return "", nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
	}
	defer f.Close()

	reader, err := zip.NewReader(f, zipStat.Size())
	if err != nil {
		return "", nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
	}

	var target *zip.File
	for _, entry := range reader.File {
		if entry.Name == file.Path {
			target = entry
			break
		}
	}
	if target == nil {
		return "", nil, kernel.BadAuthRequest("技能文件不存在")
	}

	rc, err := target.Open()
	if err != nil {
		return "", nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", err)
	}
	defer rc.Close()

	if file.Size < 0 || file.Size > maxSkillPackageBytes {
		return "", nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
	}

	hasher := sha256.New()
	var (
		totalBytes            int64
		validUTF8             = true
		utf8Carry             [utf8.UTFMax]byte
		carryLen              int
		fullOut               strings.Builder
		rawPrefix             bytes.Buffer
		out                   strings.Builder
		lineBuf               bytes.Buffer
		lineIdx               int
		curLineBytes          int
		lastByteWasNewline    bool
		pickedLines           int
		outBytes              int
		capturing             = true
		firstLineExceedsLimit bool
		firstLineBytes        int
	)
	if opts.Unpaged {
		fullOut.Grow(int(file.Size))
	}

	finishLine := func() {
		if lineIdx >= startIdx && capturing {
			sep := 0
			if pickedLines > 0 {
				sep = 1
			}
			if outBytes+sep+curLineBytes <= maxBytes {
				if pickedLines > 0 {
					out.WriteByte('\n')
				}
				out.Write(lineBuf.Bytes())
				outBytes += sep + curLineBytes
				pickedLines++
				if pickedLines >= requestedLines {
					capturing = false
				}
			} else if pickedLines == 0 {
				prefix := cutUTF8Prefix(lineBuf.Bytes(), maxBytes)
				out.Write(prefix)
				outBytes = len(prefix)
				pickedLines = 1
				firstLineExceedsLimit = true
				firstLineBytes = curLineBytes
				capturing = false
			} else {
				capturing = false
			}
		}
		lineBuf.Reset()
		curLineBytes = 0
	}

	var buf [32 * 1024]byte
	for {
		n, readErr := rc.Read(buf[:])
		if n > 0 {
			chunk := buf[:n]
			totalBytes += int64(n)
			if totalBytes > maxSkillPackageBytes {
				return "", nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
			}
			_, _ = hasher.Write(chunk)

			if validUTF8 {
				sub := chunk
				for carryLen > 0 && len(sub) > 0 {
					utf8Carry[carryLen] = sub[0]
					carryLen++
					sub = sub[1:]
					if utf8.FullRune(utf8Carry[:carryLen]) {
						r, width := utf8.DecodeRune(utf8Carry[:carryLen])
						if r == utf8.RuneError && width == 1 {
							validUTF8 = false
						}
						carryLen = 0
						break
					}
				}
				if validUTF8 && len(sub) > 0 {
					complete, rest := splitIncompleteUTF8Tail(sub)
					if !utf8.Valid(complete) {
						validUTF8 = false
					} else if len(rest) > 0 {
						copy(utf8Carry[:], rest)
						carryLen = len(rest)
					}
				}
			}

			if opts.Unpaged {
				_, _ = fullOut.Write(chunk)
			} else {
				if !explicitRange && rawPrefix.Len() <= maxBytes {
					keep := (maxBytes + 1) - rawPrefix.Len()
					if keep > len(chunk) {
						keep = len(chunk)
					}
					_, _ = rawPrefix.Write(chunk[:keep])
				}

				rem := chunk
				for len(rem) > 0 {
					nl := bytes.IndexByte(rem, '\n')
					seg := rem
					if nl >= 0 {
						seg = rem[:nl]
					}
					if len(seg) > 0 {
						curLineBytes += len(seg)
						lastByteWasNewline = false
						if lineIdx >= startIdx && capturing && lineBuf.Len() < maxBytes+utf8.UTFMax {
							space := (maxBytes + utf8.UTFMax) - lineBuf.Len()
							if space > len(seg) {
								space = len(seg)
							}
							_, _ = lineBuf.Write(seg[:space])
						}
					}
					if nl < 0 {
						break
					}
					finishLine()
					lineIdx++
					lastByteWasNewline = true
					rem = rem[nl+1:]
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if errors.Is(readErr, zip.ErrChecksum) {
				return "", nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
			}
			return "", nil, kernel.WrapAppError(400, "所选技能版本文件不可读取，请重新安装或选择可用版本", readErr)
		}
	}

	if carryLen > 0 {
		validUTF8 = false
	}
	if !validUTF8 || totalBytes != file.Size || hex.EncodeToString(hasher.Sum(nil)) != file.SHA256 {
		return "", nil, kernel.NewAppError(409, "技能文件内容校验失败，请重新选择")
	}
	if opts.Unpaged {
		return fullOut.String(), nil, nil
	}

	totalLines := 0
	if totalBytes > 0 {
		if lastByteWasNewline {
			totalLines = lineIdx
		} else {
			finishLine()
			totalLines = lineIdx + 1
		}
	}
	if !explicitRange && !firstLineExceedsLimit && totalLines <= maxLines && file.Size <= int64(maxBytes) {
		text := rawPrefix.String()
		s.storeVerifiedSkillPage(pageKey, text, nil)
		return text, nil, nil
	}
	startLine := startIdx + 1
	var resultContent string
	var resultPagination *SkillTextPagination
	if totalLines == 0 {
		resultPagination = &SkillTextPagination{StartLine: startLine, EndLine: 0, TotalLines: 0, Truncated: false}
	} else if startIdx >= totalLines {
		resultPagination = &SkillTextPagination{StartLine: startLine, EndLine: totalLines, TotalLines: totalLines, Truncated: false}
	} else {
		endLine := startIdx + pickedLines
		truncated := firstLineExceedsLimit || endLine < totalLines
		resultContent = out.String()
		resultPagination = &SkillTextPagination{
			StartLine:             startLine,
			EndLine:               endLine,
			TotalLines:            totalLines,
			Truncated:             truncated,
			FirstLineExceedsLimit: firstLineExceedsLimit,
			FirstLineBytes:        firstLineBytes,
		}
	}
	s.storeVerifiedSkillPage(pageKey, resultContent, resultPagination)
	return resultContent, cloneSkillPagination(resultPagination), nil
}

func splitIncompleteUTF8Tail(b []byte) ([]byte, []byte) {
	maxTail := utf8.UTFMax - 1
	if len(b) < maxTail {
		maxTail = len(b)
	}
	for k := 1; k <= maxTail; k++ {
		idx := len(b) - k
		if utf8.RuneStart(b[idx]) {
			if !utf8.FullRune(b[idx:]) {
				return b[:idx], b[idx:]
			}
			return b, nil
		}
	}
	return b, nil
}

func cutUTF8Prefix(b []byte, limit int) []byte {
	if len(b) <= limit {
		return b
	}
	end := limit
	for end > 0 && !utf8.RuneStart(b[end]) {
		end--
	}
	return b[:end]
}

func (s *Service) ValidateAgentSkills(userID string, pins []Pin) ([]Pin, error) {
	seen := map[string]bool{}
	result := make([]Pin, 0, len(pins))
	for _, pin := range pins {
		if seen[pin.SkillID] {
			return nil, kernel.BadAuthRequest("同一轮不能选择同一技能的多个版本")
		}
		seen[pin.SkillID] = true
		resource, err := s.AgentVersion(userID, pin)
		if err != nil {
			return nil, err
		}
		labeled := pin.Identity()
		labeled.SkillName = resource.Name
		labeled.Version = resource.Version
		result = append(result, labeled)
	}
	return result, nil
}

// AgentCatalogItem advertises one installed skill to the assistant by its
// current version. The model loads the full instructions on demand.
type AgentCatalogItem struct {
	Pin         Pin    `json:"pin"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// AgentCatalog lists the caller's installed, enabled skills at their current
// versions, in a stable order. Pins carry display labels; identity is exact.
func (s *Service) AgentCatalog(userID string) ([]AgentCatalogItem, error) {
	if s == nil || s.repo == nil || strings.TrimSpace(userID) == "" {
		return nil, kernel.Forbidden("无法读取当前用户技能")
	}
	items, err := s.AddedSkills(userID)
	if err != nil {
		return nil, err
	}
	result := []AgentCatalogItem{}
	for _, item := range items {
		pin := Pin{SkillID: item.SkillID, VersionID: item.VersionID, ContentHash: item.ContentHash}
		if item.Status != skillStatusEnabled || ValidatePin(pin) != nil {
			continue
		}
		state, err := s.repo.UserSkillState(userID, item.SkillID)
		if err != nil {
			return nil, err
		}
		if state == nil || !state.Added {
			continue
		}
		pin.SkillName = item.SkillName
		pin.Version = item.Version
		result = append(result, AgentCatalogItem{Pin: pin, Name: item.SkillName, Description: item.Description})
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Pin.SkillID < result[j].Pin.SkillID })
	return result, nil
}
