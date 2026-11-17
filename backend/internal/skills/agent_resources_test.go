package skills

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestAgentSkillStreamingPaginationAndNoArtificialCaps(t *testing.T) {
	s, _ := agentSkillFixture(t)

	// Normal <=50KiB skill returns exact full text with nil Pagination.
	normalBody := "---\nname: 导演\ndescription: 正常长度测试\n---\n" + strings.Repeat("镜头规则说明\n", 800)
	normalPin := installAgentSkill(t, s, map[string]string{"SKILL.md": normalBody})
	if _, err := s.ValidateAgentSkills("owner", []Pin{normalPin}); err != nil {
		t.Fatalf("normal skill rejected: %v", err)
	}
	normalRes, err := s.AgentVersion("owner", normalPin)
	if err != nil || normalRes.Instruction != normalBody || normalRes.Pagination != nil {
		t.Fatalf("normal skill altered: err=%v pagination=%+v", err, normalRes.Pagination)
	}

	// Single oversized line (>50KiB) slices cleanly on UTF-8 boundary without rejecting.
	singleLineBody := "---\nname: 单行长文本\ndescription: UTF-8 截断测试\n---\n" + strings.Repeat("🎬镜头", 16000)
	singlePin := installAgentSkill(t, s, map[string]string{"SKILL.md": singleLineBody})
	singlePage, err := s.AgentFile("owner", singlePin, "SKILL.md", SkillReadOptions{Offset: 5})
	if err != nil {
		t.Fatalf("oversized single line failed: %v", err)
	}
	if !utf8.ValidString(singlePage.Content) || len(singlePage.Content) > DefaultSkillPageMaxBytes {
		t.Fatalf("invalid UTF-8 or exceeded page byte cap: len=%d", len(singlePage.Content))
	}
	if singlePage.Pagination == nil || !singlePage.Pagination.Truncated || !singlePage.Pagination.FirstLineExceedsLimit || singlePage.Pagination.StartLine != 5 {
		t.Fatalf("unexpected single-line pagination: %+v", singlePage.Pagination)
	}

	// Multi-MiB SKILL.md (>3 MiB) + multi-MiB auxiliary file + >4 skills in one turn all succeed via streaming pagination.
	var bigLines strings.Builder
	bigLines.WriteString("---\nname: 百万字语料技能\ndescription: 无上限流式分页验证\n---\n")
	const bodyLines = 45000
	for i := 1; i <= bodyLines; i++ {
		fmt.Fprintf(&bigLines, "第%05d行：跨块UTF-8校验与按行流式读取验证——春风十里扬州路🎬\n", i)
	}
	bigText := bigLines.String()
	if len(bigText) <= 3<<20 {
		t.Fatalf("expected >3 MiB fixture, got %d bytes", len(bigText))
	}
	bigPin := installAgentSkill(t, s, map[string]string{
		"SKILL.md":             bigText,
		"references/corpus.md": bigText,
	})
	pins := []Pin{normalPin, singlePin, bigPin}
	for i := 0; i < 3; i++ {
		extra := installAgentSkill(t, s, map[string]string{
			"SKILL.md": fmt.Sprintf("---\nname: 组合技能%d\ndescription: 多技能无数量上限\n---\n规则%d", i+1, i+1),
		})
		pins = append(pins, extra)
	}
	if len(pins) <= 4 {
		t.Fatal("expected >4 pins")
	}
	validated, err := s.ValidateAgentSkills("owner", pins)
	if err != nil || len(validated) != len(pins) {
		t.Fatalf("multi-skill / multi-MiB selection failed: len=%d err=%v", len(validated), err)
	}

	resPage1, err := s.AgentVersion("owner", bigPin)
	if err != nil {
		t.Fatalf("AgentVersion on >3 MiB skill failed: %v", err)
	}
	if resPage1.Pagination == nil || !resPage1.Pagination.Truncated || resPage1.Pagination.StartLine != 1 || resPage1.Pagination.TotalLines != bodyLines+4 {
		t.Fatalf("unexpected AgentVersion pagination: %+v", resPage1.Pagination)
	}
	if len(resPage1.Instruction) > DefaultSkillPageMaxBytes || !utf8.ValidString(resPage1.Instruction) {
		t.Fatalf("page 1 exceeded cap or broke UTF-8: len=%d", len(resPage1.Instruction))
	}

	nextOffset := resPage1.Pagination.EndLine + 1
	auxPage2, err := s.AgentFile("owner", bigPin, "references/corpus.md", SkillReadOptions{Offset: nextOffset, Limit: 50})
	if err != nil {
		t.Fatalf("AgentFile page 2 failed: %v", err)
	}
	if auxPage2.Pagination == nil || auxPage2.Pagination.StartLine != nextOffset || auxPage2.Pagination.EndLine != nextOffset+49 || !auxPage2.Pagination.Truncated {
		t.Fatalf("unexpected page 2 pagination: %+v", auxPage2.Pagination)
	}
	wantFirstLine := fmt.Sprintf("第%05d行：", nextOffset-4)
	if !strings.HasPrefix(auxPage2.Content, wantFirstLine) {
		t.Fatalf("page 2 line drift: got prefix %q, want %q", auxPage2.Content[:min(40, len(auxPage2.Content))], wantFirstLine)
	}

	tailPage, err := s.AgentFile("owner", bigPin, "references/corpus.md", SkillReadOptions{Offset: bodyLines + 4, Limit: 10})
	if err != nil || tailPage.Pagination == nil || tailPage.Pagination.Truncated || !strings.Contains(tailPage.Content, fmt.Sprintf("第%05d行：", bodyLines)) {
		t.Fatalf("tail page mismatch: page=%+v err=%v", tailPage, err)
	}
	beyondEOF, err := s.AgentFile("owner", bigPin, "references/corpus.md", SkillReadOptions{Offset: bodyLines + 100})
	if err != nil || beyondEOF.Content != "" || beyondEOF.Pagination == nil || beyondEOF.Pagination.StartLine != bodyLines+100 {
		t.Fatalf("beyond-EOF read mismatch: %+v err=%v", beyondEOF, err)
	}

	// Asset-heavy skill (small SKILL.md + truly incompressible multi-MiB sibling binary asset)
	// serves cached pages in O(1) with zero os.Open calls on cache hits across all platforms.
	heavyAsset := make([]byte, 8<<20)
	if _, err := rand.Read(heavyAsset); err != nil {
		t.Fatal(err)
	}
	assetHeavyBody := "---\nname: 附件大包技能\ndescription: 小正文配大体积二进制附件\n---\n" + strings.Repeat("只读两千字节指令正文\n", 40)
	assetHeavyPin := installAgentSkillBytes(t, s, map[string][]byte{
		"SKILL.md":        []byte(assetHeavyBody),
		"assets/demo.mp4": heavyAsset,
	})
	heavyZipPath := filepath.Join(s.dataDir, "skill-packages", assetHeavyPin.SkillID, assetHeavyPin.VersionID+".zip")
	heavyStat, err := os.Stat(heavyZipPath)
	if err != nil || heavyStat.Size() < 8<<20 {
		t.Fatalf("expected incompressible >8 MiB stored archive on disk, got size=%d err=%v", heavyStat.Size(), err)
	}
	firstHeavy, err := s.AgentVersion("owner", assetHeavyPin)
	if err != nil || firstHeavy.Instruction != assetHeavyBody {
		t.Fatalf("asset-heavy cold read failed: err=%v", err)
	}
	hitsBefore := s.verifiedCache.hits.Load()
	missesBefore := s.verifiedCache.misses.Load()
	opensBefore := s.verifiedCache.opens.Load()
	for i := 0; i < 20; i++ {
		again, err := s.AgentVersion("owner", assetHeavyPin)
		if err != nil || again.Instruction != assetHeavyBody {
			t.Fatalf("asset-heavy cached read %d failed: %v", i, err)
		}
	}
	gotHits := s.verifiedCache.hits.Load() - hitsBefore
	gotMisses := s.verifiedCache.misses.Load() - missesBefore
	gotOpens := s.verifiedCache.opens.Load() - opensBefore
	if gotHits != 20 || gotMisses != 0 || gotOpens != 0 {
		t.Fatalf("expected 20 cache hits, 0 misses, and 0 archive opens, got hits=%d misses=%d opens=%d", gotHits, gotMisses, gotOpens)
	}

	// Tampering with a warmed ZIP on disk (even preserving exact file size, mtime, and
	// central-directory CRC32) never leaks tampered bytes: warmed pages return the immutable
	// SHA-256-verified slice, uncached pages fail full-entry SHA-256 verification with 409,
	// and a missing/unmounted archive fails os.Stat with 400.
	var varied strings.Builder
	varied.WriteString("---\nname: 防篡改测试\ndescription: 压缩包摘要校验\n---\n")
	for i := 1; i <= 120; i++ {
		fmt.Fprintf(&varied, "原始安全规则第%03d条-%d\n", i, (i*7919)%9973)
	}
	origBody := varied.String()
	tamperPin := installAgentSkill(t, s, map[string]string{"SKILL.md": origBody})
	if _, err := s.AgentVersion("owner", tamperPin); err != nil {
		t.Fatalf("pre-tamper read failed: %v", err)
	}
	zipPath := filepath.Join(s.dataDir, "skill-packages", tamperPin.SkillID, tamperPin.VersionID+".zip")
	origStat, err := os.Stat(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	origZip, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	tamperedBody := "---\nname: 防篡改测试\ndescription: 压缩包摘要校验\n---\n" + strings.Repeat("B", len(origBody)-len("---\nname: 防篡改测试\ndescription: 压缩包摘要校验\n---\n"))
	buildTamperedZip := func(comment string) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		fw, err := zw.Create("SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(fw, tamperedBody); err != nil {
			t.Fatal(err)
		}
		if err := zw.SetComment(comment); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	baseTampered := buildTamperedZip("")
	if len(baseTampered) > len(origZip) {
		t.Fatalf("expected compressible tampered zip (%d) <= original zip (%d)", len(baseTampered), len(origZip))
	}
	forgedZip := buildTamperedZip(strings.Repeat("x", len(origZip)-len(baseTampered)))
	origCD := bytes.Index(origZip, []byte("PK\x01\x02"))
	forgedCD := bytes.Index(forgedZip, []byte("PK\x01\x02"))
	if origCD < 0 || forgedCD < 0 || len(forgedZip) != len(origZip) {
		t.Fatalf("failed to forge matching zip geometry: orig=%d forged=%d", len(origZip), len(forgedZip))
	}
	copy(forgedZip[forgedCD+16:forgedCD+20], origZip[origCD+16:origCD+20])
	if err := os.WriteFile(zipPath, forgedZip, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(zipPath, origStat.ModTime(), origStat.ModTime()); err != nil {
		t.Fatal(err)
	}
	cachedAfterTamper, err := s.AgentVersion("owner", tamperPin)
	if err != nil || cachedAfterTamper.Instruction != origBody {
		t.Fatalf("cached page must return immutable verified origBody rather than tampered disk bytes: err=%v", err)
	}
	_, uncachedTamperErr := s.AgentFile("owner", tamperPin, "SKILL.md", SkillReadOptions{Offset: 2, Limit: 5})
	var appErr *kernel.AppError
	if !errors.As(uncachedTamperErr, &appErr) || appErr.Status != 409 {
		t.Fatalf("expected 409 integrity rejection on uncached page of forged zip, got %#v", uncachedTamperErr)
	}
	if err := os.Remove(zipPath); err != nil {
		t.Fatal(err)
	}
	if _, missingErr := s.AgentVersion("owner", tamperPin); !errors.Is(missingErr, os.ErrNotExist) {
		t.Fatalf("expected missing archive path to fail os.Stat even when cached, got %#v", missingErr)
	}
}

func agentSkillFixture(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "skills.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	raw, _ := db.DB()
	t.Cleanup(func() { raw.Close() })
	return New(repository.New(db), t.TempDir(), nil), db
}

func installAgentSkill(t *testing.T, s *Service, files map[string]string) Pin {
	t.Helper()
	raw := make(map[string][]byte, len(files))
	for name, content := range files {
		raw[name] = []byte(content)
	}
	return installAgentSkillBytes(t, s, raw)
}

func installAgentSkillBytes(t *testing.T, s *Service, files map[string][]byte) Pin {
	t.Helper()
	var packageBytes bytes.Buffer
	zw := zip.NewWriter(&packageBytes)
	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	zw.Close()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, _ := form.CreateFormFile("file", "user-skill.zip")
	file.Write(packageBytes.Bytes())
	form.Close()
	request := httptest.NewRequest("POST", "/skills/install", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.ParseMultipartForm(20 << 20)
	defer request.MultipartForm.RemoveAll()
	header := request.MultipartForm.File["file"][0]
	installed, err := s.InstallSkillUpload("owner", "zip", header, SkillInstallRequest{IsPrivate: true})
	if err != nil {
		t.Fatal(err)
	}
	return Pin{SkillID: installed.SkillID, VersionID: installed.VersionID, ContentHash: installed.ContentHash}
}

func TestInstalledUserSkillTasksUsePinnedBodyAndAuxiliaryFiles(t *testing.T) {
	s, _ := agentSkillFixture(t)
	cases := []struct {
		name, body, reference, path string
		scriptSupported             bool
		unsupportedCap              string
	}{
		{"咖啡短片分镜", "读取 references/shots.md，为三个段落各建一个草稿镜头，不生成。", "磨豆；手冲；甜点", "references/shots.md", false, ""},
		{"采访切片", "读取 references/interview.md，只使用原话标出保留区间，禁止编造采访。", "00:02-00:06 主人公说：每天练习。", "references/interview.md", false, ""},
		{"声音审片Python", "读取 scripts/listen.py；需要运行脚本时提交确认。", "print('audio ok')", "scripts/listen.py", true, ""},
		{"脚本目录单数", "读取 script/run.js；需要运行脚本时提交确认。", "console.log('ok')", "script/run.js", true, ""},
		{"不支持的脚本解释器", "读取 scripts/legacy.txt；不支持的解释器明确提示。", "puts 'unsupported'", "scripts/legacy.txt", false, "unsupported_script_interpreter"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: " + tc.name + "\ndescription: 用户上传的创作流程\n---\n" + tc.body, tc.path: tc.reference})
			if _, err := s.ValidateAgentSkills("owner", []Pin{pin}); err != nil {
				t.Fatal(err)
			}
			resource, err := s.AgentVersion("owner", pin)
			if err != nil {
				t.Fatal(err)
			}
			file, err := s.AgentFile("owner", pin, tc.path)
			if err != nil || file.Content != tc.reference {
				t.Fatalf("file=%+v err=%v", file, err)
			}
			if file.ExecutionSupported != tc.scriptSupported {
				t.Fatalf("ExecutionSupported=%v, want %v", file.ExecutionSupported, tc.scriptSupported)
			}
			if tc.unsupportedCap == "" && len(resource.UnsupportedCapabilities) != 0 {
				t.Fatalf("unexpected UnsupportedCapabilities=%v", resource.UnsupportedCapabilities)
			}
			if tc.unsupportedCap != "" && (len(resource.UnsupportedCapabilities) != 1 || resource.UnsupportedCapabilities[0] != tc.unsupportedCap) {
				t.Fatalf("UnsupportedCapabilities=%v, want [%s]", resource.UnsupportedCapabilities, tc.unsupportedCap)
			}
			if _, err := s.AgentVersion("foreign", pin); err == nil {
				t.Fatal("private package leaked")
			}
			for _, path := range []string{"../SKILL.md", "/etc/passwd", "references/missing.md"} {
				if _, err := s.AgentFile("owner", pin, path); err == nil {
					t.Fatalf("path accepted %s", path)
				}
			}
		})
	}
}

func TestSkillPinUpdateRestartUninstallAndCorruption(t *testing.T) {
	s, db := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "# 原版\n\n保留原始拍摄要求。", "references/shot.md": "旧版镜头"})
	skill, _ := s.ownedSkill("owner", pin.SkillID)
	archive, _ := archiveFromZip(skillZip(t, map[string]string{"SKILL.md": "# 新版\n\n改用新版要求。", "references/shot.md": "新版镜头"}), "")
	if err := s.addSkillArchiveVersion(skill, archive, "zip", "", "", "", "", false); err != nil {
		t.Fatal(err)
	}
	reopened := New(repository.New(db), s.dataDir, nil)
	old, err := reopened.AgentFile("owner", pin, "references/shot.md")
	if err != nil || old.Content != "旧版镜头" {
		t.Fatalf("pinned version drifted %v %+v", err, old)
	}
	wrong := pin
	wrong.ContentHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := s.AgentVersion("owner", wrong); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	other := installAgentSkill(t, s, map[string]string{"SKILL.md": "# 另一个\n\n描述"})
	wrong = pin
	wrong.VersionID = other.VersionID
	if _, err := s.AgentVersion("owner", wrong); err == nil {
		t.Fatal("foreign skill version accepted")
	}
	db.Model(&model.SkillFile{}).Where("skill_version_id = ? AND path = ?", pin.VersionID, "references/shot.md").Update("sha256", other.ContentHash)
	if _, err := s.AgentFile("owner", pin, "references/shot.md"); err == nil {
		t.Fatal("corrupt auxiliary accepted")
	}
	skill.IsPrivate = false
	if err := s.repo.SaveSkill(skill); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkillAdded("consumer", pin.SkillID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkillAdded("consumer", pin.SkillID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.AgentVersion("consumer", pin); err == nil {
		t.Fatal("uninstalled pin resumed")
	}
}
