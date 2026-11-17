package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/editing"
	localtask "qisitv/backend/internal/task"
)

const canvasDeliveryDefaultTitle = "成片"

func registerCanvasTimelineDeliverOp(r *Registry) {
	// ExternalOnly keeps the built-in host from listing this operation beside
	// its existing composed canvas_timeline_deliver tool: both would reduce to
	// the same tool name. Remove it together with that JS tool when the host
	// moves to the Go operation.
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, ID: "canvas.timeline.deliver", Summary: "一次完成保存时间线、开始免费本地渲染并建好自动绑定的成片节点", Scope: ScopeCanvas,
		Params: canvasTimelineDeliverSchema(), Handler: opCanvasTimelineDeliver})
}

func canvasTimelineDeliverSchema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{` +
		`"canvasId":{"type":"string"},` +
		`"expectedRevision":{"type":"integer","minimum":0},` +
		`"timeline":` + timelineProjectSchema + `,` +
		`"refreshNodeIds":` + timelineRefreshNodeIDsSchema + `,` +
		`"options":` + timelineRenderOptionsSchema + `,` +
		`"title":{"type":"string","maxLength":120,"description":"成片节点标题，默认「成片」；重名时自动加序号"}` +
		`},"required":["canvasId","expectedRevision"],` +
		`"description":"timeline 与 refreshNodeIds 至多提供一个；都不提供时渲染当前已保存的时间线。保存、创建成片节点和开始渲染一次提交，失败不留下半成品。返回后用 task.get 查询，等渲染结束（有 task.wait 时可用它等待），成片节点会自动绑定；导出工程请调用 canvas.project.export。"}`)
}

// opCanvasTimelineDeliver is the external-agent one-step delivery path. It stays
// outside the built-in assistant catalog: the host keeps its own composition
// tool until the parity rollout moves it here.
func opCanvasTimelineDeliver(ctx *Context, params json.RawMessage) (any, error) {
	var wire struct {
		timelineEditWire
		Options editing.Options `json:"options"`
		Title   string          `json:"title"`
	}
	if err := decodeParams(params, &wire); err != nil {
		return nil, err
	}
	edit := timelineEditFromParams(params, wire.timelineEditWire)
	if strings.TrimSpace(edit.canvasID) == "" || edit.expectedRevision == nil || *edit.expectedRevision < 0 || strings.TrimSpace(ctx.OperationID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、expectedRevision 和稳定操作标识必填")
	}
	if edit.hasTimeline && edit.hasRefresh {
		return nil, InvalidArg("invalid_params", "timeline 与 refreshNodeIds 至多提供一个")
	}
	if (edit.hasTimeline && edit.timeline == nil) || (edit.hasRefresh && edit.refreshNodeIDs == nil) {
		return nil, InvalidArg("invalid_params", "timeline 与 refreshNodeIds 必须是有效值")
	}
	if utf8.RuneCountInString(wire.Title) > 120 {
		return nil, InvalidArg("invalid_params", "title 最多 120 个字符")
	}
	doc, err := canvasDocAtRevision(ctx, edit.canvasID, *edit.expectedRevision)
	if err != nil {
		return nil, err
	}
	// All three writes share this operation's transaction. Calling the separate
	// update/render operations instead would open their own transactions and
	// could leave a saved timeline or a node without a render.
	// Save first: the render must use the saved timeline, and the result node
	// must be created at the revision that write produced.
	revision, err := applyTimelineEdit(ctx, edit, params, doc)
	if err != nil {
		return nil, err
	}
	doc, err = canvasDocAtRevision(ctx, edit.canvasID, revision)
	if err != nil {
		return nil, err
	}
	if doc["timeline"] == nil {
		return nil, InvalidArg("invalid_timeline", "画布中没有可渲染的时间线")
	}
	var timeline editing.Project
	rawTimeline, err := json.Marshal(doc["timeline"])
	if err != nil || json.Unmarshal(rawTimeline, &timeline) != nil {
		return nil, InvalidArg("invalid_timeline", "画布中没有有效时间线")
	}
	sources, err := timelineSources(ctx, doc, &timeline)
	if err != nil {
		return nil, err
	}
	if _, err = editing.Compile(timeline, sources, wire.Options); err != nil {
		return nil, InvalidArg("invalid_timeline", err.Error())
	}
	// Same-character titles are user content, so a repeat adds a suffix instead
	// of refusing the whole delivery.
	title := canvasDeliveryTitle(doc, wire.Title)
	summary, created, err := ctx.Domain.CreateUserCanvasNodes(ctx.UserID, edit.canvasID,
		[]canvas.NodeDraft{{Type: "video", Title: title}}, revision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if len(created) != 1 || strings.TrimSpace(created[0].ID) == "" {
		return nil, newError(CodeInternal, "delivery_node_missing", "没有创建成片节点", nil)
	}
	admission, ok := ctx.Domain.(TimelineRenderAdmission)
	if !ok {
		return nil, Unsupported("timeline_render_unavailable", "当前工作区无法创建本地渲染任务")
	}
	task, err := admission.CreateCanvasTimelineRender(ctx.UserID, localtask.TimelineRenderCreateRequest{
		ProjectID:         edit.canvasID,
		Timeline:          timeline,
		Options:           wire.Options,
		ClientOperationID: canvasDeliveryTaskKey(ctx.OperationID),
		TargetNodeID:      created[0].ID,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return map[string]any{
		"canvasId":         edit.canvasID,
		"renderTaskId":     task.ID,
		"resultNodeId":     created[0].ID,
		"timelineRevision": revision,
		"revision":         summary.Revision,
		"title":            title,
		"status":           task.Status,
		"local":            true,
		"charged":          false,
	}, nil
}

// canvasDeliveryTaskKey derives a valid, stable render sub-key from the
// operation id. The caller's id is not constrained here, while task admission
// only accepts its own character set.
func canvasDeliveryTaskKey(operationID string) string {
	sum := sha256.Sum256([]byte("canvas.timeline.deliver:" + strings.TrimSpace(operationID)))
	return "canvas-deliver:" + hex.EncodeToString(sum[:16])
}

// canvasDeliveryTitle picks a free node title without a second canvas read.
func canvasDeliveryTitle(doc map[string]any, requested string) string {
	requested = canvas.NormalizeNodeTitle(requested)
	if requested == "" {
		requested = canvasDeliveryDefaultTitle
	}
	names := map[string]bool{}
	for _, raw := range canvasNodes(doc) {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if title, _ := node["title"].(string); canvas.NormalizeNodeTitle(title) != "" {
			names[canvas.NormalizeNodeTitle(title)] = true
		}
	}
	title := requested
	for index := 2; names[title]; index++ {
		suffix := " · " + strconv.Itoa(index)
		limit := 120 - utf8.RuneCountInString(suffix)
		if limit < 1 {
			limit = 1
		}
		title = truncateDeliveryTitle(requested, limit) + suffix
	}
	return title
}

// truncateDeliveryTitle keeps a deduped title inside the advertised limit
// without adding an ellipsis the caller never typed.
func truncateDeliveryTitle(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
