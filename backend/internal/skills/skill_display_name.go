package skills

import (
	"errors"
	"fmt"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skillhub"

	"gorm.io/gorm"
)

// 技能名称和简介的长度上限；解析截断、打包校验、显示名推断和手动改名共用。
const (
	maxSkillNameRunes        = skillhub.MaxNameRunes
	maxSkillDescriptionRunes = skillhub.MaxDescriptionRunes
)

// skillDisplayNamesRepairedKey 标记早先导入的技能已按中文标题修复过显示名；只修一次。
const skillDisplayNamesRepairedKey = "skills.display_names_repaired.v1"

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
