package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestArchiveFromMarkdownInfersMetadata(t *testing.T) {
	archive, err := archiveFromMarkdown([]byte("# 小说转分镜\n\n把小说段落拆成可拍摄的镜头。\n"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Name != "小说转分镜" || archive.Metadata.Description != "把小说段落拆成可拍摄的镜头。" {
		t.Fatalf("metadata = %#v", archive.Metadata)
	}
	if string(archive.Files["SKILL.md"]) == "" || archive.ContentHash == "" {
		t.Fatal("archive did not preserve the entry file or compute a hash")
	}
}

func TestArchiveFromZipNormalizesWrapperAndNestedFiles(t *testing.T) {
	data := skillZip(t, map[string]string{
		"director-main/SKILL.md":             "---\nname: AI 导演\ndescription: 导演工作流\nmetadata:\n  version: 2.1\n---\n",
		"director-main/references/camera.md": "# Camera",
		"director-main/scripts/check.js":     "export default true",
	})
	archive, err := archiveFromZip(data, "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Version != "2.1" || len(archive.Files) != 3 {
		t.Fatalf("archive = %#v", archive)
	}
	if string(archive.Files["references/camera.md"]) != "# Camera" {
		t.Fatalf("nested file missing: %#v", archive.Files)
	}
}

func TestArchiveFromZipRejectsTraversalAndMultipleSkills(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"traversal": {"../SKILL.md": "# Bad"},
		"multiple": {
			"one/SKILL.md": "# One\n\nFirst",
			"two/SKILL.md": "# Two\n\nSecond",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := archiveFromZip(skillZip(t, files), ""); err == nil {
				t.Fatal("expected package validation error")
			}
		})
	}
}

func TestParseGitHubSkillURL(t *testing.T) {
	spec, err := parseGitHubSkillURL("https://github.com/example/beeftv-skills/tree/main/skills/canvas-context", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Owner != "example" || spec.Repo != "beeftv-skills" || spec.Ref != "main" || spec.Subdir != "skills/canvas-context" {
		t.Fatalf("spec = %#v", spec)
	}
	if _, err := parseGitHubSkillURL("https://github.com/example/beeftv-skills/blob/main/SKILL.md", "", ""); err == nil {
		t.Fatal("expected blob URL to be rejected")
	}
}

func TestFetchGitHubSkillArchiveMirrorFallbackAndCommitVerification(t *testing.T) {
	wantSHA := strings.Repeat("a", 40)
	wrongSHA := strings.Repeat("b", 40)
	buildCommitZipWithBody := func(commitSHA string, includeComment bool, prefix string, body string) []byte {
		var buf bytes.Buffer
		w := zip.NewWriter(&buf)
		if includeComment {
			_ = w.SetComment(commitSHA)
		}
		entry, err := w.Create(prefix + "/skills/canvas-context/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = entry.Write([]byte(body))
		_ = w.Close()
		return buf.Bytes()
	}
	validBody := "---\nname: canvas-context\ndescription: 画布上下文技能\n---\n# 画布上下文技能\n\n读取画布说明。\n"
	buildCommitZip := func(commitSHA string) []byte {
		return buildCommitZipWithBody(commitSHA, true, "beeftv-skills-"+commitSHA, validBody)
	}

	urls := outbound.ExpandGitHubMirrorURLs("https://codeload.github.com/example/beeftv-skills/zip/"+wantSHA, "", wantSHA, "")
	if len(urls) < 3 || urls[0] != "https://codeload.github.com/example/beeftv-skills/zip/"+wantSHA || !strings.HasPrefix(urls[1], "https://gh-proxy.com/https://codeload.github.com/") {
		t.Fatalf("expected codeload origin first and China GitHub proxies as fallback, got %v", urls)
	}
	if err := verifyGitHubCommitZip(buildCommitZip(wrongSHA), wantSHA); err == nil {
		t.Fatal("expected tampered commit SHA zip to be rejected")
	}
	if err := verifyGitHubCommitZip(buildCommitZipWithBody(wantSHA, false, "beeftv-skills-"+wantSHA, validBody), wantSHA); err == nil {
		t.Fatal("expected zip without commit comment to be rejected")
	}
	if err := verifyGitHubCommitZip(buildCommitZipWithBody(wantSHA, true, "beeftv-skills", validBody), wantSHA); err == nil {
		t.Fatal("expected zip without -<40hex> directory suffix to be rejected")
	}
	validZip := buildCommitZip(wantSHA)
	zr, err := zip.NewReader(bytes.NewReader(validZip), int64(len(validZip)))
	if err != nil {
		t.Fatal(err)
	}
	treeSHA, err := computeGitZipTreeSHA(zr, "beeftv-skills-"+wantSHA)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyGitHubCommitZip(validZip, wantSHA, treeSHA); err != nil {
		t.Fatalf("expected matching commit+tree SHA zip to pass: %v", err)
	}
	tamperedBodyZip := buildCommitZipWithBody(wantSHA, true, "beeftv-skills-"+wantSHA, "---\nname: canvas-context\ndescription: tampered\n---\n# Tampered\n")
	if err := verifyGitHubCommitZip(tamperedBodyZip, wantSHA, treeSHA); err == nil {
		t.Fatal("expected zip with reused commitSHA suffix but tampered file content to fail tree SHA verification")
	}

	redirectTarget := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/example/beeftv-skills":
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case "/repos/example/beeftv-skills/commits/main":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"sha": wantSHA,
				"commit": map[string]any{
					"tree": map[string]any{"sha": treeSHA},
				},
			})
		case "/example/beeftv-skills/zip/" + wantSHA:
			if redirectTarget != "" {
				http.Redirect(w, r, redirectTarget, http.StatusFound)
				return
			}
			_, _ = w.Write(validZip)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	prevAPI, prevCodeload := githubAPIBaseURL, githubCodeloadBaseURL
	githubAPIBaseURL, githubCodeloadBaseURL = server.URL, server.URL
	t.Cleanup(func() {
		githubAPIBaseURL, githubCodeloadBaseURL = prevAPI, prevCodeload
	})

	archive, commit, canonicalURL, resolvedRef, err := fetchGitHubSkillArchive(context.Background(), githubSkillSpec{
		Owner:  "example",
		Repo:   "beeftv-skills",
		Subdir: "canvas-context",
	})
	if err != nil {
		t.Fatalf("fetchGitHubSkillArchive failed: %v", err)
	}
	if commit != wantSHA || canonicalURL != "https://github.com/example/beeftv-skills" || resolvedRef != "main" || archive.Metadata.Name != "画布上下文技能" {
		t.Fatalf("unexpected archive metadata: commit=%s url=%s ref=%s name=%s", commit, canonicalURL, resolvedRef, archive.Metadata.Name)
	}

	for _, badRedirect := range []string{"http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data"} {
		redirectTarget = badRedirect
		if _, _, _, _, err := fetchGitHubSkillArchive(context.Background(), githubSkillSpec{
			Owner:  "example",
			Repo:   "beeftv-skills",
			Subdir: "canvas-context",
		}); err == nil {
			t.Fatalf("expected redirect to %s to be rejected", badRedirect)
		}
	}
}

