package operations

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/providerpreset"
)

// GenerationTarget freezes the paid inputs confirmed by the user. Delivered
// resource IDs may change as dependencies finish; their source node IDs may not.
type GenerationTarget struct {
	NodeID           string            `json:"nodeId"`
	Title            string            `json:"title"`
	Kind             string            `json:"kind"`
	ModelKey         string            `json:"modelKey"`
	Prompt           string            `json:"prompt"`
	Parameters       map[string]string `json:"parameters"`
	Metadata         map[string]any    `json:"metadata,omitempty"`
	ReferenceNodeIDs []string          `json:"referenceNodeIds"`
}

type GenerationAuthorization struct {
	SourceTurnID string             `json:"sourceTurnId"`
	ProposalID   string             `json:"proposalId"`
	Targets      []GenerationTarget `json:"targets"`
}

type GenerationOrderStatus string

const (
	GenerationOrderPending   GenerationOrderStatus = "pending"
	GenerationOrderApproved  GenerationOrderStatus = "approved"
	GenerationOrderSubmitted GenerationOrderStatus = "submitted"
)

type GenerationOrderTargetView struct {
	NodeID           string            `json:"nodeId"`
	Title            string            `json:"title"`
	Kind             string            `json:"kind"`
	Model            string            `json:"model"`
	ModelKey         string            `json:"modelKey"`
	Pricing          any               `json:"pricing"`
	Prompt           string            `json:"prompt"`
	Parameters       map[string]string `json:"parameters"`
	Metadata         map[string]any    `json:"metadata,omitempty"`
	ReferenceNodeIDs []string          `json:"referenceNodeIds"`
}

// GenerationOrder 是所有入口（内置助手、外部 MCP/CLI、确定性脚本）统一的生成单。
// 遵循「开单 → 批准 → 凭单执行」，任何付费生成都留有可核对的生成单记录。
type GenerationOrder struct {
	OrderID             string                      `json:"orderId"`
	ProposalID          string                      `json:"proposalId"`
	CanvasID            string                      `json:"canvasId"`
	CanvasRevision      int64                       `json:"canvasRevision"`
	ModelConfigRevision int64                       `json:"modelConfigRevision"`
	CallerKind          CallerKind                  `json:"callerKind"`
	CallerClient        string                      `json:"callerClient,omitempty"`
	ApprovalMode        ApprovalMode                `json:"approvalMode"`
	Status              GenerationOrderStatus       `json:"status"`
	ApprovedBy          string                      `json:"approvedBy,omitempty"`
	ApprovedAt          string                      `json:"approvedAt,omitempty"`
	Kind                string                      `json:"kind"`
	Model               string                      `json:"model"`
	ModelKey            string                      `json:"modelKey"`
	Pricing             any                         `json:"pricing"`
	Note                string                      `json:"note,omitempty"`
	NodeIDs             []string                    `json:"nodeIds"`
	ProductionNodeIDs   []string                    `json:"productionNodeIds,omitempty"`
	Targets             []GenerationTarget          `json:"targets"`
	TargetViews         []GenerationOrderTargetView `json:"targetViews,omitempty"`
	SourceTurnID        string                      `json:"sourceTurnId,omitempty"`
	TaskIDs             []string                    `json:"taskIds,omitempty"`
	Regenerate          bool                        `json:"regenerate,omitempty"`
	ContinuationID      string                      `json:"continuationId,omitempty"`
	CreatedAt           string                      `json:"createdAt"`
	UpdatedAt           string                      `json:"updatedAt"`
}

type AuthorizedGenerationAdmission interface {
	SubmitAuthorizedGeneration(userID, turnID, canvasID string, targets []GenerationTarget) (any, error)
}

type ProposedGenerationRecorder interface {
	RecordAssistantGenerationProposal(userID, turnID, canvasID string, proposal GenerationAuthorization) error
}

// External clients own execution approval; they still use the same task admission.
// releaseEnded 为 true 时按 regenerate 的规则释放节点上已经结束的结果。
type ExternalGenerationAdmission interface {
	SubmitExternalGeneration(userID, operationID, canvasID string, targets []GenerationTarget, releaseEnded bool) (any, error)
}

