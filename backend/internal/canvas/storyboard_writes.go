package canvas

import (
	"crypto/rand"
	"encoding/hex"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/writechange"
)

// maxStoryboardRowsPerCall 是单次分镜行写入的批量上限。一次拆完一集的常见规模远低于此；
// 超过该值更可能是调用方把多集内容混进一次调用，应拆分提交。
const maxStoryboardRowsPerCall = 32

// defaultStoryboardShotSeconds 对齐前端 createStoryboardRow 的默认镜头时长。
const defaultStoryboardShotSeconds = float64(6)

const StoryboardMinShotSeconds = 1
const StoryboardMaxShotSeconds = 60

// storyboardNodeType 是承载分镜表的节点类型；分镜行操作只接受它。
const storyboardNodeType = "script"

// StoryboardRowDraft 是外部入口可写入的分镜行字段集合（白名单），全部为指针：
// nil 表示本次不写该字段。行 ID、镜号、生成状态、角色与资产引用不在其中——它们由界面
// 或生成流程维护，外部写入无法校验引用归属。生成产物节点绑定只在 StoryboardRowPatch 上。
type StoryboardRowDraft struct {
	DurationSeconds       *float64  `json:"durationSeconds"`
	PlotDescription       *string   `json:"plotDescription"`
	Dialogue              *string   `json:"dialogue"`
	NarrativeIntent       *string   `json:"narrativeIntent"`
	ViewerPOV             *string   `json:"viewerPOV"`
	PerformanceBlocking   *string   `json:"performanceBlocking"`
	ShotSize              *string   `json:"shotSize"`
	Emotion               *string   `json:"emotion"`
	LightingAndAtmosphere *string   `json:"lightingAndAtmosphere"`
	AudioEffects          *string   `json:"audioEffects"`
	Camera                *string   `json:"camera"`
	Motion                *string   `json:"motion"`
	TimeBeats             *string   `json:"timeBeats"`
	ImageGenerationPrompt *string   `json:"imageGenerationPrompt"`
	VideoMotionPrompt     *string   `json:"videoMotionPrompt"`
	MustHave              *[]string `json:"mustHave"`
	OptionalDetails       *[]string `json:"optionalDetails"`
	ContinuityOut         *string   `json:"continuityOut"`
	NegativePrompt        *string   `json:"negativePrompt"`
}

// StoryboardRowPatch 定位一行并给出要覆盖的字段子集。
// ImageNodeID / VideoNodeID 绑定本行的首帧图片与镜头视频节点：nil 不改，空串解绑，
// 非空必须是同一画布里类型匹配的节点；绑定同时维护本行该类产出的唯一连线。
type StoryboardRowPatch struct {
	RowID string `json:"rowId"`
	StoryboardRowDraft
	ImageNodeID *string `json:"imageNodeId"`
	VideoNodeID *string `json:"videoNodeId"`
}

// IsZero 判断 patch 是否既没有字段也没有绑定。
func (p StoryboardRowPatch) IsZero() bool {
	return p.StoryboardRowDraft.IsZero() && p.ImageNodeID == nil && p.VideoNodeID == nil
}

// StoryboardRowUpdate 是行更新的领域回执；连线 ID 是本次绑定实际新增和删除的产出连线，
// SyncedNodeIDs 与 SkippedNodeIDs 记录分镜提示词更新时自动同步或因节点草稿已单独手改而跳过同步的绑定节点。
// AlsoChanged 只列本次实际写入的字段，不把「判断为可同步」却值未变的节点算作连带改动。
type StoryboardRowUpdate struct {
	Updated        []StoryboardRowIdentity
	CreatedEdgeIDs []string
	DeletedEdgeIDs []string
	SyncedNodeIDs  []string
	SkippedNodeIDs []string
	AlsoChanged    []writechange.Node
}

// StoryboardRowIdentity 是写入成功后由领域返回的行身份；
// 与 CreatedNode 同理：调用方必须用行 ID 继续工作，不能用镜号回找。
type StoryboardRowIdentity struct {
	ID         string `json:"id"`
	ShotNumber int    `json:"shotNumber"`
}

// IsZero 判断草稿是否一个字段都没给；update 必须至少给一个字段。
func (d StoryboardRowDraft) IsZero() bool {
	return d == StoryboardRowDraft{}
}

