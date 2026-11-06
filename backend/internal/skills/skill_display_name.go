package skills

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"

	"gorm.io/gorm"
)

// 技能名称和简介的长度上限；解析截断、打包校验、显示名推断和手动改名共用。
const (
	maxSkillNameRunes        = 80
	maxSkillDescriptionRunes = skillhub.MaxDescriptionRunes
)

// skillDisplayNamesRepairedKey 标记早先导入的技能已按中文标题修复过显示名；只修一次。
const skillDisplayNamesRepairedKey = "skills.display_names_repaired.v1"

// Technical names identify a package; a Chinese document title is its display name.
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

// displaySkillName 在包名是英文技术名时，改用正文第一个一级标题作显示名；标题须含中文且不超长，否则保持原名。
func displaySkillName(name string, body []string) string {
	if !isTechnicalSkillName(name) {
		return name
	}
	title := firstMarkdownTitle(body)
	if strings.ContainsFunc(title, func(r rune) bool { return unicode.Is(unicode.Han, r) }) && utf8.RuneCountInString(title) <= maxSkillNameRunes {
		return title
	}
	return name
}

// firstMarkdownTitle 返回正文第一个一级标题。代码块（围栏或缩进 4 格）里的「#」行不算标题；
// 只去掉前面有空格的结尾「#」，「C#」这类名字保留。
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

// codeFence 识别以 3 个以上「`」或「~」开头的围栏行，返回围栏字符和长度。
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

// ensureSkillDisplayNames 修复早先导入、仍显示英文技术名的技能，只执行一次；用户自己改过的名字、
// 包内容、版本和摘要都不动。内置技能的名字每次启动由预设重置，不在此修复。
func (s *Service) ensureSkillDisplayNames() error {
	if _, err := s.repo.SystemSetting(skillDisplayNamesRepairedKey); err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	rows, err := s.repo.SkillsForDisplayNameEnsure(skillSourceUser)
	if err != nil {
		return err
	}
	for _, skill := range rows {
		metadata := parseSkillPackageMetadata([]byte(skill.Instruction))
		// Only repair the original technical name, preserving custom names and package bytes.
		if skill.Name != metadata.TechnicalName || metadata.Name == skill.Name || metadata.Name == "" {
			continue
		}
		skill.Name = metadata.Name
		if err := s.repo.SaveSkill(&skill); err != nil {
			return fmt.Errorf("更新技能显示名称失败: %w", err)
		}
	}
	return s.repo.SaveSystemSetting(&model.SystemSetting{Key: skillDisplayNamesRepairedKey, ValueJSON: "true"})
}