type GenerationOrderRecorder interface {
	RecordGenerationOrder(userID string, order GenerationOrder) error
	LookupGenerationOrder(userID, proposalID string) (*GenerationOrder, error)
}

func ResolveModelPricing(domain Domain, modelKey string) any {
	rawKey := strings.TrimSpace(modelKey)
	shortKey := rawKey
	channelID := ""
	if i := strings.Index(rawKey, "::"); i >= 0 {
		channelID = strings.TrimSpace(rawKey[:i])
		shortKey = strings.TrimSpace(rawKey[i+2:])
	}
	if reader, ok := domain.(ModelCatalogReader); ok {
		if catalog, err := reader.AgentModelCatalog(); err == nil && catalog != nil {
			for _, ch := range catalog.Channels {
				if channelID != "" && ch.ID != channelID {
					continue
				}
				for _, m := range ch.Models {
					if (m.ModelKey == shortKey || m.ID == shortKey || ch.ID+"::"+m.ModelKey == rawKey) && len(m.VideoPricing) > 0 {
						return m.VideoPricing
					}
				}
			}
		}
	}
	return "unknown"
}

func BuildGenerationOrderTargetViews(domain Domain, targets []GenerationTarget) []GenerationOrderTargetView {
	views := make([]GenerationOrderTargetView, 0, len(targets))
	for _, target := range targets {
		display := target.ModelKey
		if i := strings.LastIndex(display, "::"); i >= 0 {
			display = display[i+2:]
		}
		pricing := ResolveModelPricing(domain, target.ModelKey)
		params := target.Parameters
		if params == nil {
			params = map[string]string{}
		}
		refs := target.ReferenceNodeIDs
		if refs == nil {
			refs = []string{}
		}
		views = append(views, GenerationOrderTargetView{
			NodeID:           target.NodeID,
			Title:            target.Title,
			Kind:             target.Kind,
			Model:            display,
			ModelKey:         target.ModelKey,
			Pricing:          pricing,
			Prompt:           target.Prompt,
			Parameters:       params,
			Metadata:         target.Metadata,
			ReferenceNodeIDs: refs,
		})
	}
	return views
}

const generationSubmitParams = `{"type":"object","properties":{"canvasId":{"type":"string"},"proposalId":{"type":"string"},"orderId":{"type":"string"},"nodeIds":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8},"kind":{"type":"string","enum":["image","video","audio"]},"expectedRevision":{"type":"integer","minimum":1},"expectedModelConfigRevision":{"type":"integer","minimum":0}},"required":["canvasId","nodeIds"]}`

// generationAdmissionMode 区分两种付费受理。参数、校验和审批流程相同，
// 只有节点旧结果的释放规则不同（见 generation_resubmit.go）。
type generationAdmissionMode int

const (
	generationSubmit generationAdmissionMode = iota
	generationRegenerate
)

func registerGenerationSubmit(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, SubmitsGeneration: true, ID: "canvas.generation.submit", Summary: "凭已批准生成单执行画布生成并计费", Scope: ScopeCanvas,
		Params: json.RawMessage(generationSubmitParams), Handler: opGenerationSubmit})
}

func opGenerationSubmit(ctx *Context, raw json.RawMessage) (any, error) {
	return admitGeneration(ctx, raw, generationSubmit)
}

