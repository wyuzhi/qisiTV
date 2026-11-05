package canvasworkflow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/workspace"
)

func DecodeRecipes(decrypt func(string) (string, error), cipher string) (RecipesByNode, error) {
	plain, err := decrypt(cipher)
	if err != nil {
		return nil, &RecipeError{Decrypt: true, Err: err}
	}
	var recipes RecipesByNode
	if err = json.Unmarshal([]byte(plain), &recipes); err != nil {
		return nil, &RecipeError{Err: err}
	}
	return recipes, nil
}

func RecipeReferenceIDs(decrypt func(string) (string, error), cipher string) (map[string]bool, error) {
	recipes, err := DecodeRecipes(decrypt, cipher)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, recipe := range recipes {
		for id := range ReferenceIDs(recipe.Request.Input) {
			ids[id] = true
		}
	}
	return ids, nil
}

func ExecuteGenerateStep(
	compile CompileHost,
	user, op, cipher string,
	n Node,
	nodes map[string]Node,
	steps map[string]*Step,
	createTask func(string, RecipeRequest) (*model.Task, error),
) (*model.Task, error) {
	recipes, err := DecodeRecipes(compile.DecryptSetting, cipher)
	if err != nil {
		return nil, err
	}
	recipe, ok := recipes[n.ID]
	if !ok {
		return nil, BadRequest("生成配方缺失")
	}
	built, err := Materialize(compile, user, op, recipe, nodes, steps)
	var task *model.Task
	if err == nil {
		task, err = createTask(user, built)
	}
	if err == nil {
		return task, nil
	}
	videos := []string{}
	seen := map[string]bool{}
	for _, binding := range recipe.Bindings {
		if binding.Field != "referenceVideos" || seen[binding.NodeID] {
			continue
		}
		seen[binding.NodeID] = true
		if value := steps[binding.NodeID]; value != nil {
			if resource, resErr := ReadyResource(compile.Repository(), user, value.ResourceID, "video"); resErr == nil {
				videos = append(videos, fmt.Sprintf("%s（%.2f 秒）", nodes[binding.NodeID].Title, float64(resource.DurationMs)/1000))
			}
		}
	}
	return nil, fmt.Errorf("模型 %s；参考视频：%s；%w", recipe.Request.Model, strings.Join(videos, "、"), err)
}

func ExecuteDescribeStep(
	compile CompileHost,
	user, op string,
	n Node,
	resource string,
	createTask func(string, RecipeRequest) (*model.Task, error),
) (*model.Task, error) {
	built, err := DescribeRequest(compile, n, resource, op)
	if err != nil {
		return nil, err
	}
	return createTask(user, built)
}

func ExecuteRetryStep(
	compile CompileHost,
	row model.CanvasWorkflowRun,
	nodeID string,
	task *model.Task,
	recoverUpscale func(context.Context, string, string) (*model.Task, error),
	retryRefresh func(string, string, string, string) (*model.Task, error),
	retryTask func(string, string) (*model.Task, error),
) (*model.Task, error) {
	if task.IsUpscale() {
		return recoverUpscale(context.Background(), row.UserID, task.ID)
	}
	input, err := PrepareRetryCredentials(compile, row, nodeID, task)
	if err != nil {
		return nil, err
	}
	if input != "" {
		return retryRefresh(row.UserID, task.ID, task.InputJSON, input)
	}
	return retryTask(row.UserID, task.ID)
}

func LoadProviderConfig(dataDir string) (map[string]any, error) {
	store, err := workspace.NewProviderConfig(dataDir)
	if err != nil {
		return nil, err
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		return nil, BadRequest("本地模型配置不可读，请在设置中恢复配置后再运行工作流")
	}
	return effective.Config, nil
}

func ImageCreateAccepted(repo *repository.Repository, user, taskID string) (bool, error) {
	receipt, err := repo.ImageCreateReceipt(user, taskID)
	if err != nil {
		return false, err
	}
	return receipt != nil && receipt.StatusCode < 300, nil
}

func CompileRecipes(host CompileHost, user string, d Definition, existing ...model.CanvasWorkflow) (RecipesByNode, map[string]bool, error) {
	var saved *model.CanvasWorkflow
	if len(existing) > 0 {
		saved = &existing[0]
	}
	compiled, err := Compile(host, user, d, saved)
	if err != nil {
		return nil, nil, err
	}
	return compiled.Recipes, compiled.References, nil
}

type CompileHostConfig struct {
	Repo               *repository.Repository
	DataDir            string
	LocalMode          bool
	ManagedCredRef     string
	DecryptSetting     func(string) (string, error)
	EncryptSetting     func(string) (string, error)
	DecryptTaskInput   func(string) (string, error)
	ProtectTaskSecrets func(any) error
	ManagedCredential  func() (string, string, error)
	UpscaleAvailable   func(string) error
	ValidateCapability func(map[string]any) error
	DecodeShape        func([]byte) (modelcatalog.TaskInput, error)
	ModelLookup        modelcatalog.ChannelModelLookup
	OutputCount        func(string, string) int
	ImageRetryBlocked  func(*model.Task) bool
	FailureBlocksRetry func(string, string) bool
}

type compileHost struct{ cfg CompileHostConfig }

