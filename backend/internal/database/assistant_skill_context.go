package database

import (
	"gorm.io/gorm"
	"qisitv/backend/internal/model"
)

func migrateAssistantSkillContexts(tx *gorm.DB) error {
	return tx.AutoMigrate(&model.AssistantSkillContext{}, &model.AssistantSkillContextMutation{})
}