func TestArchiveFromZipSubdirMatchingRejectsWrongRootAndMatchesRootWithNestedSkills(t *testing.T) {
	singleRootZip := skillZip(t, map[string]string{
		"repo-main/SKILL.md": "---\nname: real-skill\ndescription: Real root skill\n---\n# Real Skill\n",
	})
	if _, err := archiveFromZip(singleRootZip, "nonexistent"); err == nil || !strings.Contains(err.Error(), "GitHub 子目录不存在或为空") {
		t.Fatalf("expected nonexistent subdir on single-skill repo to fail, got %v", err)
	}
	if got, err := archiveFromZip(singleRootZip, "real-skill"); err != nil || got.Metadata.TechnicalName != "real-skill" {
		t.Fatalf("expected matching root skill ID to succeed, got %+v err=%v", got, err)
	}

	mixedZip := skillZip(t, map[string]string{
		"repo-main/SKILL.md":              "---\nname: root-skill\ndescription: Root skill\n---\n# Root Skill\n",
		"repo-main/references/guide.md":   "# Root Guide\n",
		"repo-main/examples/sub/SKILL.md": "---\nname: sub-skill\ndescription: Nested example\n---\n# Sub Skill\n",
	})
	rootArchive, err := archiveFromZip(mixedZip, "root-skill")
	if err != nil {
		t.Fatalf("expected root-skill subdir to match root SKILL.md even with nested skills, got %v", err)
	}
	if rootArchive.Metadata.TechnicalName != "root-skill" || string(rootArchive.Files["references/guide.md"]) != "# Root Guide\n" {
		t.Fatalf("unexpected rootArchive: %+v", rootArchive)
	}
	if _, exists := rootArchive.Files["examples/sub/SKILL.md"]; exists {
		t.Fatalf("expected nested skill to be excluded from root skill package: %+v", rootArchive.Files)
	}
}

