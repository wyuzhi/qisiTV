package canvasworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/editing"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

// TaskOutput is one stored output of a finished task.
type TaskOutput struct {
	OutputIndex int
	MediaType   string
	ResourceID  string
}

// RunHost submits and controls the tasks a run's steps depend on. Each method
// uses operation as the task's client operation ID so admission is idempotent.
type RunHost interface {
	// Generate submits a generation step from the template's private recipe.
	Generate(user, operation, recipeCipher string, n Node, nodes map[string]Node, steps map[string]*Step) (*model.Task, error)
	Describe(user, operation string, n Node, resource string) (*model.Task, error)
	Upscale(user, operation string, n Node, resource string) (*model.Task, error)
	CanvasMedia(user, operation string, n Node, resource string) (*model.Task, error)
	DepthCapture(user, operation, resource string) (*model.Task, error)
	TimelineRender(user, operation string, project editing.Project, options editing.Options) (*model.Task, error)
	// RetryStep retries a failed step task, refreshing credentials when needed.
	RetryStep(row model.CanvasWorkflowRun, nodeID string, task *model.Task) (*model.Task, error)
	CancelTask(ctx context.Context, user, id string) error
	// Outputs lists the task's stored outputs, canonical result first.
	Outputs(task *model.Task) (canonical []TaskOutput, stored []TaskOutput)
	// FailureMessage is the user-safe text for a persisted task failure.
	FailureMessage(message, stage string) string
	// ReferenceIDs lists every resource a recipe cipher references. A recipe
	// that cannot be read returns a *RecipeError.
	ReferenceIDs(recipeCipher string) (map[string]bool, error)
	Draining() bool
	RunLoop(fn func(context.Context)) bool
}

// RecipeError reports a private recipe that cannot be decrypted or parsed.
type RecipeError struct {
	Decrypt bool
	Err     error
}

func (e *RecipeError) Error() string { return e.Err.Error() }
func (e *RecipeError) Unwrap() error { return e.Err }

// Runs owns workflow run admission, scheduling, selection, retry and cancel.
type Runs struct {
	repo      *repository.Repository
	templates *Templates
	host      RunHost
	mu        *sync.Mutex
	loop      *bool
}

// NewRuns shares mu with Templates; loop records whether the scheduler runs.
func NewRuns(repo *repository.Repository, templates *Templates, host RunHost, mu *sync.Mutex, loop *bool) *Runs {
	return &Runs{repo: repo, templates: templates, host: host, mu: mu, loop: loop}
}

func RunFromRow(row model.CanvasWorkflowRun) (Run, error) {
	var v Run
	err := json.Unmarshal([]byte(row.StateJSON), &v)
	if v.Steps == nil {
		v.Steps = []Step{}
	}
	if v.Outputs == nil {
		v.Outputs = []Output{}
	}
	v.ID = row.ID
	v.TemplateID = row.TemplateID
	v.TemplateRevision = NormalizeRevision(row.TemplateRevision)
	v.TemplateName = row.TemplateName
	v.Status = row.Status
	v.CreatedAt = row.CreatedAt
	v.UpdatedAt = row.UpdatedAt
	return v, err
}

// StepOperation is the stable client operation ID of one run step.
func StepOperation(run, node string) string {
	sum := sha256.Sum256([]byte(run + ":" + node))
	return "canvas-workflow:" + hex.EncodeToString(sum[:])
}

// ReadyResource returns the user's saved resource, optionally of one kind.
func ReadyResource(repo *repository.Repository, user, id, kind string, probe ...func(context.Context, string, string) (*model.Resource, error)) (*model.Resource, error) {
	r, e := repo.ResourceForUser(user, id)
	if e != nil || r == nil || r.Status != model.ResourceStatusReady {
		return nil, BadRequest("工作流素材不存在或尚未保存，请先保存素材")
	}
	if kind != "" && localasset.NormalizeKind(r.Kind, r.MimeType) != kind {
		return nil, BadRequest("工作流素材类型与节点不一致")
	}
	mediaKind := localasset.NormalizeKind(r.Kind, r.MimeType)
	if len(probe) > 0 && probe[0] != nil && r.Provider == "local" && ((mediaKind == "audio" && r.DurationMs <= 0) || (mediaKind == "video" && (r.DurationMs <= 0 || r.Width <= 0 || r.Height <= 0))) {
		return probe[0](context.Background(), user, id)
	}
	return r, nil
}

