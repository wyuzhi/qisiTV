package skills

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

func writeLocalSkill(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func localSkillFixture(t *testing.T) *Service {
	t.Helper()
	s, db := agentSkillFixture(t)
	if err := db.AutoMigrate(&model.Workspace{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "workspace", Name: "本地工作区"}).Error; err != nil {
		t.Fatal(err)
	}
	return s
}

func localSkillIDs(t *testing.T, s *Service) []string {
	t.Helper()
	var rows []model.Skill
	if err := s.repo.DB().Where("source_type = ?", "local").Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestPluginSkillsKeepTheirFilesAcrossRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "skills", "cutter")
	writeLocalSkill(t, dir, map[string]string{"SKILL.md": "---\nname: cutter\ndescription: Clip workflow\n---\nBody", "scripts/trim.sh": "ffmpeg"})
	s := localSkillFixture(t)
	if err := s.SyncPluginSkills("beeftv-plugin-cutter", "剪辑插件", "1.2.0", []string{dir}); err != nil {
		t.Fatal(err)
	}
	if err := s.RetireExternalSkills(); err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	id := "plugin-beeftv-plugin-cutter-cutter"
	skill, err := s.repo.Skill(id)
	if err != nil || skill.SourceType != "plugin" || skill.FileCount != 2 {
		t.Fatalf("plugin package changed: %+v, %v", skill, err)
	}
	var versions int64
	if err := s.repo.DB().Model(&model.SkillVersion{}).Where("skill_id = ?", id).Count(&versions).Error; err != nil {
		t.Fatal(err)
	}
	if versions != 1 {
		t.Fatalf("plugin has %d versions after restart", versions)
	}
}

func zipSkill(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSkillPackageOnlyLimitsTotalSize(t *testing.T) {
	description := strings.Repeat("述", maxSkillDescriptionRunes)
	files := map[string][]byte{
		"SKILL.md":      []byte("---\nname: big\ndescription: " + description + "\n---\n正文"),
		"assets/big.md": bytes.Repeat([]byte("a"), 9<<20),
	}
	for index := 0; index < 600; index++ {
		files[fmt.Sprintf("references/%d.md", index)] = []byte("x")
	}
	archive, err := archiveFromZip(zipSkill(t, files), "")
	if err != nil {
		t.Fatalf("a large file and many files are allowed: %v", err)
	}
	if utf8.RuneCountInString(archive.Metadata.Description) != maxSkillDescriptionRunes || archive.Metadata.Description != description {
		t.Fatalf("a description within the standard's limit must stay whole: %d", utf8.RuneCountInString(archive.Metadata.Description))
	}

	oversized := map[string][]byte{"SKILL.md": files["SKILL.md"], "assets/huge.md": make([]byte, maxSkillPackageBytes+1)}
	if _, err := archiveFromZip(zipSkill(t, oversized), ""); err == nil || !strings.Contains(err.Error(), "200MB") {
		t.Fatalf("expected the total limit, got %v", err)
	}
}