// AppendUserCanvasStoryboardRows 在分镜脚本节点末尾追加一批行：
// 行 ID 与镜号由领域分配（镜号从现有行数 +1 递增），行形状对齐前端完整默认值。
func (s *Service) AppendUserCanvasStoryboardRows(userID, canvasID, nodeID string, drafts []StoryboardRowDraft, expectedRevision int64) (UserDataSummary, []StoryboardRowIdentity, error) {
	if err := requireStoryboardRows(drafts); err != nil {
		return UserDataSummary{}, nil, err
	}
	doc, storyboard, rows, err := s.loadStoryboardRows(userID, canvasID, nodeID)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	created := make([]StoryboardRowIdentity, 0, len(drafts))
	for _, draft := range drafts {
		shotNumber := len(rows) + 1
		rows = append(rows, buildStoryboardRow(shotNumber, draft))
		created = append(created, StoryboardRowIdentity{ID: rowIDOf(rows[len(rows)-1]), ShotNumber: shotNumber})
	}
	summary, err := s.saveStoryboardRows(userID, canvasID, doc, storyboard, rows, expectedRevision)
	if err != nil {
		return UserDataSummary{}, nil, err
	}
	return summary, created, nil
}

// UpdateUserCanvasStoryboardRows 按行 ID 整批局部更新：只覆盖草稿给出的字段，
// 其余字段逐字保留；任何一个行 ID 或绑定节点无效则整批拒绝，不产生部分写入。
func (s *Service) UpdateUserCanvasStoryboardRows(userID, canvasID, nodeID string, patches []StoryboardRowPatch, expectedRevision int64) (UserDataSummary, StoryboardRowUpdate, error) {
	if err := requireStoryboardPatches(patches); err != nil {
		return UserDataSummary{}, StoryboardRowUpdate{}, err
	}
	doc, storyboard, rows, err := s.loadStoryboardRows(userID, canvasID, nodeID)
	if err != nil {
		return UserDataSummary{}, StoryboardRowUpdate{}, err
	}
	result := StoryboardRowUpdate{
		Updated:        make([]StoryboardRowIdentity, 0, len(patches)),
		CreatedEdgeIDs: []string{},
		DeletedEdgeIDs: []string{},
		SyncedNodeIDs:  []string{},
		SkippedNodeIDs: []string{},
		AlsoChanged:    []writechange.Node{},
	}
	seen := map[string]bool{}
	for _, patch := range patches {
		row := findStoryboardRow(rows, patch.RowID)
		if row == nil {
			return UserDataSummary{}, StoryboardRowUpdate{}, kernel.NewAppError(http.StatusNotFound, "分镜行不存在: "+patch.RowID)
		}
		if seen[patch.RowID] {
			return UserDataSummary{}, StoryboardRowUpdate{}, kernel.NewAppError(http.StatusBadRequest, "同一批次内行重复: "+patch.RowID)
		}
		seen[patch.RowID] = true
		oldImagePrompt, _ := row["imageGenerationPrompt"].(string)
		oldVideoPrompt, _ := row["videoMotionPrompt"].(string)
		oldPlot, _ := row["plotDescription"].(string)
		applyStoryboardRowDraft(row, patch.StoryboardRowDraft)
		for _, binding := range []struct {
			field, kind string
			target      *string
		}{{"imageNodeId", "image", patch.ImageNodeID}, {"videoNodeId", "video", patch.VideoNodeID}} {
			if binding.target == nil {
				continue
			}
			created, deleted, err := bindStoryboardRowOutput(doc, nodeID, row, binding.field, binding.kind, *binding.target)
			if err != nil {
				return UserDataSummary{}, StoryboardRowUpdate{}, err
			}
			result.CreatedEdgeIDs = append(result.CreatedEdgeIDs, created...)
			result.DeletedEdgeIDs = append(result.DeletedEdgeIDs, deleted...)
		}
		for _, syncSpec := range []struct {
			field, kind string
			oldPrompt   string
			nextPrompt  *string
		}{
			{"imageNodeId", "image", oldImagePrompt, patch.ImageGenerationPrompt},
			{"videoNodeId", "video", oldVideoPrompt, patch.VideoMotionPrompt},
		} {
			if syncSpec.nextPrompt == nil {
				continue
			}
			boundID, _ := row[syncSpec.field].(string)
			if boundID == "" {
				continue
			}
			target := findCanvasNode(doc, boundID)
			if target == nil || canvasNodeType(target) != syncSpec.kind {
				continue
			}
			if synced, fields := syncBoundStoryboardNodeDraft(target, syncSpec.oldPrompt, oldPlot, *syncSpec.nextPrompt); synced {
				result.SyncedNodeIDs = appendUniqueStoryboardID(result.SyncedNodeIDs, boundID)
				title, _ := target["title"].(string)
				result.AlsoChanged = writechange.Add(result.AlsoChanged, boundID, title, fields...)
			} else {
				result.SkippedNodeIDs = appendUniqueStoryboardID(result.SkippedNodeIDs, boundID)
			}
		}
		result.Updated = append(result.Updated, StoryboardRowIdentity{ID: patch.RowID, ShotNumber: rowShotNumber(row)})
	}
	summary, err := s.saveStoryboardRows(userID, canvasID, doc, storyboard, rows, expectedRevision)
	if err != nil {
		return UserDataSummary{}, StoryboardRowUpdate{}, err
	}
	return summary, result, nil
}