func TestEnsureSkillPackagesMigratesAndRefreshesBuiltinSkills(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	svc := New(repository.New(db), t.TempDir(), nil)
	builtin := model.Skill{ID: kernel.NewID(), Name: "内置导演", Description: "内置工作流", Instruction: "# 内置导演\n\n第一版", Status: skillStatusEnabled, Source: 3}
	userSkill := model.Skill{ID: kernel.NewID(), Name: "用户技能", Description: "用户工作流", Instruction: "# 用户技能\n\n第一版", Status: skillStatusEnabled, Source: skillSourceUser}
	if err := db.Create(&builtin).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&userSkill).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := db.Model(&model.Skill{}).Where("id = ?", builtin.ID).Update("instruction", "# 内置导演\n\n第二版").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", userSkill.ID).Update("instruction", "# 用户技能\n\n不应在启动时重建").Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 2)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	var refreshed model.Skill
	if err := db.First(&refreshed, "id = ?", builtin.ID).Error; err != nil {
		t.Fatal(err)
	}
	wantArchive, err := archiveFromMarkdown([]byte(refreshed.Instruction), refreshed.Name, refreshed.Description)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.ContentHash != wantArchive.ContentHash || refreshed.CurrentVersionID == "" {
		t.Fatalf("builtin package was not refreshed: %#v", refreshed)
	}
}