func admitGeneration(ctx *Context, raw json.RawMessage, mode generationAdmissionMode) (any, error) {
	var args struct {
		CanvasID                    string   `json:"canvasId"`
		ProposalID                  string   `json:"proposalId"`
		OrderID                     string   `json:"orderId"`
		NodeIDs                     []string `json:"nodeIds"`
		Kind                        string   `json:"kind"`
		ExpectedRevision            *int64   `json:"expectedRevision"`
		ExpectedModelConfigRevision *int64   `json:"expectedModelConfigRevision"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	proposalID := strings.TrimSpace(args.ProposalID)
	if proposalID == "" {
		proposalID = strings.TrimSpace(args.OrderID)
	}
	external := ctx.Caller.Kind == CallerExternal && !ctx.Caller.ReadOnly
	if !external && ctx.TurnID == "" {
		return nil, PermissionDenied("production_authorization_required", "请先确认本次制作方案")
	}
	if strings.TrimSpace(args.CanvasID) == "" || len(args.NodeIDs) == 0 || len(args.NodeIDs) > 8 {
		return nil, InvalidArg("invalid_batch", "canvasId 和 1 至 8 个 nodeIds 必填")
	}
	approvalMode := ctx.Caller.EffectiveApprovalMode()
	orderRecorder, hasOrderRecorder := ctx.Domain.(GenerationOrderRecorder)
	var existingOrder *GenerationOrder
	if external {
		if ctx.OperationID == "" {
			return nil, InvalidArg("generation_snapshot_required", "请先读取生成提议，并提交画布版本、模型配置版本和稳定 operationId")
		}
		if proposalID != "" && hasOrderRecorder {
			order, err := orderRecorder.LookupGenerationOrder(ctx.UserID, proposalID)
			if err != nil {
				return nil, AsError(err)
			}
			if order == nil || order.CanvasID != args.CanvasID {
				return nil, NotFound("generation_order_not_found", "生成单不存在")
			}
			existingOrder = order
		}
		switch approvalMode {
		case ApprovalModeAsk:
			if existingOrder == nil {
				hint := proposalID
				if hint == "" {
					hint = "<proposalId>"
				}
				return nil, PermissionDenied("generation_approval_required", "当前凭据设为「每次问我」，请先在 BeefTV 界面确认或运行 beeftv approve "+hint+" 批准生成单；Agent 自身凭据不能自批")
			}
			// owner 批准的是整张生成单，不能借一次部分节点的重做扩大成整单付费。
			if mode == generationRegenerate && !sameNodeIDSet(existingOrder.NodeIDs, args.NodeIDs) {
				return nil, InvalidArg("generation_scope_mismatch", "原地重做必须覆盖整张生成单的节点；请只为要重做的节点提出新生成单")
			}
			if existingOrder.Status == GenerationOrderSubmitted && len(existingOrder.TaskIDs) > 0 {
				if mode == generationRegenerate && !existingOrder.Regenerate {
					return nil, PermissionDenied("generation_approval_required", "这张生成单已按普通提交执行过；请重新提出生成单并由 owner 批准原地重做")
				}
				return map[string]any{
					"canvasId":     args.CanvasID,
					"orderId":      existingOrder.OrderID,
					"proposalId":   existingOrder.ProposalID,
					"approvalMode": string(existingOrder.ApprovalMode),
					"status":       string(existingOrder.Status),
					"taskIds":      existingOrder.TaskIDs,
				}, nil
			}
			if existingOrder.Status == GenerationOrderPending && mode != generationRegenerate {
				hint := existingOrder.ProposalID
				return nil, PermissionDenied("generation_approval_required", "当前凭据设为「每次问我」，请先在 BeefTV 界面确认或运行 beeftv approve "+hint+" 批准生成单；Agent 自身凭据不能自批")
			}
			if mode == generationRegenerate && existingOrder.Status != GenerationOrderPending && !existingOrder.Regenerate {
				return nil, PermissionDenied("generation_approval_required", "这张生成单不是用于原地重做的；请重新提出生成单并由 owner 批准")
			}
		case ApprovalModeAuto:
			if (args.ExpectedRevision != nil && *args.ExpectedRevision < 1) || (args.ExpectedModelConfigRevision != nil && *args.ExpectedModelConfigRevision < 0) {
				return nil, InvalidArg("generation_snapshot_required", "expectedRevision 和 expectedModelConfigRevision 无效")
			}
		default:
			if args.ExpectedRevision == nil || *args.ExpectedRevision < 1 || args.ExpectedModelConfigRevision == nil || *args.ExpectedModelConfigRevision < 0 {
				return nil, InvalidArg("generation_snapshot_required", "请先读取生成提议，并提交画布版本、模型配置版本和稳定 operationId")
			}
		}
	}
	docRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(docRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	currentRevision := canvasRevision(doc)
	if external && args.ExpectedRevision != nil && currentRevision != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取并确认生成内容", nil)
	}
	targets, err := GenerationTargets(ctx.Domain, doc, args.NodeIDs)
	if err != nil {
		return nil, err
	}
	var modelConfigRevision int64
	var firstChoice AssistantGenerationModel
	for i, target := range targets {
		if args.Kind != "" && target.Kind != args.Kind {
			return nil, InvalidArg("generation_kind_mismatch", "请按素材类型分批生成")
		}
		if external {
			choice, err := ctx.Domain.ResolveAssistantGenerationModel(target.Kind, target.ModelKey)
			if err != nil {
				return nil, AsError(err)
			}
			if args.ExpectedModelConfigRevision != nil && choice.Revision != *args.ExpectedModelConfigRevision {
				return nil, Conflict("generation_config_changed", "模型配置已变化，请重新读取生成提议", nil)
			}
			if i == 0 {
				firstChoice = choice
				modelConfigRevision = choice.Revision
			}
		}
	}
	if external && existingOrder != nil && !generationTargetsContainBatch(existingOrder.Targets, targets) {
		return nil, Conflict("generation_targets_changed", "画布上的生成参数已变化，请重新读取生成提议", nil)
	}
	nodes := map[string]map[string]any{}
	for _, v := range canvasNodes(doc) {
		n, _ := v.(map[string]any)
		nodes[dependencyString(n, "id")] = n
	}
	if err = validateGenerationDependencies(doc, nodes, args.NodeIDs, args.Kind); err != nil {
		return nil, err
	}
	// 「每次问我」下 regenerate 不能自批：先在这张生成单上登记「原地重做」，
	// 等 owner 批准时由审批路径按原地重做的规则释放旧结果。登记与操作回执同事务提交，
	// 因此这里返回成功但不建任务、不扣费；批准后调用方应换新的 operationId 再读回任务。
	if external && mode == generationRegenerate && approvalMode == ApprovalModeAsk && existingOrder != nil && existingOrder.Status == GenerationOrderPending {
		existingOrder.Regenerate = true
		existingOrder.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := orderRecorder.RecordGenerationOrder(ctx.UserID, *existingOrder); err != nil {
			return nil, AsError(err)
		}
		return map[string]any{
			"canvasId":         args.CanvasID,
			"orderId":          existingOrder.OrderID,
			"proposalId":       existingOrder.ProposalID,
			"approvalMode":     string(approvalMode),
			"status":           "pending_approval",
			"approvalRequired": true,
			"regenerate":       true,
			"nodeIds":          existingOrder.NodeIDs,
			"nextAction": map[string]any{
				"operation":  "beeftv approve " + existingOrder.ProposalID,
				"approval":   "owner-required",
				"proposalId": existingOrder.ProposalID,
				"message":    "生成单已标记为原地重做，尚未生成或扣费。请由 owner 在 BeefTV 界面确认或运行 beeftv approve 批准；批准后请用新的 operationId 再调用 canvas.generation.regenerate 读取任务。",
			},
		}, nil
	}
	if external {
		port, ok := ctx.Domain.(ExternalGenerationAdmission)
		if !ok {
			return nil, Unsupported("generation_unavailable", "当前工作区不能提交生成")
		}
		out, err := port.SubmitExternalGeneration(ctx.UserID, ctx.OperationID, args.CanvasID, targets, mode == generationRegenerate)
		if err != nil {
			return nil, err
		}
		if hasOrderRecorder {
			now := time.Now().UTC().Format(time.RFC3339)
			order := buildSubmittedExternalOrder(ctx, args.CanvasID, proposalID, currentRevision, modelConfigRevision, firstChoice, targets, existingOrder, out, now, mode == generationRegenerate)
			if err := orderRecorder.RecordGenerationOrder(ctx.UserID, order); err != nil {
				return nil, AsError(err)
			}
			if outMap, ok := out.(map[string]any); ok {
				outMap["orderId"] = order.OrderID
				outMap["proposalId"] = order.ProposalID
				outMap["approvalMode"] = string(order.ApprovalMode)
			}
		}
		return out, nil
	}
	port, ok := ctx.Domain.(AuthorizedGenerationAdmission)
	if !ok {
		return nil, Unsupported("generation_unavailable", "当前工作区不能自动执行制作")
	}
	return port.SubmitAuthorizedGeneration(ctx.UserID, ctx.TurnID, args.CanvasID, targets)
}

func generationTargetsContainBatch(planned, batch []GenerationTarget) bool {
	if len(batch) == 0 || len(planned) < len(batch) {
		return false
	}
	byID := make(map[string]GenerationTarget, len(planned))
	for _, item := range planned {
		byID[item.NodeID] = item
	}
	for _, item := range batch {
		expected, ok := byID[item.NodeID]
		if !ok || !reflect.DeepEqual(expected, item) {
			return false
		}
	}
	return true
}

// sameNodeIDSet 判断两次请求是否覆盖完全相同的节点集合。owner 批准按生成单执行整单，
// 所以 ask 模式下的原地重做不能只声明其中一个子集。
func sameNodeIDSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, id := range left {
		counts[id]++
	}
	for _, id := range right {
		if counts[id] == 0 {
			return false
		}
		counts[id]--
	}
	return true
}

func buildSubmittedExternalOrder(
	ctx *Context,
	canvasID, proposalID string,
	canvasRev, modelConfigRev int64,
	choice AssistantGenerationModel,
	targets []GenerationTarget,
	existing *GenerationOrder,
	submitResult any,
	now string,
	regenerate bool,
) GenerationOrder {
	taskIDs := extractSubmittedTaskIDs(submitResult)
	if existing != nil {
		updated := *existing
		updated.Status = GenerationOrderSubmitted
		updated.Regenerate = updated.Regenerate || regenerate
		if updated.ApprovedBy == "" {
			updated.ApprovedBy = string(ctx.Caller.EffectiveApprovalMode()) + ":" + ctx.Caller.EffectiveClientLabel()
		}
		if updated.ApprovedAt == "" {
			updated.ApprovedAt = now
		}
		updated.TaskIDs = taskIDs
		updated.UpdatedAt = now
		return updated
	}
	if proposalID == "" {
		proposalID = "go-" + ctx.OperationID
	}
	nodeIDs := make([]string, 0, len(targets))
	kind := ""
	for _, target := range targets {
		nodeIDs = append(nodeIDs, target.NodeID)
		if kind == "" {
			kind = target.Kind
		}
	}
	approvalMode := ctx.Caller.EffectiveApprovalMode()
	return GenerationOrder{
		OrderID:             proposalID,
		ProposalID:          proposalID,
		CanvasID:            canvasID,
		CanvasRevision:      canvasRev,
		ModelConfigRevision: modelConfigRev,
		CallerKind:          ctx.Caller.Kind,
		CallerClient:        ctx.Caller.EffectiveClientLabel(),
		ApprovalMode:        approvalMode,
		Status:              GenerationOrderSubmitted,
		Regenerate:          regenerate,
		ApprovedBy:          string(approvalMode) + ":" + ctx.Caller.EffectiveClientLabel(),
		ApprovedAt:          now,
		Kind:                kind,
		Model:               choice.Display,
		ModelKey:            choice.ModelKey,
		Pricing:             ResolveModelPricing(ctx.Domain, choice.ModelKey),
		NodeIDs:             nodeIDs,
		Targets:             targets,
		TargetViews:         BuildGenerationOrderTargetViews(ctx.Domain, targets),
		TaskIDs:             taskIDs,
		CreatedAt:           now,
		UpdatedAt:           now,
	}
}

func extractSubmittedTaskIDs(submitResult any) []string {
	outMap, ok := submitResult.(map[string]any)
	if !ok {
		return nil
	}
	switch raw := outMap["taskIds"].(type) {
	case []string:
		return raw
	case []any:
		ids := make([]string, 0, len(raw))
		for _, v := range raw {
			if s, ok := v.(string); ok && s != "" {
				ids = append(ids, s)
			}
		}
		return ids
	}
	return nil
}

// GenerationTargets is shared by proposal, UI confirmation and submission so
// the model cannot replace approved prompt/model/quantity between those steps.
func GenerationTargets(domain Domain, doc map[string]any, ids []string) ([]GenerationTarget, error) {
	if len(ids) == 0 || len(ids) > 24 {
		return nil, InvalidArg("invalid_batch", "制作素材须为1至24项")
	}
	nodes := map[string]map[string]any{}
	graph := generationDependencyGraph{nodes: nodes, incoming: map[string][]string{}, config: map[string]string{}}
	for _, v := range canvasNodes(doc) {
		n, _ := v.(map[string]any)
		nodes[dependencyString(n, "id")] = n
	}
	if edges, ok := doc["connections"].([]any); ok {
		for _, v := range edges {
			e, _ := v.(map[string]any)
			to, from := dependencyString(e, "toNodeId"), dependencyString(e, "fromNodeId")
			graph.incoming[to] = append(graph.incoming[to], from)
		}
	}
	seen := map[string]bool{}
	targets := []GenerationTarget{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		n := nodes[id]
		kind := nodeGenerationKind(n)
		if n == nil || (kind != "image" && kind != "video" && kind != "audio") {
			return nil, InvalidArg("invalid_generation_node", "请使用当前画布的图片、视频或音频节点")
		}
		meta := dependencyMetadata(n)
		choice, err := domain.ResolveAssistantGenerationModel(kind, nodeSelectedModel(n))
		if err != nil {
			return nil, AsError(err)
		}
		if choice.ModelKey == "" || choice.KindMismatch {
			return nil, PreconditionFailed("generation_model_unavailable", "素材模型暂不可用，请重新选择", nil)
		}
		prompt := dependencyString(meta, "composerContent")
		if prompt == "" {
			prompt = dependencyString(meta, "prompt")
		}
		if strings.TrimSpace(prompt) == "" {
			return nil, InvalidArg("missing_prompt", "制作素材缺少提示词或旁白文本")
		}
		parameters := map[string]string{}
		for _, key := range []string{"size", "quality", "count", "transparentBackground", "seconds", "vquality", "generateAudio", "watermark", "audioVoice", "audioFormat", "audioSpeed", "audioPitch", "audioVolume", "audioInstructions", "videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId"} {
			if v, ok := meta[key]; ok && v != nil {
				parameters[key] = fmt.Sprint(v)
			}
		}
		if kind == "image" {
			model := choice.ModelKey
			if i := strings.LastIndex(model, "::"); i >= 0 {
				model = model[i+2:]
			}
			if family := providerpreset.SeedreamFamily(model); family != "" {
				for _, key := range []string{"seedreamMode", "seedreamMaxImages", "seedreamOutputFormat", "seedreamOptimize", "seedreamWatermark"} {
					if v, ok := meta[key]; ok && v != nil {
						parameters[key] = fmt.Sprint(v)
					}
				}
				maxImages, _ := strconv.Atoi(parameters["seedreamMaxImages"])
				modern := family == "5.5" || family == "pro" || family == "flash"
				if parameters["seedreamMode"] == "layers" || (!modern && maxImages > 1) {
					return nil, InvalidArg("production_seedream_multiple_outputs", "整片制作暂不支持 Seedream 图层拆分或组图。请先在画布生成图片，再用已有图片继续制作。")
				}
			}
			if err := validateModelGenerationParameters(domain, kind, choice.ModelKey, parameters); err != nil {
				return nil, err
			}
		}
		var metadata map[string]any
		for _, key := range []string{"videoEditOperation", "videoOperation", "videoMiddleFrameTime", "videoReferenceOrder", "videoH3Options", "providerOptions"} {
			if value, ok := meta[key]; ok && value != nil {
				if metadata == nil {
					metadata = map[string]any{}
				}
				metadata[key] = value
			}
		}
		if count := parameters["count"]; count != "" && count != "1" {
			return nil, InvalidArg("production_image_count", "整片制作请为每张图片建立独立节点")
		}
		refs := graph.references(id, kind)
		sort.Strings(refs)
		refs = uniqueTargetIDs(refs)
		if kind == "video" {
			var reconcileErr error
			metadata, reconcileErr = reconcileCanvasVideoTarget(domain, choice.ModelKey, refs, graph, meta, parameters, metadata)
			if reconcileErr != nil {
				return nil, reconcileErr
			}
		}
		targets = append(targets, GenerationTarget{NodeID: id, Title: dependencyString(n, "title"), Kind: kind, ModelKey: choice.ModelKey, Prompt: prompt, Parameters: parameters, Metadata: metadata, ReferenceNodeIDs: refs})
	}
	return targets, nil
}

func resolveVideoMiddleFrameSupport(modelID string, videoProfile *modelcatalog.VideoCapabilityConfig, declared bool, managedBeefTV bool) string {
	if videoProfile != nil && videoProfile.MiddleFrame != nil {
		if *videoProfile.MiddleFrame {
			return "supported"
		}
		return "unsupported"
	}
	if managedBeefTV {
		if contract, ok := providerpreset.BeefTVVideoContract(modelID); ok && contract.MiddleFrame {
			return "supported"
		}
	}
	if declared {
		return "unsupported"
	}
	return "opaque"
}

func resolveVideoContractFlagSupport(contractFlag bool, hasRouteContract bool, declared bool, managedBeefTV bool) string {
	if hasRouteContract {
		if contractFlag {
			return "supported"
		}
		return "unsupported"
	}
	if declared || managedBeefTV {
		return "unsupported"
	}
	return "opaque"
}

func reconcileCanvasVideoTarget(domain Domain, modelKey string, refs []string, graph generationDependencyGraph, nodeMeta map[string]any, parameters map[string]string, metadata map[string]any) (map[string]any, error) {
	if strings.TrimSpace(dependencyString(nodeMeta, "videoDraftTaskId")) != "" {
		return metadata, nil
	}
	var rawVideoProfile, videoProfile *modelcatalog.VideoCapabilityConfig
	declared := false
	chID, modelID := modelcatalog.SplitModelKey(modelKey)
	managedBeefTV := strings.EqualFold(strings.TrimSpace(chID), "beeftv")
	if reader, ok := domain.(ModelCatalogReader); ok && reader != nil {
		if catalog, err := reader.AgentModelCatalog(); err == nil && catalog != nil {
			if foundChID, foundModel, found := findEstimateModel(catalog, modelKey); found {
				if foundModel.ManagedBeefTV != nil {
					managedBeefTV = *foundModel.ManagedBeefTV
				} else {
					managedBeefTV = strings.EqualFold(strings.TrimSpace(foundChID), "beeftv")
				}
				if capCfg := estimateCapability(foundModel.CapabilityConfig); capCfg != nil && capCfg.Video != nil {
					rawVideoProfile = capCfg.Video
					declared = foundModel.CapabilityDeclared == nil || *foundModel.CapabilityDeclared
					if declared || slices.Contains(capCfg.Video.Operations, "reference_to_video") {
						videoProfile = capCfg.Video
					}
				}
			} else if len(catalog.Channels) > 0 {
				managedBeefTV = false
			}
		}
	}
	routeContract, hasRouteContract := providerpreset.BeefTVVideoContract(modelID)
	var contract providerpreset.VideoContract
	hasContract := false
	if managedBeefTV && hasRouteContract {
		contract, hasContract = routeContract, true
	}
	middleFrameSupport := resolveVideoMiddleFrameSupport(modelID, rawVideoProfile, declared, managedBeefTV)
	if middleFrameSupport == "unsupported" {
		delete(parameters, "videoMiddleFrameNodeId")
		delete(metadata, "videoMiddleFrameTime")
	}
	if resolveVideoContractFlagSupport(routeContract.ReferenceOrder, hasRouteContract, declared, managedBeefTV) == "unsupported" {
		delete(metadata, "videoReferenceOrder")
	}
	if resolveVideoContractFlagSupport(routeContract.H3Options, hasRouteContract, declared, managedBeefTV) == "unsupported" {
		delete(metadata, "videoH3Options")
	}
	storedOp := strings.TrimSpace(dependencyString(nodeMeta, "videoEditOperation"))
	if storedOp != "" && !slices.Contains([]string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"}, storedOp) {
		return metadata, nil
	}
	var imageCount, characterCount, videoCount, audioCount int
	for _, refID := range refs {
		refMeta := dependencyMetadata(graph.nodes[refID])
		if dependencyString(refMeta, "workflowKind") == "character" {
			characterCount++
			continue
		}
		switch graph.label(refID) {
		case "角色":
			characterCount++
		case "图片", "绘图":
			imageCount++
		case "视频":
			videoCount++
		case "音频":
			audioCount++
		}
	}
	visualCount := imageCount + characterCount
	supportsRefVideo := videoProfile != nil && slices.Contains(videoProfile.Operations, "reference_to_video")
	supportsImageVideo := videoProfile == nil || slices.Contains(videoProfile.Operations, "image_to_video")
	frameMaxImages, frameMaxAudios := 2, 0
	if videoProfile != nil && videoProfile.OperationReferences != nil {
		frameRefs := modelcatalog.VideoReferencesForOperation(videoProfile, "image_to_video")
		frameMaxImages = min(2, frameRefs.MaxImages)
		frameMaxAudios = frameRefs.MaxAudios
	} else {
		hasContractFrameMaxImages := false
		if hasContract {
			if contractImg, ok := contract.OperationReferences["image_to_video"]["maxImages"]; ok {
				frameMaxImages = min(2, contractImg)
				hasContractFrameMaxImages = true
			} else if !declared {
				if maxImg, ok := contract.MaxReferences["image"]; ok {
					frameMaxImages = min(2, maxImg)
				}
			}
			if contractAud, ok := contract.OperationReferences["image_to_video"]["maxAudios"]; ok {
				frameMaxAudios = contractAud
			}
		}
		if videoProfile != nil {
			if !hasContractFrameMaxImages {
				frameMaxImages = min(2, videoProfile.References.MaxImages)
			} else if declared && frameMaxImages > videoProfile.References.MaxImages {
				frameMaxImages = min(2, videoProfile.References.MaxImages)
			}
			if !supportsRefVideo && declared {
				frameMaxAudios = videoProfile.References.MaxAudios
			} else if declared && frameMaxAudios > videoProfile.References.MaxAudios {
				frameMaxAudios = videoProfile.References.MaxAudios
			}
		}
	}
	if declared && !supportsRefVideo && visualCount > 0 {
		if !supportsImageVideo {
			return nil, InvalidArg("video_reference_image_limit", "当前视频模型不支持参考图")
		}
		if visualCount > frameMaxImages {
			return nil, InvalidArg("video_reference_image_limit", fmt.Sprintf("当前视频模型最多支持 %d 张首尾帧参考图", frameMaxImages))
		}
	}
	if frameMaxImages < 2 && (declared || hasContract) {
		delete(parameters, "videoEndFrameNodeId")
	}
	hasMiddleFrame := middleFrameSupport == "supported" && parameters["videoMiddleFrameNodeId"] != ""
	nextOp := storedOp
	if supportsRefVideo && (visualCount+videoCount+audioCount > 0) && (hasMiddleFrame || videoCount > 0 || characterCount > 0 || visualCount > frameMaxImages || (visualCount > 0 && audioCount > frameMaxAudios)) {
		nextOp = "reference_to_video"
	} else if storedOp == "reference_to_video" && declared && !supportsRefVideo && supportsImageVideo && videoCount == 0 && characterCount == 0 && imageCount > 0 && imageCount <= frameMaxImages && audioCount <= frameMaxAudios {
		nextOp = "image_to_video"
	} else if storedOp == "text_to_video" && supportsImageVideo && videoCount == 0 && characterCount == 0 && imageCount > 0 && imageCount <= frameMaxImages && audioCount <= frameMaxAudios {
		nextOp = "image_to_video"
	}
	if nextOp != "" && nextOp != storedOp {
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["videoEditOperation"] = nextOp
	}
	if nextOp == "reference_to_video" && (middleFrameSupport == "unsupported" || nextOp != storedOp) && middleFrameSupport != "supported" {
		delete(parameters, "videoStartFrameNodeId")
		delete(parameters, "videoEndFrameNodeId")
		delete(parameters, "videoMiddleFrameNodeId")
		delete(metadata, "videoMiddleFrameTime")
	}
	return metadata, nil
}

func uniqueTargetIDs(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if len(out) == 0 || out[len(out)-1] != id {
			out = append(out, id)
		}
	}
	return out
}