func NewCompileHost(cfg CompileHostConfig) CompileHost                               { return compileHost{cfg: cfg} }
func (h compileHost) DecryptSetting(v string) (string, error)                        { return h.cfg.DecryptSetting(v) }
func (h compileHost) EncryptSetting(v string) (string, error)                        { return h.cfg.EncryptSetting(v) }
func (h compileHost) DecryptTaskInput(raw string) (string, error)                    { return h.cfg.DecryptTaskInput(raw) }
func (h compileHost) ProtectTaskSecrets(v any) error                                 { return h.cfg.ProtectTaskSecrets(v) }
func (h compileHost) ProviderConfig() (map[string]any, error)                        { return LoadProviderConfig(h.cfg.DataDir) }
func (h compileHost) LocalMode() bool                                                { return h.cfg.LocalMode }
func (h compileHost) ManagedCredential() (string, string, error)                     { return h.cfg.ManagedCredential() }
func (h compileHost) ManagedCredentialRef() string                                   { return h.cfg.ManagedCredRef }
func (h compileHost) UpscaleAvailable(name string) error                             { return h.cfg.UpscaleAvailable(name) }
func (h compileHost) ValidateTaskShape(in map[string]any) (string, bool, error) {
	encoded, err := json.Marshal(in)
	if err != nil {
		return "", false, err
	}
	shape, err := h.cfg.DecodeShape(encoded)
	if err != nil {
		return "", false, err
	}
	shape.DeferReferenceMetadata = true
	validated, err := modelcatalog.ValidateConfiguredTask(shape, h.cfg.ModelLookup)
	if err != nil {
		return "", false, err
	}
	_, ok := in["config"].(map[string]any)
	return validated.Config.VQuality, ok, nil
}
func (h compileHost) SourceTask(u, id string) (*model.Task, error)                   { return h.cfg.Repo.TaskForUser(u, id) }
func (h compileHost) Repository() *repository.Repository                             { return h.cfg.Repo }
func (h compileHost) OutputCount(res, kind string) int                               { return h.cfg.OutputCount(res, kind) }
func (h compileHost) ImageRetryBlocked(t *model.Task) bool                           { return h.cfg.ImageRetryBlocked(t) }
func (h compileHost) ImageCreateAccepted(u, id string) (bool, error)                 { return ImageCreateAccepted(h.cfg.Repo, u, id) }
func (h compileHost) PersistedFailureBlocksRetry(m, s string) bool                   { return h.cfg.FailureBlocksRetry(m, s) }

type RunHostConfig struct {
	Compile        CompileHost
	CreateTask     func(string, RecipeRequest) (*model.Task, error)
	Upscale        func(string, string, Node, string) (*model.Task, error)
	CanvasMedia    func(string, string, Node, string) (*model.Task, error)
	DepthCapture   func(string, string, string) (*model.Task, error)
	TimelineRender func(string, string, editing.Project, editing.Options) (*model.Task, error)
	RecoverUpscale func(context.Context, string, string) (*model.Task, error)
	RetryRefresh   func(string, string, string, string) (*model.Task, error)
	RetryTask      func(string, string) (*model.Task, error)
	CancelTask     func(context.Context, string, string) error
	Outputs        func(*model.Task) ([]TaskOutput, []TaskOutput)
	FailureMessage func(string, string) string
	Draining       func() bool
	RunLoop        func(func(context.Context)) bool
}

type runHost struct{ cfg RunHostConfig }

func NewRunHost(cfg RunHostConfig) RunHost                                            { return runHost{cfg: cfg} }
func (h runHost) ReferenceIDs(cipher string) (map[string]bool, error)                 { return RecipeReferenceIDs(h.cfg.Compile.DecryptSetting, cipher) }
func (h runHost) Generate(u, op, cipher string, n Node, nodes map[string]Node, steps map[string]*Step) (*model.Task, error) {
	return ExecuteGenerateStep(h.cfg.Compile, u, op, cipher, n, nodes, steps, h.cfg.CreateTask)
}
func (h runHost) Describe(u, op string, n Node, res string) (*model.Task, error)      { return ExecuteDescribeStep(h.cfg.Compile, u, op, n, res, h.cfg.CreateTask) }
func (h runHost) Upscale(u, op string, n Node, res string) (*model.Task, error)       { return h.cfg.Upscale(u, op, n, res) }
func (h runHost) CanvasMedia(u, op string, n Node, res string) (*model.Task, error)   { return h.cfg.CanvasMedia(u, op, n, res) }
func (h runHost) DepthCapture(u, op, res string) (*model.Task, error)                 { return h.cfg.DepthCapture(u, op, res) }
func (h runHost) TimelineRender(u, op string, p editing.Project, opts editing.Options) (*model.Task, error) { return h.cfg.TimelineRender(u, op, p, opts) }
func (h runHost) RetryStep(row model.CanvasWorkflowRun, nodeID string, task *model.Task) (*model.Task, error) {
	return ExecuteRetryStep(h.cfg.Compile, row, nodeID, task, h.cfg.RecoverUpscale, h.cfg.RetryRefresh, h.cfg.RetryTask)
}
func (h runHost) CancelTask(ctx context.Context, u, id string) error                  { return h.cfg.CancelTask(ctx, u, id) }
func (h runHost) Outputs(task *model.Task) ([]TaskOutput, []TaskOutput)               { return h.cfg.Outputs(task) }
func (h runHost) FailureMessage(m, s string) string                                   { return h.cfg.FailureMessage(m, s) }
func (h runHost) Draining() bool                                                      { return h.cfg.Draining() }
func (h runHost) RunLoop(fn func(context.Context)) bool                               { return h.cfg.RunLoop(fn) }
