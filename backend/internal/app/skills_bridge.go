package app

import (
	"context"

	"infinite-canvas/backend/internal/skills"
)

const SkillPackageUploadMaxBytes = skills.SkillPackageUploadMaxBytes

type (
	SkillShowcaseMedia        = skills.SkillShowcaseMedia
	SkillEffectiveUser        = skills.SkillEffectiveUser
	SkillItem                 = skills.SkillItem
	SkillCategory             = skills.SkillCategory
	SkillListRequest          = skills.SkillListRequest
	SkillList                 = skills.SkillList
	SkillMutationRequest      = skills.SkillMutationRequest
	SkillInstallRequest       = skills.SkillInstallRequest
	SkillGitHubInstallRequest = skills.SkillGitHubInstallRequest
	SkillPackageFileItem      = skills.SkillPackageFileItem
	SkillPackageFileContent   = skills.SkillPackageFileContent
	SkillPackageBundleFile    = skills.SkillPackageBundleFile
	SkillPackageBundle        = skills.SkillPackageBundle
	SkillFileSearchResult     = skills.SkillFileSearchResult
)

func (s *Service) skillDomain() *skills.Service {
	if s == nil {
		return skills.New(nil, "", nil)
	}
	if s.skills != nil {
		return s.skills
	}
	return skills.New(s.repo, s.dataDir, s.runWorkerLoop)
}

func (s *Service) EnsureBuiltinSkills() error {
	return s.skillDomain().EnsureBuiltinSkills()
}

func (s *Service) EnsureSkillPackages() error {
	return s.skillDomain().EnsureSkillPackages()
}

func (s *Service) SyncGitHubSkill(userID string, skillID string) (*SkillItem, error) {
	return s.skillDomain().SyncGitHubSkill(userID, skillID)
}

func (s *Service) startSkillSyncWorker(ctx context.Context) {
	s.skillDomain().StartSyncWorker(ctx)
}