// bindStoryboardRowOutput 写入行的产出节点绑定，并让本行同类产出连线只剩指向绑定节点的一条。
// 其他行、另一类产出、素材引用和指向已删除节点的连线原样保留。
func bindStoryboardRowOutput(doc map[string]any, scriptID string, row map[string]any, field, kind, targetID string) ([]string, []string, error) {
	if targetID != "" {
		target := findCanvasNode(doc, targetID)
		if target == nil {
			return nil, nil, &kernel.AppError{Status: http.StatusNotFound, Reason: kernel.ErrorReason("node_not_in_canvas"),
				Message: field + " 指向的节点不在这个画布: " + targetID}
		}
		if canvasNodeType(target) != kind {
			return nil, nil, &kernel.AppError{Status: http.StatusBadRequest, Reason: kernel.ErrorReason("node_kind_mismatch"),
				Message: field + " 只能绑定 " + kind + " 节点，" + targetID + " 是 " + canvasNodeType(target)}
		}
		row[field] = targetID
	} else {
		delete(row, field)
	}
	rowID := rowIDOf(row)
	connections, _ := doc["connections"].([]any)
	kept := make([]any, 0, len(connections)+1)
	var created, deleted []string
	linked := false
	for _, raw := range connections {
		edge, ok := raw.(map[string]any)
		if ok && isStoryboardRowOutput(edge, scriptID, rowID) {
			to, _ := edge["toNodeId"].(string)
			if targetID != "" && to == targetID && !linked {
				linked = true
			} else if target := findCanvasNode(doc, to); canvasNodeType(target) == kind {
				// 动作演示板也从分镜行连出，但不是首帧产出。绑定或解绑首帧不能断开它。
				metadata, _ := target["metadata"].(map[string]any)
				if metadata["workflowKind"] == "action_board" {
					kept = append(kept, raw)
					continue
				}
				id, _ := edge["id"].(string)
				deleted = append(deleted, id)
				continue
			}
		}
		kept = append(kept, raw)
	}
	if targetID != "" && !linked {
		id := newStoryboardEdgeID()
		kept = append(kept, map[string]any{"id": id, "fromNodeId": scriptID, "toNodeId": targetID,
			"fromHandleId": "row:" + rowID, "relation": "storyboard-output", "storyboardRowId": rowID})
		created = append(created, id)
	}
	doc["connections"] = kept
	return created, deleted, nil
}

// isStoryboardRowOutput 识别从分镜行连出的产出连线：界面拖线只带行句柄，生成流程额外带 relation。
func isStoryboardRowOutput(edge map[string]any, scriptID, rowID string) bool {
	if edge["fromNodeId"] != scriptID {
		return false
	}
	handle, _ := edge["fromHandleId"].(string)
	tagged, _ := edge["storyboardRowId"].(string)
	return handle == "row:"+rowID || edge["relation"] == "storyboard-output" && tagged == rowID
}

