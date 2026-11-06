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

func TestLocalSkillsFollowTheDirectoryAndTheSwitch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".agents", "skills")
	writeLocalSkill(t, filepath.Join(root, "storyboard"), map[string]string{
		"SKILL.md":       "---\nname: storyboard\ndescription: 拆分镜\n---\n正文",
		"scripts/run.py": "print('ok')",
	})
	writeLocalSkill(t, filepath.Join(root, ".cache"), map[string]string{"SKILL.md": "---\nname: hidden\ndescription: 隐藏\n---\n正文"})
	linked := filepath.Join(t.TempDir(), "voice-over")
	writeLocalSkill(t, linked, map[string]string{"SKILL.md": "---\nname: voice-over\ndescription: 配音\n---\n正文"})
	if err := os.Symlink(linked, filepath.Join(root, "voice-over")); err != nil {
		t.Fatal(err)
	}

	s := localSkillFixture(t)
	source, err := s.LocalSkillSource()
	if err != nil || !source.Enabled || source.Directory != "~/.agents/skills" {
		t.Fatalf("local skills should be on by default: %+v %v", source, err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if ids := localSkillIDs(t, s); strings.Join(ids, ",") != "local-storyboard,local-voice-over" {
		t.Fatalf("skills = %v", ids)
	}
	if skill, err := s.repo.Skill("local-storyboard"); err != nil || !skill.IsPrivate {
		t.Fatalf("本机技能不算公开内容: %+v %v", skill, err)
	}

	row, err := s.repo.Skill("local-storyboard")
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.skillItems("workspace", []model.Skill{*row}, false)
	if err != nil || !items[0].HasScripts || items[0].SourceType != "local" || !items[0].IsAdded {
		t.Fatalf("item = %+v %v", items, err)
	}

	writeLocalSkill(t, filepath.Join(root, "storyboard"), map[string]string{"SKILL.md": "---\nname: storyboard\ndescription: 新的说明\n---\n正文"})
	if err := os.RemoveAll(filepath.Join(root, "voice-over")); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if row, err = s.repo.Skill("local-storyboard"); err != nil || row.Description != "新的说明" {
		t.Fatalf("edits on disk should reach the library: %+v %v", row, err)
	}
	if ids := localSkillIDs(t, s); len(ids) != 1 {
		t.Fatalf("a skill removed from disk should leave the library: %v", ids)
	}

	if _, err := s.SetLocalSkillSource(false); err != nil {
		t.Fatal(err)
	}
	if ids := localSkillIDs(t, s); len(ids) != 0 {
		t.Fatalf("switching off should empty the library: %v", ids)
	}
	if _, err := os.Stat(filepath.Join(root, "storyboard", "SKILL.md")); err != nil {
		t.Fatalf("switching off must not touch the user's files: %v", err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if ids := localSkillIDs(t, s); len(ids) != 0 {
		t.Fatalf("sync must respect the switch: %v", ids)
	}
}

func TestDirectorySkillsKeepTheirFilesAcrossRestart(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	files := map[string]string{"SKILL.md": "---\nname: trim\ndescription: 裁视频\n---\n正文", "scripts/trim.sh": "ffmpeg"}
	writeLocalSkill(t, filepath.Join(home, ".agents", "skills", "trim"), files)
	pluginDir := filepath.Join(t.TempDir(), "skills", "cutter")
	writeLocalSkill(t, pluginDir, files)

	s := localSkillFixture(t)
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncPluginSkills("beeftv-plugin-cutter", "剪辑插件", "1.2.0", []string{pluginDir}); err != nil {
		t.Fatal(err)
	}
	// 每次启动都会跑这一步，它不能动这两类技能。
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	for id, sourceType := range map[string]string{"local-trim": "local", "plugin-beeftv-plugin-cutter-cutter": "plugin"} {
		skill, err := s.repo.Skill(id)
		if err != nil {
			t.Fatal(id, err)
		}
		if skill.SourceType != sourceType || skill.FileCount != 2 {
			t.Fatalf("%s 启动后变成 sourceType=%s fileCount=%d", id, skill.SourceType, skill.FileCount)
		}
		var versions int64
		if err := s.repo.DB().Model(&model.SkillVersion{}).Where("skill_id = ?", id).Count(&versions).Error; err != nil {
			t.Fatal(err)
		}
		if versions != 1 {
			t.Fatalf("%s 启动后有 %d 个版本", id, versions)
		}
	}
}

func TestSyncKeepsADisabledLocalSkillDisabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".agents", "skills", "trim")
	writeLocalSkill(t, dir, map[string]string{"SKILL.md": "---\nname: trim\ndescription: 裁视频\n---\n正文"})

	s := localSkillFixture(t)
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSkillAdded("workspace", "local-trim", false); err != nil {
		t.Fatal(err)
	}
	writeLocalSkill(t, dir, map[string]string{"SKILL.md": "---\nname: trim\ndescription: 裁视频\n---\n改过的正文"})
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	state, err := s.repo.UserSkillState("workspace", "local-trim")
	if err != nil || state == nil {
		t.Fatalf("state = %v, err = %v", state, err)
	}
	if state.Added {
		t.Fatal("用户停用过的本机技能被同步重新打开了")
	}
	skill, err := s.repo.Skill("local-trim")
	if err != nil {
		t.Fatal(err)
	}
	if state.InstalledVersionID != skill.CurrentVersionID {
		t.Fatal("同步后版本没有跟上目录里的内容")
	}
}

func TestLocalSkillThatCannotBeReadOnlySkipsItself(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every file")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".agents", "skills")
	writeLocalSkill(t, filepath.Join(root, "good"), map[string]string{"SKILL.md": "---\nname: good\ndescription: 好\n---\n正文"})
	writeLocalSkill(t, filepath.Join(root, "locked"), map[string]string{"SKILL.md": "---\nname: locked\ndescription: 读不了\n---\n正文", "references/note.md": "x"})
	if err := os.Chmod(filepath.Join(root, "locked", "references", "note.md"), 0); err != nil {
		t.Fatal(err)
	}
	s := localSkillFixture(t)
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if ids := localSkillIDs(t, s); strings.Join(ids, ",") != "local-good" {
		t.Fatalf("skills = %v", ids)
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

func TestLocalSkillsStayWhenTheirFolderIsTemporarilyMissing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	drive := filepath.Join(home, "drive")
	writeLocalSkill(t, filepath.Join(drive, "linked"), map[string]string{"SKILL.md": "---\nname: linked\ndescription: 软链接技能\n---\n正文"})
	writeLocalSkill(t, filepath.Join(drive, "skills", "held"), map[string]string{"SKILL.md": "---\nname: held\ndescription: 目录技能\n---\n正文"})
	root := filepath.Join(home, ".agents", "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(drive, "linked"), filepath.Join(root, "linked")); err != nil {
		t.Skip(err)
	}
	writeLocalSkill(t, filepath.Join(root, "local"), map[string]string{"SKILL.md": "---\nname: local\ndescription: 普通技能\n---\n正文"})
	s := localSkillFixture(t)
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(localSkillIDs(t, s), ","); got != "local-linked,local-local" {
		t.Fatalf("skills = %s", got)
	}

	// 外接硬盘拔掉后软链接断了，技能记录要留着，插回来才能接着用。
	if err := os.Rename(drive, drive+"-away"); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(localSkillIDs(t, s), ","); got != "local-linked,local-local" {
		t.Fatalf("skills after the link broke = %s", got)
	}

	// 整个技能目录都是软链接时同理。
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(drive, "skills"), root); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(localSkillIDs(t, s), ","); got != "local-linked,local-local" {
		t.Fatalf("skills after the root link broke = %s", got)
	}

	// 目录真的没有了，才算技能被删掉。
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := localSkillIDs(t, s); len(got) != 0 {
		t.Fatalf("skills after the folder was removed = %v", got)
	}
}

func TestLocalSkillStaysWhenItsSkillFileCannotBeRead(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".agents", "skills")
	writeLocalSkill(t, filepath.Join(root, "flaky"), map[string]string{"SKILL.md": "---\nname: flaky\ndescription: 读取出错的技能\n---\n正文"})
	s := localSkillFixture(t)
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	// 指向自己的链接读取时会报错，但不是“文件不存在”。
	skillFile := filepath.Join(root, "flaky", "SKILL.md")
	if err := os.Remove(skillFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(skillFile, skillFile); err != nil {
		t.Skip(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := localSkillIDs(t, s); len(got) != 1 {
		t.Fatalf("a read error should not delete the skill: %v", got)
	}
	if err := os.Remove(skillFile); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncLocalSkills(); err != nil {
		t.Fatal(err)
	}
	if got := localSkillIDs(t, s); len(got) != 0 {
		t.Fatalf("a removed SKILL.md should delete the skill: %v", got)
	}
}