// Use the host's trusted local-file metadata probe when the workspace supplies one.
func readyHostResource(host any, repo *repository.Repository, user, id, kind string) (*model.Resource, error) {
	if h, ok := host.(interface {
		ReadyResource(string, string, string) (*model.Resource, error)
	}); ok {
		return h.ReadyResource(user, id, kind)
	}
	return ReadyResource(repo, user, id, kind)
}

// ReferenceID reads the resource ID out of one stored media reference.
func ReferenceID(v any) string {
	m, _ := v.(map[string]any)
	for _, key := range []string{"resourceId", "storageKey", "url", "dataUrl", "id"} {
		raw, _ := m[key].(string)
		if strings.HasPrefix(raw, "resource:") {
			return strings.TrimPrefix(raw, "resource:")
		}
		if id := assets.IDFromFileURL(raw); id != "" {
			return id
		}
		if key == "resourceId" && raw != "" {
			return raw
		}
	}
	return ""
}

// ReferenceIDs collects every resource referenced anywhere in value.
func ReferenceIDs(value any) map[string]bool {
	ids := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			if id := ReferenceID(item); id != "" {
				ids[id] = true
			}
			for _, child := range item {
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		}
	}
	visit(value)
	return ids
}

// OutputResource finds the first resource in a task result.
func OutputResource(raw string) string {
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return ""
	}
	var walk func(any) string
	walk = func(v any) string {
		switch x := v.(type) {
		case map[string]any:
			if id := ReferenceID(x); id != "" {
				return id
			}
			for _, key := range []string{"images", "videos", "audios", "outputs", "result", "data", "video", "audio", "image"} {
				if id := walk(x[key]); id != "" {
					return id
				}
			}
		case []any:
			for _, item := range x {
				if id := walk(item); id != "" {
					return id
				}
			}
		}
		return ""
	}
	return walk(v)
}

func textOutput(task *model.Task) string {
	var v map[string]any
	_ = json.Unmarshal([]byte(task.ResultJSON), &v)
	for _, key := range []string{"text", "content", "output"} {
		if text, ok := v[key].(string); ok && text != "" {
			return text
		}
	}
	return task.TextDraft
}

func deliveryPaused(stage string) bool {
	return stage == "delivery_paused" || stage == "delivery_timed_out"
}

func (r *Runs) resource(user, id, kind string) (*model.Resource, error) {
	return readyHostResource(r.host, r.repo, user, id, kind)
}

func (r *Runs) Get(user, id string) (Run, error) {
	var row model.CanvasWorkflowRun
	if e := r.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		if errors.Is(e, gorm.ErrRecordNotFound) {
			return Run{}, NotFound()
		}
		return Run{}, e
	}
	return RunFromRow(row)
}

