package skills

import (
	"strings"
	"testing"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

func TestImportedSkillUsesChineseHeadingInsteadOfTechnicalName(t *testing.T) {
	s, db := agentSkillFixture(t)
	body := "---\nname: storyboard-text\ndescription: 整理分镜\n---\n# 双镜头文字分镜\n\n正文"
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": body})
	item, err := s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "双镜头文字分镜" {
		t.Fatalf("imported name: %+v %v", item, err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("name", "storyboard-text").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	item, err = s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "双镜头文字分镜" || item.VersionID != pin.VersionID || item.ContentHash != pin.ContentHash {
		t.Fatalf("legacy name repair changed identity: %+v %v", item, err)
	}
	resource, err := s.AgentVersion("owner", pin)
	if err != nil || resource.Name != item.SkillName || resource.Instruction != body {
		t.Fatalf("assistant label/body: %+v %v", resource, err)
	}
	// 去掉「已修复」标记，确认没有标记时自定义名字也不会被改。
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("name", "我的私人分镜").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Where("key = ?", skillDisplayNamesRepairedKey).Delete(&model.SystemSetting{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	item, err = s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "我的私人分镜" {
		t.Fatalf("custom name replaced: %+v %v", item, err)
	}
}

func TestSkillDisplayNameFallbacks(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{"---\nname: interview-outline\ndescription: 简介\n---\n# 采访提纲", "采访提纲"},
		{"---\nname: material-inventory\ndescription: 简介\n---\n# 素材清单整理", "素材清单整理"},
		{"---\nname: Custom Name\ndescription: 简介\n---\n# 中文标题", "Custom Name"},
		{"---\nname: 自定义名称\ndescription: 简介\n---\n# 中文标题", "自定义名称"},
		{"---\nname: technical-name\ndescription: 简介\n---\nNo title", "technical-name"},
		// 代码块里的注释不是标题；ATX 结尾的 # 不进名字；超长标题不采用，避免导入因名称超长失败。
		{"---\nname: setup-guide\ndescription: 简介\n---\n```bash\n# 安装依赖\n```\n# 环境准备指南", "环境准备指南"},
		{"---\nname: tilde-fence\ndescription: 简介\n---\n~~~\n# 注释\n~~~\n# 波浪线代码块之后的标题", "波浪线代码块之后的标题"},
		{"---\nname: closing-hash\ndescription: 简介\n---\n# 分镜整理 ##", "分镜整理"},
		{"---\nname: tab-closing-hash\ndescription: 简介\n---\n# 分镜整理\t##", "分镜整理"},
		{"---\nname: long-title\ndescription: 简介\n---\n# " + strings.Repeat("长", maxSkillNameRunes+1), "long-title"},
		{"---\nname: csharp-tips\ndescription: 简介\n---\n# C# 编程技巧", "C# 编程技巧"},
		{"---\nname: long-fence\ndescription: 简介\n---\n````md\n```\n# 示例\n```\n````\n# 四个反引号之后的标题", "四个反引号之后的标题"},
		{"---\nname: info-close\ndescription: 简介\n---\n```\n```go\n# 注释\n```\n# 带语言名的行不会提前结束代码块", "带语言名的行不会提前结束代码块"},
		{"---\nname: indented-code\ndescription: 简介\n---\n    ```\n    # 缩进代码\n\t# 制表符缩进\n# 缩进代码之后的标题", "缩进代码之后的标题"},
		// 没有 name 时用同一套规则取标题。
		{"```bash\n# 安装依赖\n```\n# 环境准备指南 #", "环境准备指南"},
		{"# C#", "C#"},
	} {
		if got := parseSkillPackageMetadata([]byte(tc.body)).Name; got != tc.want {
			t.Fatalf("name = %q, want %q", got, tc.want)
		}
	}
}

// 早先导入、来源字段为空（NULL）的技能也会被修复；修复只执行一次，之后用户主动改回技术名不会被再次改掉。
func TestSkillDisplayNameRepairCoversNullSourceAndRunsOnce(t *testing.T) {
	s, db := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: interview-outline\ndescription: 采访\n---\n# 采访提纲\n\n正文"})
	if err := db.Exec("UPDATE skills SET name = ?, source_type = NULL WHERE id = ?", "interview-outline", pin.SkillID).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	item, err := s.SkillDetail("owner", pin.SkillID)
	if err != nil || item.SkillName != "采访提纲" || item.ContentHash != pin.ContentHash {
		t.Fatalf("NULL-source legacy name not repaired: %+v %v", item, err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("name", "interview-outline").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	if item, err = s.SkillDetail("owner", pin.SkillID); err != nil || item.SkillName != "interview-outline" {
		t.Fatalf("repair ran again over the user's chosen name: %+v %v", item, err)
	}
}

// 名称或简介超长时截到上限以内，导入不会因为截断后的省略号超长而失败。
func TestSkillArchiveFitsLongNameAndDescription(t *testing.T) {
	longDescription := strings.Repeat("述", maxSkillDescriptionRunes+100)
	for _, body := range []string{
		"---\nname: " + strings.Repeat("名", maxSkillNameRunes+20) + "\ndescription: " + longDescription + "\n---\n正文",
		"# " + strings.Repeat("题", maxSkillNameRunes+20) + "\n\n" + longDescription,
	} {
		archive, err := archiveFromMarkdown([]byte(body), "", "")
		if err != nil {
			t.Fatalf("long metadata rejected: %v", err)
		}
		name, description := []rune(archive.Metadata.Name), []rune(archive.Metadata.Description)
		if len(name) != maxSkillNameRunes || len(description) != maxSkillDescriptionRunes || string(name[len(name)-1:]) != "…" {
			t.Fatalf("metadata not fitted: %d %d %q", len(name), len(description), archive.Metadata.Name)
		}
	}
}

// 内置技能不参与显示名修复，即使来源字段为空。
func TestSkillDisplayNameRepairSkipsBuiltin(t *testing.T) {
	s, db := agentSkillFixture(t)
	builtin := model.Skill{ID: kernel.NewID(), Name: "storyboard-text", Description: "内置", Instruction: "---\nname: storyboard-text\ndescription: 内置\n---\n# 双镜头文字分镜", Status: skillStatusEnabled, Source: 3}
	if err := db.Create(&builtin).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("UPDATE skills SET source_type = NULL WHERE id = ?", builtin.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Where("key = ?", skillDisplayNamesRepairedKey).Delete(&model.SystemSetting{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	var got model.Skill
	if err := db.First(&got, "id = ?", builtin.ID).Error; err != nil || got.Name != "storyboard-text" {
		t.Fatalf("builtin renamed: %q %v", got.Name, err)
	}
}