// syncBoundStoryboardNodeDraft 在分镜行提示词更新时，把未单独手改过的绑定媒体节点草稿一并更新。
// 若节点草稿已被单独改为不同于原分镜提示词的内容，则保留节点手改稿并返回 false。
// 返回值 second 是本次调用实际改到的草稿字段，按写入顺序去重；模板缓存等内部键的清理
// 不列进回执，模型只需要知道用户可编辑的草稿字段变了。
func syncBoundStoryboardNodeDraft(target map[string]any, oldPrompt, oldPlot, nextPrompt string) (bool, []string) {
	meta, _ := target["metadata"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		target["metadata"] = meta
	}
	currentDraft, hasComposer := meta["composerContent"].(string)
	if !hasComposer || currentDraft == "" {
		currentDraft, _ = meta["prompt"].(string)
	}
	refPrefix, bodyDraft := splitStoryboardReferencePrefix(currentDraft)
	trimmedBody := strings.TrimSpace(bodyDraft)
	oldTrimmed := strings.TrimSpace(oldPrompt)
	oldFallback := strings.TrimSpace(oldPlot)
	nextTrimmed := strings.TrimSpace(nextPrompt)
	if trimmedBody != "" && trimmedBody != oldTrimmed && trimmedBody != oldFallback && trimmedBody != nextTrimmed {
		return false, nil
	}
	changed := []string{}
	previousComposer, hadComposer := meta["composerContent"]
	if refPrefix != "" {
		meta["composerContent"] = joinStoryboardReferencePrefix(refPrefix, nextPrompt)
	} else {
		meta["composerContent"] = nextPrompt
	}
	if !hadComposer || previousComposer != meta["composerContent"] {
		changed = append(changed, "composerContent")
	}
	if !nodeHasCommittedOutput(meta) {
		previousPrompt, hadPrompt := meta["prompt"]
		meta["prompt"] = nextPrompt
		if !hadPrompt || previousPrompt != nextPrompt {
			changed = append(changed, "prompt")
		}
	}
	delete(meta, "promptTemplateOperation")
	delete(meta, "promptTemplateVariables")
	return true, changed
}

func splitStoryboardReferencePrefix(draft string) (string, string) {
	trimmed := strings.TrimSpace(draft)
	if !strings.HasPrefix(trimmed, "参考资产：") {
		return "", draft
	}
	if idx := strings.IndexByte(trimmed, '\n'); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+1:])
	}
	return trimmed, ""
}

func joinStoryboardReferencePrefix(prefix, prompt string) string {
	trimmedPrompt := strings.TrimSpace(prompt)
	if trimmedPrompt == "" {
		return prefix
	}
	return prefix + "\n" + trimmedPrompt
}

func nodeHasCommittedOutput(meta map[string]any) bool {
	for _, key := range []string{"content", "storageKey", "assetId", "resourceId", "taskId"} {
		if text, ok := meta[key].(string); ok && strings.TrimSpace(text) != "" {
			return true
		}
	}
	return false
}

func appendUniqueStoryboardID(ids []string, id string) []string {
	for _, existing := range ids {
		if existing == id {
			return ids
		}
	}
	return append(ids, id)
}

// RemoveUserCanvasStoryboardRows 按行 ID 整批删除并重排剩余行镜号（index+1），
// 与前端 removeScriptRow 的语义一致；任何一个行 ID 不存在则整批拒绝。
func (s *Service) RemoveUserCanvasStoryboardRows(userID, canvasID, nodeID string, rowIDs []string, expectedRevision int64) (UserDataSummary, int, error) {
	if err := requireStoryboardRowIDs(rowIDs); err != nil {
		return UserDataSummary{}, 0, err
	}
	doc, storyboard, rows, err := s.loadStoryboardRows(userID, canvasID, nodeID)
	if err != nil {
		return UserDataSummary{}, 0, err
	}
	remove := map[string]bool{}
	for _, id := range rowIDs {
		if remove[id] {
			return UserDataSummary{}, 0, kernel.NewAppError(http.StatusBadRequest, "同一批次内行重复: "+id)
		}
		remove[id] = true
		if findStoryboardRow(rows, id) == nil {
			return UserDataSummary{}, 0, kernel.NewAppError(http.StatusNotFound, "分镜行不存在: "+id)
		}
	}
	kept := make([]any, 0, len(rows))
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok || remove[rowIDOf(raw)] {
			continue
		}
		kept = append(kept, row)
	}
	// 删除后重排镜号，保证行序与镜号连续，界面与后续追加都依赖这一点。
	for index, raw := range kept {
		if row, ok := raw.(map[string]any); ok {
			row["shotNumber"] = float64(index + 1)
		}
	}
	removeStoryboardConnections(doc, nodeID, remove)
	summary, err := s.saveStoryboardRows(userID, canvasID, doc, storyboard, kept, expectedRevision)
	if err != nil {
		return UserDataSummary{}, 0, err
	}
	return summary, len(kept), nil
}

