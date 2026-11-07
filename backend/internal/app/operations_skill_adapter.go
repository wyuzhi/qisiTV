package app

import (
	"context"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/skills"
)

func (s *Service) ValidateAgentSkills(userID string, pins []skills.Pin) ([]skills.Pin, error) {
	domain := s.skillDomain()
	validated, err := domain.ValidateAgentSkills(userID, pins)
	if err != nil {
		return nil, err
	}
	for _, pin := range validated {
		if err := s.checkAgentSkillRequirements(domain, userID, pin); err != nil {
			return nil, err
		}
	}
	return validated, nil
}
func (s *operationSession) AgentSkillVersion(userID string, pin skills.Pin) (*skills.AgentResource, error) {
	if err := s.service.checkAgentSkillRequirements(s.service.skillDomain(), userID, pin); err != nil { return nil, err }
	return s.service.skillDomain().AgentVersion(userID, pin)
}
func (s *operationSession) AgentSkillFile(userID string, pin skills.Pin, path string) (*skills.AgentFile, error) {
	if err := s.service.checkAgentSkillRequirements(s.service.skillDomain(), userID, pin); err != nil { return nil, err }
	return s.service.skillDomain().AgentFile(userID, pin, path)
}
func (s *operationSession) AgentSkillCatalog(userID string) ([]skills.AgentCatalogItem, error) { return s.service.skillDomain().AgentCatalog(userID) }
func (s *operationSession) ProposeOrRunSkillScript(ctx context.Context, userID, turnID string, req skills.ScriptRunRequest) (any, error) {
	if err := s.service.checkAgentSkillRequirements(s.service.skillDomain(), userID, req.Pin); err != nil { return nil, err }
	return operations.ProposeOrRunSkillScript(ctx, s.repo.DB(), s.service.skillDomain().WithRepo(s.repo), userID, turnID, req)
}
func (s *Service) checkAgentSkillRequirements(domain *skills.Service, userID string, pin skills.Pin) error {
	required, err := domain.AgentRequirements(userID, pin)
	if err != nil {
		return err
	}
	for _, capability := range required {
		var message string
		switch capability {
		case "beeftv.canvas":
			continue
		case "model.audio", "model.video":
			if snapshot, err := s.assistantConfig(); err == nil {
				if _, reason := modelcatalog.ResolveMediaReviewProvider(snapshot, s.assistantManagedCredentialLookup()); reason == "" {
					continue
				}
			}
			message = "这个技能需要影音理解能力。请在模型配置中选择可用的默认多模态模型，再使用此技能。"
		case "model.image":
			message = "无法确认当前模型的图片输入支持。请暂时选择不要求图片理解的技能。"
		default:
			message = "这个技能要求尚未确认的能力：" + capability
		}
		return &kernel.AppError{Status: 409, Code: 409, Reason: "skill_capability_unavailable", Message: message}
	}
	return nil
}