func TestBuiltinSeedSkillsIncludeLuckyPlusOnePackagesAndAuxiliaryFiles(t *testing.T) {
	svc, db := agentSkillFixture(t)
	if err := db.AutoMigrate(&model.Workspace{}); err != nil {
		t.Fatalf("AutoMigrate Workspace: %v", err)
	}
	if err := db.Create(&model.Workspace{ID: "tester", Name: "测试工作区"}).Error; err != nil {
		t.Fatalf("Create Workspace: %v", err)
	}
	if err := svc.EnsureBuiltinSkills(); err != nil {
		t.Fatalf("EnsureBuiltinSkills: %v", err)
	}
	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatalf("EnsureSkillPackages: %v", err)
	}

	addedByDefault, err := svc.AddedSkills("tester")
	if err != nil {
		t.Fatalf("AddedSkills: %v", err)
	}
	if len(addedByDefault) != 3 {
		t.Fatalf("AddedSkills count = %d, want 3 default-added lucky加一 skills", len(addedByDefault))
	}

	expected := []struct {
		skillID   string
		skillName string
		version   string
		minFiles  int
		auxPaths  []string
	}{
		{
			skillID:   "novel-to-manju-agent",
			skillName: "小说改编漫剧 Agent",
			version:   "1.1.0",
			minFiles:  20,
			auxPaths:  []string{"references/dialogue.md", "references/requirements.md", "agents/director.md"},
		},
		{
			skillID:   "ai-drama-reference-art",
			skillName: "AI短剧参考图提示词编写",
			version:   "1.0.0",
			minFiles:  1,
			auxPaths:  nil,
		},
		{
			skillID:   "seedance-clip-writer",
			skillName: "Seedance 视频提示词编写",
			version:   "9.3.0",
			minFiles:  9,
			auxPaths:  []string{"references/performance_layer.md", "references/script_to_shot_breakdown.md", "references/transition_grammar.md"},
		},
	}

	var pins []Pin
	for _, tc := range expected {
		detail, err := svc.SkillDetail("tester", tc.skillID)
		if err != nil {
			t.Fatalf("SkillDetail(%s): %v", tc.skillID, err)
		}
		if detail.SkillName != tc.skillName {
			t.Fatalf("%s SkillName = %q, want %q", tc.skillID, detail.SkillName, tc.skillName)
		}
		if !detail.IsAdded {
			t.Fatalf("%s IsAdded = false, want true by default for local workspace owner", tc.skillID)
		}
		if detail.EffectiveUser.Name != "lucky加一" || detail.OwnerUID != "lucky-plus-one" {
			t.Fatalf("%s attribution = %+v (owner=%q), want lucky加一 / lucky-plus-one", tc.skillID, detail.EffectiveUser, detail.OwnerUID)
		}
		if detail.FileCount < tc.minFiles {
			t.Fatalf("%s FileCount = %d, want >= %d", tc.skillID, detail.FileCount, tc.minFiles)
		}
		releaseID := tc.skillID + "-" + tc.version
		rel, err := svc.MarketRelease(context.Background(), tc.skillID, releaseID)
		if err != nil {
			t.Fatalf("MarketRelease(%s, %s): %v", tc.skillID, releaseID, err)
		}
		if rel.Author != "lucky加一" || len(rel.Files) < tc.minFiles {
			t.Fatalf("MarketRelease(%s) = %+v", tc.skillID, rel)
		}
		chunk, err := svc.MarketFile(context.Background(), tc.skillID, releaseID, "SKILL.md", 0, 4096)
		if err != nil || !strings.Contains(chunk.Content, "lucky加一") {
			t.Fatalf("MarketFile(%s, SKILL.md) = %+v, err=%v", tc.skillID, chunk, err)
		}
		pin := Pin{SkillID: detail.SkillID, VersionID: detail.VersionID, ContentHash: detail.ContentHash}
		pins = append(pins, pin)

		resource, err := svc.AgentVersion("tester", pin)
		if err != nil {
			t.Fatalf("AgentVersion(%s): %v", tc.skillID, err)
		}
		if !strings.Contains(resource.Instruction, "lucky加一") {
			t.Fatalf("%s instruction missing attribution lucky加一", tc.skillID)
		}
		if !strings.Contains(resource.Instruction, "{ expectedRevision, nodes: [") || !strings.Contains(resource.Instruction, "{ nodeId, expectedRevision, patch: { title:") {
			t.Fatalf("%s instruction missing expectedRevision / patch schema guidance", tc.skillID)
		}
		fileContents := map[string]string{"SKILL.md": resource.Instruction}
		for _, item := range resource.Files {
			file, err := svc.AgentFile("tester", pin, item.Path)
			if err != nil || strings.TrimSpace(file.Content) == "" {
				t.Fatalf("AgentFile(%s, %s) failed: err=%v", tc.skillID, item.Path, err)
			}
			fileContents[item.Path] = file.Content
		}
		for _, auxPath := range tc.auxPaths {
			if _, ok := fileContents[auxPath]; !ok {
				t.Fatalf("expected auxiliary path %s in %s", auxPath, tc.skillID)
			}
		}
		linkRe := regexp.MustCompile(`\]\(([^)]+)\)`)
		for filePath, body := range fileContents {
			if !strings.HasSuffix(filePath, ".md") {
				continue
			}
			for _, match := range linkRe.FindAllStringSubmatch(body, -1) {
				target := match[1]
				if strings.Contains(target, "://") || strings.HasPrefix(target, "#") {
					continue
				}
				cleanTarget := path.Clean(path.Join(path.Dir(filePath), strings.SplitN(target, "#", 2)[0]))
				if _, ok := fileContents[cleanTarget]; !ok {
					t.Fatalf("%s broken markdown link in %s -> %s (resolved %s)", tc.skillID, filePath, target, cleanTarget)
				}
			}
		}
		if tc.skillID == "novel-to-manju-agent" {
			manifestRaw, ok := fileContents["bundle-manifest.json"]
			if !ok {
				t.Fatal("novel-to-manju-agent missing bundle-manifest.json")
			}
			var manifest struct {
				Files []struct {
					Path   string `json:"path"`
					Bytes  int    `json:"bytes"`
					SHA256 string `json:"sha256"`
				} `json:"files"`
			}
			if err := json.Unmarshal([]byte(manifestRaw), &manifest); err != nil {
				t.Fatalf("invalid bundle-manifest.json: %v", err)
			}
			if len(manifest.Files) == 0 || len(manifest.Files) != len(fileContents)-1 {
				t.Fatalf("manifest file count = %d, want %d", len(manifest.Files), len(fileContents)-1)
			}
			seen := make(map[string]bool, len(manifest.Files))
			for _, entry := range manifest.Files {
				body, exists := fileContents[entry.Path]
				if !exists {
					t.Fatalf("manifest file missing from package: %s", entry.Path)
				}
				seen[entry.Path] = true
				sum := sha256.Sum256([]byte(body))
				if len(body) != entry.Bytes || hex.EncodeToString(sum[:]) != entry.SHA256 {
					t.Fatalf("manifest mismatch for %s", entry.Path)
				}
			}
			for pkgPath := range fileContents {
				if pkgPath != "bundle-manifest.json" && !seen[pkgPath] {
					t.Fatalf("package file omitted from manifest: %s", pkgPath)
				}
			}
			for _, deliveryRel := range []string{"assets/example-project/delivery.json", "assets/complete-example/delivery.json"} {
				var delivery struct {
					SourceFiles []struct {
						Path   string `json:"path"`
						SHA256 string `json:"sha256"`
					} `json:"source_files"`
				}
				if err := json.Unmarshal([]byte(fileContents[deliveryRel]), &delivery); err != nil || len(delivery.SourceFiles) == 0 {
					t.Fatalf("invalid %s: %v", deliveryRel, err)
				}
				for _, sf := range delivery.SourceFiles {
					srcPath := path.Clean(path.Join(path.Dir(deliveryRel), sf.Path))
					srcBody, exists := fileContents[srcPath]
					if !exists {
						t.Fatalf("%s references missing source file %s", deliveryRel, srcPath)
					}
					sum := sha256.Sum256([]byte(srcBody))
					if hex.EncodeToString(sum[:]) != sf.SHA256 {
						t.Fatalf("%s source hash mismatch for %s", deliveryRel, srcPath)
					}
				}
			}
		}
	}

	if _, err := svc.ValidateAgentSkills("tester", pins); err != nil {
		t.Fatalf("ValidateAgentSkills(all 3 lucky加一 skills): %v", err)
	}
}