// loadStoryboardRows 读取画布并定位分镜脚本节点的 storyboard 行集合。
// 节点不是 script、storyboard 结构缺失时按空表处理（首次写入会补全结构）。
func (s *Service) loadStoryboardRows(userID, canvasID, nodeID string) (map[string]any, map[string]any, []any, error) {
	if strings.TrimSpace(canvasID) == "" || strings.TrimSpace(nodeID) == "" {
		return nil, nil, nil, kernel.NewAppError(http.StatusBadRequest, "canvasId 与 nodeId 必填")
	}
	doc, err := s.loadCanvasDoc(userID, canvasID)
	if err != nil {
		return nil, nil, nil, err
	}
	node := findCanvasNode(doc, nodeID)
	if node == nil {
		return nil, nil, nil, kernel.NewAppError(http.StatusNotFound, "目标节点不存在: "+nodeID)
	}
	if canvasNodeType(node) != storyboardNodeType {
		return nil, nil, nil, kernel.NewAppError(http.StatusBadRequest,
			"分镜行操作只接受 script 节点，目标节点类型是 "+canvasNodeType(node))
	}
	metadata, _ := node["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
		node["metadata"] = metadata
	}
	storyboard, _ := metadata["storyboard"].(map[string]any)
	if storyboard == nil {
		storyboard = map[string]any{
			"rows": []any{}, "referenceNodeIds": []any{},
			"visibleColumns": []any{"shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"},
		}
		metadata["storyboard"] = storyboard
	}
	rows, _ := storyboard["rows"].([]any)
	return doc, storyboard, rows, nil
}

// saveStoryboardRows 把行集合写回 storyboard 并按调用方 revision 保存。
func (s *Service) saveStoryboardRows(userID, canvasID string, doc map[string]any, storyboard map[string]any, rows []any, expectedRevision int64) (UserDataSummary, error) {
	if err := requireExpectedRevision(expectedRevision); err != nil {
		return UserDataSummary{}, err
	}
	if rows == nil {
		rows = []any{}
	}
	storyboard["rows"] = rows
	return s.saveCanvasDocWithRevision(userID, canvasID, doc, expectedRevision)
}

// buildStoryboardRow 构造一行完整默认值的分镜行，再覆盖草稿给出的字段。
// 行形状与前端 createStoryboardRow 逐字段对齐：缺字段的行会让界面表格读到 undefined。
func buildStoryboardRow(shotNumber int, draft StoryboardRowDraft) map[string]any {
	row := map[string]any{
		"id": newStoryboardRowID(), "shotNumber": float64(shotNumber),
		"durationSeconds": defaultStoryboardShotSeconds,
		"plotDescription": "", "dialogue": "", "characters": []any{},
		"narrativeIntent": "", "viewerPOV": "", "performanceBlocking": "",
		"shotSize": "", "emotion": "", "lightingAndAtmosphere": "", "audioEffects": "",
		"camera": "", "motion": "", "timeBeats": "",
		"imageGenerationPrompt": "", "videoMotionPrompt": "",
		"mustHave": []any{}, "optionalDetails": []any{},
		"continuityOut": "", "negativePrompt": "", "assetBindings": []any{}, "status": "idle",
	}
	applyStoryboardRowDraft(row, draft)
	return row
}