func (r *Runs) List(user, template string) ([]Run, error) {
	if _, e := r.templates.Get(user, template); e != nil {
		return nil, e
	}
	var rows []model.CanvasWorkflowRun
	if e := r.repo.DB().Where("user_id = ? AND template_id = ?", user, template).Order("created_at DESC").Limit(100).Find(&rows).Error; e != nil {
		return nil, e
	}
	out := []Run{}
	for _, row := range rows {
		v, e := RunFromRow(row)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *Runs) Start(user, id string, req RunRequest) (Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.host.Draining() {
		return Run{}, BadRequest("应用正在退出，请稍后重试")
	}
	if strings.TrimSpace(req.ClientOperationID) == "" || len(req.ClientOperationID) > 128 {
		return Run{}, BadRequest("缺少有效的本次运行标识")
	}
	req.TemplateRevision = NormalizeRevision(req.TemplateRevision)
	raw, _ := json.Marshal(struct {
		Template string
		Inputs   map[string]Value
		Revision int
	}{id, req.Inputs, req.TemplateRevision})
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var old model.CanvasWorkflowRun
	e := r.repo.DB().Where("user_id = ? AND client_operation_id = ?", user, req.ClientOperationID).First(&old).Error
	if e == nil {
		if old.RequestHash != hash {
			// Before revision pinning, revision 1 requests hashed only template and inputs.
			legacyRaw, _ := json.Marshal(struct {
				Template string
				Inputs   map[string]Value
			}{id, req.Inputs})
			legacyDigest := sha256.Sum256(legacyRaw)
			if req.TemplateRevision != 1 || NormalizeRevision(old.TemplateRevision) != 1 || old.RequestHash != hex.EncodeToString(legacyDigest[:]) {
				return Run{}, BadRequest("本次运行标识已用于不同输入，请重新确认运行")
			}
		}
		return RunFromRow(old)
	}
	if !errors.Is(e, gorm.ErrRecordNotFound) {
		return Run{}, e
	}
	template, e := r.templates.RevisionRow(user, id, req.TemplateRevision)
	if e != nil {
		return Run{}, e
	}
	public, e := TemplateFromRow(template)
	if e != nil {
		return Run{}, e
	}
	order, e := Validate(public.Definition)
	if e != nil {
		return Run{}, e
	}
	knownInputs := map[string]bool{}
	run := Run{Status: "queued", Steps: []Step{}, Outputs: []Output{}}
	refs := map[string]bool{}
	for _, n := range order {
		step := Step{NodeID: n.ID, Title: n.Title, Status: "pending"}
		if n.Role == "input" || n.Role == "constant" {
			v := Value{ResourceID: n.ResourceID, Text: n.Text}
			if n.Role == "input" {
				knownInputs[n.ID] = true
				if override, ok := req.Inputs[n.ID]; ok {
					v = override
				}
			}
			if n.MediaType == "text" {
				if strings.TrimSpace(v.Text) == "" || len(v.Text) > 100000 {
					return Run{}, BadRequest("请输入有效文本：" + n.Title)
				}
				v.ResourceID = ""
			} else {
				if _, e = r.resource(user, v.ResourceID, n.MediaType); e != nil {
					return Run{}, e
				}
				refs[v.ResourceID] = true
				v.Text = ""
			}
			step.Status = "succeeded"
			step.ResourceID = v.ResourceID
			step.Text = v.Text
		}
		run.Steps = append(run.Steps, step)
	}
	for key := range req.Inputs {
		if !knownInputs[key] {
			return Run{}, BadRequest("输入不属于此工作流或不允许替换：" + key)
		}
	}
	// Template references protect every revision, but admission must only depend
	// on this revision's immutable recipe and definition.
	frozenIDs, e := r.host.ReferenceIDs(template.RecipeCipher)
	if e != nil {
		var recipeErr *RecipeError
		if errors.As(e, &recipeErr) {
			return Run{}, recipeErr.Err
		}
		return Run{}, e
	}
	for _, n := range public.Definition.Nodes {
		if n.ResourceID != "" {
			frozenIDs[n.ResourceID] = true
		}
	}
	for resource := range frozenIDs {
		if _, e = r.resource(user, resource, ""); e != nil {
			return Run{}, e
		}
		refs[resource] = true
	}
	state, _ := json.Marshal(run)
	row := model.CanvasWorkflowRun{ID: kernel.NewID(), TemplateRevision: req.TemplateRevision, UserID: user, ClientOperationID: req.ClientOperationID, RequestHash: hash, TemplateID: id, TemplateName: template.Name, DefinitionJSON: template.DefinitionJSON, RecipeCipher: template.RecipeCipher, StateJSON: string(state), Status: run.Status}
	e = r.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&row).Error; e != nil {
			return e
		}
		return PersistReferences(tx, row.ID, user, refs)
	})
	if e != nil {
		return Run{}, e
	}
	return RunFromRow(row)
}

// StartScheduler advances queued and running runs every second until ctx ends.
func (r *Runs) StartScheduler(ctx context.Context) {
	r.mu.Lock()
	if *r.loop {
		r.mu.Unlock()
		return
	}
	*r.loop = true
	r.mu.Unlock()
	if !r.host.RunLoop(func(workerCtx context.Context) {
		defer func() { r.mu.Lock(); *r.loop = false; r.mu.Unlock() }()
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-workerCtx.Done():
				return
			case <-timer.C:
				r.AdvanceAll(workerCtx)
			}
		}
	}) {
		r.mu.Lock()
		*r.loop = false
		r.mu.Unlock()
	}
}

func (r *Runs) save(row *model.CanvasWorkflowRun, run Run) error {
	state, e := json.Marshal(run)
	if e != nil {
		return e
	}
	row.StateJSON = string(state)
	row.Status = run.Status
	return r.repo.DB().Save(row).Error
}

