package app

import (
	"infinite-canvas/backend/internal/prompts"
)

type (
	PromptTemplateVariable         = prompts.PromptTemplateVariable
	PromptOperationDefinition      = prompts.PromptOperationDefinition
	UserPromptCustomizationRequest = prompts.UserPromptCustomizationRequest
	UserPromptPreference           = prompts.UserPromptPreference
	CompiledPrompt                 = prompts.CompiledPrompt
	StyleProfileRequest            = prompts.StyleProfileRequest
	StyleProfileFavoriteRequest    = prompts.StyleProfileFavoriteRequest
)

const (
	promptOperationStoryboardPlan       = prompts.OperationStoryboardPlan
	promptOperationStoryboardRepair     = prompts.OperationStoryboardRepair
	promptOperationStoryboardFirstFrame = prompts.OperationStoryboardFirstFrame
	promptOperationStoryboardVideo      = prompts.OperationStoryboardVideo
	promptOperationCharacterExtract     = prompts.OperationCharacterExtract
	promptOperationChapterAssetsExtract = prompts.OperationChapterAssetsExtract
	promptOperationCharacterTurnaround  = prompts.OperationCharacterTurnaround
	promptOperationShortDramaOutline    = prompts.OperationShortDramaOutline
	promptOperationSkillDraft           = prompts.OperationSkillDraft
)

// PromptService exposes the domain service to the HTTP composition layer.
func (s *Service) PromptService() *prompts.Service { return s.promptDomain() }

func (s *Service) promptDomain() *prompts.Service {
	if s == nil {
		return prompts.New(nil)
	}
	if s.prompts != nil {
		return s.prompts
	}
	return prompts.New(s.repo)
}

func (s *Service) EnsureDefaultPromptTemplates() error {
	return s.promptDomain().EnsureDefaultPromptTemplates()
}

func (s *Service) compilePrompt(userID string, operation string, values map[string]string) (CompiledPrompt, error) {
	return s.promptDomain().CompilePrompt(userID, operation, values)
}

func validateStyleProfileJSON(value string) (string, error) {
	return prompts.ValidateStyleProfileJSON(value)
}

func promptDefinition(operation string) (PromptOperationDefinition, bool) {
	return prompts.PromptDefinition(operation)
}

func renderPromptTemplate(definition PromptOperationDefinition, content string, values map[string]string) (string, error) {
	return prompts.RenderPromptTemplate(definition, content, values)
}

func validatePromptTemplateResult(operation string, result map[string]interface{}) error {
	return prompts.ValidatePromptTemplateResult(operation, result)
}

func validateStyleProfilePreset(presetID string, profileJSON string) error {
	return prompts.ValidateStyleProfilePreset(presetID, profileJSON)
}

func nonEmptyStyleProfileStrings(values []string) []string {
	return prompts.NonEmptyStyleProfileStrings(values)
}

type styleProfileDocument = prompts.StyleProfileDocument
type styleProfileAsset = prompts.StyleProfileAsset

func storyboardExecutionContract(durationRule string, countRule string) string {
	return prompts.StoryboardExecutionContract(durationRule, countRule)
}