// applyStoryboardRowDraft 只覆盖草稿非 nil 的字段，其余逐字保留。
func applyStoryboardRowDraft(row map[string]any, draft StoryboardRowDraft) {
	previousPrompts := map[string]any{"imageGenerationPrompt": row["imageGenerationPrompt"], "videoMotionPrompt": row["videoMotionPrompt"]}
	defer invalidateStoryboardPromptTemplates(previousPrompts, row)
	if draft.DurationSeconds != nil {
		row["durationSeconds"] = *draft.DurationSeconds
	}
	for field, value := range map[string]*string{
		"plotDescription": draft.PlotDescription, "dialogue": draft.Dialogue,
		"narrativeIntent": draft.NarrativeIntent, "viewerPOV": draft.ViewerPOV,
		"performanceBlocking": draft.PerformanceBlocking, "shotSize": draft.ShotSize,
		"emotion": draft.Emotion, "lightingAndAtmosphere": draft.LightingAndAtmosphere,
		"audioEffects": draft.AudioEffects, "camera": draft.Camera, "motion": draft.Motion,
		"timeBeats": draft.TimeBeats, "imageGenerationPrompt": draft.ImageGenerationPrompt,
		"videoMotionPrompt": draft.VideoMotionPrompt, "continuityOut": draft.ContinuityOut,
		"negativePrompt": draft.NegativePrompt,
	} {
		if value != nil {

			row[field] = *value
		}
	}
	for field, value := range map[string]*[]string{
		"mustHave": draft.MustHave, "optionalDetails": draft.OptionalDetails,
	} {
		if value != nil {
			items := make([]any, 0, len(*value))
			for _, item := range *value {
				items = append(items, item)
			}
			row[field] = items
		}
	}
}

func findStoryboardRow(rows []any, rowID string) map[string]any {
	for _, raw := range rows {
		if row, ok := raw.(map[string]any); ok && rowIDOf(raw) == rowID {
			return row
		}
	}
	return nil
}

func rowIDOf(row any) string {
	if typed, ok := row.(map[string]any); ok {
		if id, ok := typed["id"].(string); ok {
			return id
		}
	}
	return ""
}

func rowShotNumber(row map[string]any) int {
	if value, ok := row["shotNumber"].(float64); ok {
		return int(value)
	}
	return 0
}

// newStoryboardRowID 生成对齐前端格式的行 ID（shot- 时间戳 - 随机串）。
func newStoryboardRowID() string { return newStoryboardID("shot-") }

// newStoryboardEdgeID 带随机串，同一批次连续绑定多行时不会撞号。
func newStoryboardEdgeID() string { return newStoryboardID("edge-") }

func newStoryboardID(prefix string) string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return prefix + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + hex.EncodeToString(buf)
}

func requireStoryboardRows(drafts []StoryboardRowDraft) error {
	if len(drafts) == 0 || len(drafts) > maxStoryboardRowsPerCall {
		return kernel.NewAppError(http.StatusBadRequest,
			"rows 必须是 1.."+strconv.Itoa(maxStoryboardRowsPerCall)+" 项的数组")
	}
	for _, draft := range drafts {
		if err := validateStoryboardDraft(draft); err != nil {
			return err
		}
	}
	return nil
}

func validateStoryboardDraft(draft StoryboardRowDraft) error {
	if draft.DurationSeconds != nil {
		seconds := *draft.DurationSeconds
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < StoryboardMinShotSeconds || seconds > StoryboardMaxShotSeconds {
			return kernel.NewAppError(http.StatusBadRequest, "镜头时长必须为 1 至 60 秒")
		}
	}
	return nil
}

func requireStoryboardPatches(patches []StoryboardRowPatch) error {
	if len(patches) == 0 || len(patches) > maxStoryboardRowsPerCall {
		return kernel.NewAppError(http.StatusBadRequest,
			"patches 必须是 1.."+strconv.Itoa(maxStoryboardRowsPerCall)+" 项的数组")
	}
	for _, patch := range patches {
		if err := validateStoryboardDraft(patch.StoryboardRowDraft); err != nil {
			return err
		}
		if strings.TrimSpace(patch.RowID) == "" {
			return kernel.NewAppError(http.StatusBadRequest, "每个 patch 都需要 rowId")
		}
		if patch.IsZero() {
			return kernel.NewAppError(http.StatusBadRequest, "patch 至少要有一个字段: "+patch.RowID)
		}
	}
	return nil
}

func requireStoryboardRowIDs(rowIDs []string) error {
	if len(rowIDs) == 0 || len(rowIDs) > maxStoryboardRowsPerCall {
		return kernel.NewAppError(http.StatusBadRequest,
			"rowIds 必须是 1.."+strconv.Itoa(maxStoryboardRowsPerCall)+" 项的数组")
	}
	for _, id := range rowIDs {
		if strings.TrimSpace(id) == "" {
			return kernel.NewAppError(http.StatusBadRequest, "rowIds 不能包含空 ID")
		}
	}
	return nil
}