// AdvanceAll moves every queued or running run forward by one pass.
func (r *Runs) AdvanceAll(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ctx.Err() != nil || r.host.Draining() {
		return
	}
	var rows []model.CanvasWorkflowRun
	if r.repo.DB().Where("status IN ?", []string{"queued", "running"}).Order("created_at ASC").Find(&rows).Error != nil {
		return
	}
	for i := range rows {
		if ctx.Err() != nil || r.host.Draining() {
			return
		}
		r.Advance(&rows[i])
	}
}

func incomingResource(n Node, d Definition, steps map[string]*Step) string {
	resource := ""
	for _, edge := range d.Edges {
		if edge.To == n.ID {
			resource = steps[edge.From].ResourceID
		}
	}
	return resource
}

// Advance moves one run forward. Callers hold the shared lock.
func (r *Runs) Advance(row *model.CanvasWorkflowRun) {
	run, e := RunFromRow(*row)
	fail := func(message string) {
		run.Status, run.Error = "failed", message
		_ = r.save(row, run)
	}
	if e != nil {
		fail("工作流运行记录无法读取，请检查运行记录")
		return
	}
	var d Definition
	if json.Unmarshal([]byte(row.DefinitionJSON), &d) != nil {
		fail("工作流定义无法读取，请重新保存模板")
		return
	}
	if _, e = r.host.ReferenceIDs(row.RecipeCipher); e != nil {
		var recipeErr *RecipeError
		if errors.As(e, &recipeErr) && !recipeErr.Decrypt {
			fail("工作流配方无法读取，请重新保存模板")
		} else {
			fail("无法读取工作流配方，请重新保存模板")
		}
		return
	}
	nodes := map[string]Node{}
	steps := map[string]*Step{}
	for _, n := range d.Nodes {
		nodes[n.ID] = n
	}
	for i := range run.Steps {
		steps[run.Steps[i].NodeID] = &run.Steps[i]
	}
	run.Status = "running"
	run.Error = ""
	for i := range run.Steps {
		step := &run.Steps[i]
		n := nodes[step.NodeID]
		if n.Role == "constant" || n.Role == "input" || step.Status == "succeeded" {
			continue
		}
		if step.Status == "failed" {
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		ready := true
		for _, edge := range d.Edges {
			if edge.To == n.ID && steps[edge.From].Status != "succeeded" {
				ready = false
			}
		}
		if !ready {
			continue
		}
		if n.OperationID == "image.select" {
			step.Candidates = imageCandidates(n, d, steps)
			if len(step.Candidates) == 1 {
				step.ResourceID, step.Status = step.Candidates[0].ResourceID, "succeeded"
			} else if len(step.Candidates) > 1 {
				step.Status = "waiting_selection"
			} else {
				step.Status, step.Error, run.Status, run.Error = "failed", "上游没有可选择的图片", "failed", "上游没有可选择的图片"
			}
			if r.save(row, run) != nil {
				return
			}
			continue
		}
		var task *model.Task
		if step.TaskID != "" {
			task, e = r.repo.TaskForUser(row.UserID, step.TaskID)
		} else {
			op := StepOperation(row.ID, n.ID)
			task, e = r.repo.TaskByClientOperation(row.UserID, op)
			if e == nil && task == nil {
				switch {
				case strings.HasSuffix(n.OperationID, ".ai-upscale"):
					task, e = r.host.Upscale(row.UserID, op, n, incomingResource(n, d, steps))
				case n.OperationID == "image.describe":
					task, e = r.host.Describe(row.UserID, op, n, incomingResource(n, d, steps))
				case IsMediaOperation(n.OperationID):
					task, e = r.host.CanvasMedia(row.UserID, op, n, incomingResource(n, d, steps))
				case n.OperationID == "video.trim" || n.OperationID == "video.merge":
					task, e = r.timeline(row.UserID, op, n, d.Edges, steps)
				case n.Role == "depth" || n.OperationID == "video.depth":
					task, e = r.host.DepthCapture(row.UserID, op, incomingResource(n, d, steps))
				default:
					task, e = r.host.Generate(row.UserID, op, row.RecipeCipher, n, nodes, steps)
				}
			}
		}
		if e != nil {
			step.Status = "failed"
			step.Error = "无法执行此步骤：" + r.host.FailureMessage(e.Error(), "")
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		if task == nil {
			step.Status = "failed"
			step.Error = "原任务记录缺失，停止自动提交；请检查任务记录"
			run.Status = "failed"
			run.Error = step.Error
			break
		}
		step.TaskID = task.ID
		step.Status = "running"
		switch task.Status {
		case model.TaskStatusFailed, model.TaskStatusCancelled:
			step.Status = "failed"
			step.Error = r.host.FailureMessage(task.Error, task.Stage)
			if step.Error == "" {
				step.Error = "任务已失败或取消"
			}
			run.Status = "failed"
			run.Error = step.Error
		case model.TaskStatusSucceeded:
			canonical, stored := r.host.Outputs(task)
			if nodes[step.NodeID].MediaType == "text" {
				step.Text = textOutput(task)
				if step.Text != "" {
					step.Status = "succeeded"
				}
			} else {
				r.collectOutputs(row, step, n, d, nodes, task, canonical, stored, &run)
			}
			if step.Status != "succeeded" && (deliveryPaused(task.Stage) || nodes[step.NodeID].MediaType == "text" || len(canonical) == 0) {
				step.Status = "failed"
				step.Error = "任务完成但持久结果不可用，请在任务列表检查并恢复结果"
				run.Status = "failed"
				run.Error = step.Error
			}
		}
		// Persist each admitted task before scheduling a dependent step. The stable
		// operation ID reconciles a crash between admission and this checkpoint.
		if r.save(row, run) != nil {
			return
		}
		if run.Status == "failed" {
			break
		}
	}
	all := true
	run.Outputs = []Output{}
	for _, step := range run.Steps {
		if step.Status != "succeeded" {
			all = false
		}
	}
	for _, id := range d.OutputNodeIDs {
		step := steps[id]
		if step != nil && step.Status == "succeeded" {
			if step.ResourceID == "" && len(step.Candidates) > 1 {
				for _, value := range step.Candidates {
					run.Outputs = append(run.Outputs, Output{NodeID: id, MediaType: nodes[id].MediaType, ResourceID: value.ResourceID})
				}
			} else {
				run.Outputs = append(run.Outputs, Output{NodeID: id, MediaType: nodes[id].MediaType, ResourceID: step.ResourceID, Text: step.Text})
			}
		}
	}
	if all {
		run.Status = "succeeded"
	}
	_ = r.save(row, run)
}

// collectOutputs records a finished media task's saved outputs on its step.
func (r *Runs) collectOutputs(row *model.CanvasWorkflowRun, step *Step, n Node, d Definition, nodes map[string]Node, task *model.Task, canonical, stored []TaskOutput, run *Run) {
	step.Candidates = nil
	values := append(append([]TaskOutput{}, canonical...), stored...)
	seen := map[string]bool{}
	readyOutputs := map[int]bool{}
	for _, value := range values {
		if value.MediaType == n.MediaType && value.ResourceID != "" {
			if _, err := r.resource(row.UserID, value.ResourceID, n.MediaType); err != nil {
				continue
			}
			readyOutputs[value.OutputIndex] = true
			if seen[value.ResourceID] {
				continue
			}
			ref := model.CanvasWorkflowResource{OwnerID: row.ID, UserID: row.UserID, ResourceID: value.ResourceID}
			if r.repo.DB().Where("owner_id = ? AND resource_id = ?", row.ID, value.ResourceID).FirstOrCreate(&ref).Error != nil {
				continue
			}
			step.Candidates = append(step.Candidates, Value{ResourceID: value.ResourceID})
			seen[value.ResourceID] = true
		}
	}
	if n.MediaType == "image" && len(canonical) > len(readyOutputs) && len(canonical) > 1 {
		step.Status = "running"
		return
	}
	if n.MediaType == "image" && len(step.Candidates) > 1 {
		step.Status, step.ResourceID = "succeeded", ""
		for _, edge := range d.Edges {
			if edge.From == n.ID && nodes[edge.To].OperationID != "image.select" {
				step.Status, step.Error, run.Status, run.Error = "failed", "多张图片需先经过选择图片结果", "failed", "多张图片需先经过选择图片结果"
			}
		}
		return
	}
	id := OutputResource(task.ResultJSON)
	if id == "" {
		for _, output := range stored {
			if output.MediaType == n.MediaType && output.ResourceID != "" {
				id = output.ResourceID
				break
			}
		}
	}
	if id == "" {
		return
	}
	if _, e := r.resource(row.UserID, id, n.MediaType); e == nil {
		step.ResourceID = id
		step.Status = "succeeded"
		ref := model.CanvasWorkflowResource{OwnerID: row.ID, UserID: row.UserID, ResourceID: id}
		if e = r.repo.DB().Where("owner_id = ? AND resource_id = ?", row.ID, id).FirstOrCreate(&ref).Error; e != nil {
			step.Status = "running"
		}
	}
}

func imageCandidates(n Node, d Definition, steps map[string]*Step) []Value {
	values := []Value{}
	seen := map[string]bool{}
	for _, edge := range d.Edges {
		if edge.To != n.ID {
			continue
		}
		source := steps[edge.From]
		if source == nil {
			continue
		}
		candidates := source.Candidates
		if source.ResourceID != "" {
			candidates = []Value{{ResourceID: source.ResourceID}}
		}
		for _, value := range candidates {
			if value.ResourceID != "" && !seen[value.ResourceID] {
				values = append(values, value)
				seen[value.ResourceID] = true
			}
		}
	}
	return values
}

// timeline lowers trim and merge into the durable timeline render task. Its
// worker owns encoding, cancellation and resource recovery.
func (r *Runs) timeline(user, operation string, n Node, edges []Edge, steps map[string]*Step) (*model.Task, error) {
	project, options, err := TimelineProject(func(id string) (*model.Resource, error) { return r.resource(user, id, "video") }, n, edges, steps)
	if err != nil {
		return nil, err
	}
	return r.host.TimelineRender(user, operation, project, options)
}

// TimelineProject builds the timeline for a trim or merge step.
func TimelineProject(video func(id string) (*model.Resource, error), n Node, edges []Edge, steps map[string]*Step) (editing.Project, editing.Options, error) {
	incoming := make([]Edge, 0)
	for _, edge := range edges {
		if edge.To == n.ID {
			incoming = append(incoming, edge)
		}
	}
	sort.SliceStable(incoming, func(i, j int) bool { return incoming[i].Order < incoming[j].Order })
	visible := true
	project := editing.Project{Version: editing.ProjectVersion, Tracks: []editing.Track{{ID: "video", Kind: editing.KindVideo, Visible: &visible}}}
	options := editing.Options{}
	switch n.OperationID {
	case "video.trim":
		if len(incoming) != 1 {
			return project, options, BadRequest("视频裁剪需要一个视频输入")
		}
	case "video.merge":
		if len(incoming) < 2 {
			return project, options, BadRequest("视频合并需要至少两个视频输入")
		}
	default:
		return project, options, BadRequest("不支持的本地视频操作")
	}
	for i, edge := range incoming {
		step := steps[edge.From]
		if step == nil || step.Status != "succeeded" || step.ResourceID == "" {
			return project, options, BadRequest("视频输入尚未完成或没有已保存的素材")
		}
		resource, err := video(step.ResourceID)
		if err != nil {
			return project, options, err
		}
		start, duration := int64(0), resource.DurationMs
		if n.OperationID == "video.trim" {
			var end int64
			if value, ok := n.Config["startSeconds"]; ok {
				start, err = Seconds(value)
			}
			if err == nil {
				end, err = Seconds(n.Config["endSeconds"])
			}
			if err != nil || end <= start {
				return project, options, BadRequest("裁剪起止时间无效，结束时间必须大于开始时间")
			}
			if resource.DurationMs > 0 && end > resource.DurationMs {
				return project, options, BadRequest("裁剪结束时间不能超过视频时长")
			}
			duration = end - start
		}
		if duration <= 0 || duration > editing.MaxDurationMs-project.DurationMs {
			return project, options, BadRequest("视频时长缺失或超出支持范围，请先更新素材信息")
		}
		if i == 0 && resource.Width > 0 && resource.Height > 0 {
			// H.264 requires even dimensions; retain the first video's framing.
			options.Width = (resource.Width + 1) / 2 * 2
			options.Height = (resource.Height + 1) / 2 * 2
		}
		id := fmt.Sprintf("video-%d", i)
		project.Clips = append(project.Clips, editing.Clip{
			ID: id, NodeID: id, TrackID: "video", Kind: editing.KindVideo,
			StartMs: project.DurationMs, DurationMs: duration, SourceStartMs: start,
			SourceDurationMs: resource.DurationMs, Volume: 1,
			DirectMedia: &editing.DirectMedia{ID: id, Kind: editing.KindVideo, StorageKey: "resource:" + resource.ID},
		})
		project.DurationMs += duration
	}
	return project, options, nil
}

// Seconds converts a configured time in seconds to milliseconds.
func Seconds(value any) (int64, error) {
	var seconds float64
	switch number := value.(type) {
	case float64:
		seconds = number
	case int:
		seconds = float64(number)
	case int64:
		seconds = float64(number)
	case json.Number:
		var err error
		seconds, err = number.Float64()
		if err != nil {
			return 0, err
		}
	default:
		return 0, fmt.Errorf("时间必须是数字")
	}
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > float64(editing.MaxDurationMs)/1000 {
		return 0, fmt.Errorf("时间超出支持范围")
	}
	return int64(math.Round(seconds * 1000)), nil
}

// Select records the chosen image; choosing twice never submits downstream work twice.
func (r *Runs) Select(user, id, node, resource string) (Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var row model.CanvasWorkflowRun
	if err := r.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; err != nil {
		return Run{}, NotFound()
	}
	run, err := RunFromRow(row)
	if err != nil {
		return run, err
	}
	if run.Status != "running" {
		return run, BadRequest("当前工作流不在等待选择")
	}
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.NodeID != node {
			continue
		}
		if step.Status == "succeeded" && step.ResourceID == resource {
			return run, nil
		}
		if step.Status != "waiting_selection" {
			return run, BadRequest("此步骤不在等待选图")
		}
		for _, candidate := range step.Candidates {
			if candidate.ResourceID != resource {
				continue
			}
			if _, err := r.resource(user, resource, "image"); err != nil {
				return run, err
			}
			step.ResourceID, step.Status = resource, "succeeded"
			if err := r.save(&row, run); err != nil {
				return run, err
			}
			return RunFromRow(row)
		}
		return run, BadRequest("请选择本轮生成的候选图片")
	}
	return run, BadRequest("选择步骤不存在")
}

func (r *Runs) Retry(user, id string) (Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var row model.CanvasWorkflowRun
	if e := r.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; e != nil {
		return Run{}, NotFound()
	}
	run, e := RunFromRow(row)
	if e != nil {
		return Run{}, e
	}
	if run.Status != "failed" {
		return Run{}, BadRequest("只有失败的运行可以重试")
	}
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.Status != "failed" {
			continue
		}
		if step.TaskID != "" {
			task, e := r.repo.TaskForUser(user, step.TaskID)
			if e != nil {
				return Run{}, e
			}
			if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
				if task, e = r.host.RetryStep(row, step.NodeID, task); e != nil {
					return Run{}, e
				}
			}
			step.TaskID = task.ID
		}
		step.Status = "pending"
		step.Error = ""
	}
	run.Status = "queued"
	run.Error = ""
	if e = r.save(&row, run); e != nil {
		return Run{}, e
	}
	return RunFromRow(row)
}

func (r *Runs) Cancel(ctx context.Context, user, id string) (Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var row model.CanvasWorkflowRun
	if e := r.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; e != nil {
		return Run{}, NotFound()
	}
	run, e := RunFromRow(row)
	if e != nil {
		return Run{}, e
	}
	if run.Status == "succeeded" || run.Status == "cancelled" {
		return run, nil
	}
	run.Status = "cancelled"
	for i := range run.Steps {
		step := &run.Steps[i]
		if step.Status == "pending" || step.Status == "running" || step.Status == "waiting_selection" {
			if step.TaskID == "" {
				task, lookupErr := r.repo.TaskByClientOperation(user, StepOperation(row.ID, step.NodeID))
				if lookupErr != nil {
					return Run{}, lookupErr
				}
				if task != nil {
					step.TaskID = task.ID
				}
			}
			if step.TaskID != "" {
				if e = r.host.CancelTask(ctx, user, step.TaskID); e != nil {
					step.Error = "已停止后续步骤；当前上游任务无法立即取消，请在任务列表查看"
				}
			}
			step.Status = "cancelled"
		}
	}
	if e = r.save(&row, run); e != nil {
		return Run{}, e
	}
	return RunFromRow(row)
}
