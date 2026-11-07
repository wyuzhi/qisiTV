package app

import (
	"encoding/json"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	localtask "infinite-canvas/backend/internal/task"
)

type (
	workflowBinding = cw.Binding
	workflowRecipe  = cw.Recipe
	workflowRecipes = cw.RecipesByNode
)

func (s *Service) compileHost() cw.CompileHost {
	return cw.NewCompileHost(cw.CompileHostConfig{
		Repo: s.repo, DataDir: s.dataDir, LocalMode: s.IsLocalMode(), ManagedCredRef: managedBeefTVRef,
		DecryptSetting: s.decryptSettingSecret, EncryptSetting: s.encryptSettingSecret,
		DecryptTaskInput: s.decryptTaskInputJSON, ProtectTaskSecrets: s.protectTaskSecrets,
		ManagedCredential:  func() (string, string, error) { k, b, _, _, err := s.lookupBeefTVCredential(); return k, b, err },
		UpscaleAvailable:   func(name string) error { _, err := s.upscaleConfig(name); return err },
		ValidateCapability: s.ValidateTaskCapability, ModelLookup: s.channelModelLookup(),
		DecodeShape:        func(raw []byte) (modelcatalog.TaskInput, error) { var t canvasGenerationInput; err := json.Unmarshal(raw, &t); return taskInputFromCanvas(t), err },
		OutputCount:        func(res, kind string) int { return len(localtask.CanonicalOutputs(res, kind)) },
		ImageRetryBlocked:  func(t *model.Task) bool { return s.validateImageTaskRetry(t) != nil },
		FailureBlocksRetry: persistedFailureBlocksRetry,
	})
}
func (s *Service) compileCanvasWorkflow(user string, d cw.Definition, existing ...model.CanvasWorkflow) (workflowRecipes, map[string]bool, error) {
	return cw.CompileRecipes(s.compileHost(), user, d, existing...)
}
func (s *Service) materializeCanvasWorkflowRequest(user, op string, recipe workflowRecipe, nodes map[string]cw.Node, steps map[string]*cw.Step) (CreateTaskRequest, error) {
	req, err := cw.Materialize(s.compileHost(), user, op, recipe, nodes, steps)
	return createTaskRequestFromRecipe(req), err
}
func createTaskRequestFromRecipe(r cw.RecipeRequest) CreateTaskRequest {
	return CreateTaskRequest{ProjectID: r.ProjectID, Type: r.Type, Operation: r.Operation, Prompt: r.Prompt, Provider: r.Provider, Model: r.Model, LogicalModelID: r.LogicalModelID, Input: r.Input}
}