func TestNormalizeBuiltinSkillFilesRejectsTotalSizeOverflow(t *testing.T) {
	chunk := strings.Repeat("a", 70<<20)
	if _, err := normalizeBuiltinSkillFiles(map[string]string{
		"references/one.md":   chunk,
		"references/two.md":   chunk,
		"references/three.md": chunk,
	}); err == nil {
		t.Fatal("expected aggregate size limit error from normalizeBuiltinSkillFiles")
	}
	skillBody := []byte("---\nname: demo\ndescription: demo\n---\nbody\n")
	chunkA := []byte(strings.Repeat("b", 7<<20))
	chunkB := []byte(strings.Repeat("b", 7<<20))
	remaining := maxSkillPackageBytes - len(skillBody) - len(chunkA) - len(chunkB)
	meta := skillPackageMetadata{Name: "demo", Description: "demo"}
	if _, err := finalizeSkillArchive(map[string][]byte{
		"SKILL.md":          skillBody,
		"references/a.md":   chunkA,
		"references/b.md":   chunkB,
		"references/fit.md": []byte(strings.Repeat("b", remaining)),
	}, meta); err != nil {
		t.Fatalf("finalizeSkillArchive at exact limit failed: %v", err)
	}
	if _, err := finalizeSkillArchive(map[string][]byte{
		"SKILL.md":               skillBody,
		"references/a.md":        chunkA,
		"references/b.md":        chunkB,
		"references/overflow.md": []byte(strings.Repeat("b", remaining+1)),
	}, meta); err == nil {
		t.Fatal("expected finalizeSkillArchive to reject package exceeding maxSkillPackageBytes")
	}
}

func assertSkillVersionCount(t *testing.T, db *gorm.DB, skillID string, want int64) {
	t.Helper()
	var got int64
	if err := db.Model(&model.SkillVersion{}).Where("skill_id = ?", skillID).Count(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("skill %s version count = %d, want %d", skillID, got, want)
	}
}

func skillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for filePath, content := range files {
		entry, err := writer.Create(filePath)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSyncAndRemovePluginSkillsLifecycle(t *testing.T) {
	svc, db := agentSkillFixture(t)
	if err := db.AutoMigrate(&model.Workspace{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "tester", Name: "测试工作区"}).Error; err != nil {
		t.Fatal(err)
	}

	pluginSkillsRoot := filepath.Join(t.TempDir(), "skills")
	skillDir := filepath.Join(pluginSkillsRoot, "storyboard-grid")
	if err := os.MkdirAll(filepath.Join(skillDir, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: 分镜九宫格拆解\ndescription: 把剧本拆解为九宫格分镜\n---\n# 分镜九宫格拆解\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "references", "guide.md"), []byte("# Guide\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := svc.SyncPluginSkills("storyboard-grid", "分镜九宫格", "1.0.0", []string{pluginSkillsRoot}); err != nil {
		t.Fatalf("SyncPluginSkills failed: %v", err)
	}

	added, err := svc.AddedSkills("tester")
	if err != nil {
		t.Fatal(err)
	}
	if len(added) != 1 || added[0].SourceType != "plugin" || added[0].SkillName != "分镜九宫格拆解" {
		t.Fatalf("unexpected added skills: %#v", added)
	}

	if err := svc.RemovePluginSkills("storyboard-grid"); err != nil {
		t.Fatalf("RemovePluginSkills failed: %v", err)
	}
	afterRemove, err := svc.AddedSkills("tester")
	if err != nil {
		t.Fatal(err)
	}
	if len(afterRemove) != 0 {
		t.Fatalf("expected 0 skills after RemovePluginSkills, got %#v", afterRemove)
	}
}
