package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

const canvasWriteOpName = "canvas.external.write"

func canvasWriteOpID(opID string) string {
	return "external-write:" + strings.TrimSpace(opID)
}

type CanvasNodeRef struct {
	ID     string `json:"id"`
	Title  string `json:"title,omitempty"`
	Type   string `json:"type,omitempty"`
	Change string `json:"change,omitempty"`
}

type ExternalCanvasWrite struct {
	OpID            string          `json:"opId"`
	CanvasID        string          `json:"canvasId"`
	Op              string          `json:"op"`
	CallerKind      CallerKind      `json:"callerKind"`
	ClientID        string          `json:"clientId,omitempty"`
	ClientLabel     string          `json:"clientLabel"`
	TurnID          string          `json:"turnId,omitempty"`
	RevisionBefore  int64           `json:"revisionBefore"`
	RevisionAfter   int64           `json:"revisionAfter"`
	Summary         string          `json:"summary"`
	ChangedNodeIDs  []string        `json:"changedNodeIds"`
	CreatedNodeIDs  []string        `json:"createdNodeIds,omitempty"`
	UpdatedNodeIDs  []string        `json:"updatedNodeIds,omitempty"`
	DeletedNodeIDs  []string        `json:"deletedNodeIds,omitempty"`
	CreatedEdgeIDs  []string        `json:"createdEdgeIds,omitempty"`
	DeletedEdgeIDs  []string        `json:"deletedEdgeIds,omitempty"`
	TimelineUpdated bool            `json:"timelineUpdated,omitempty"`
	DocumentUpdated bool            `json:"documentUpdated,omitempty"`
	ModifiedNodes   []CanvasNodeRef `json:"modifiedNodes,omitempty"`
	BeforeDocument  json.RawMessage `json:"beforeDocument,omitempty"`
	AfterDocument   json.RawMessage `json:"afterDocument,omitempty"`
	Undone          bool            `json:"undone"`
	UndoneRevision  int64           `json:"undoneRevision,omitempty"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
}

type ExternalCanvasWriteUndoResult struct {
	CanvasID        string              `json:"canvasId"`
	OpID            string              `json:"opId"`
	ClientID        string              `json:"clientId,omitempty"`
	ClientLabel     string              `json:"clientLabel"`
	Revision        int64               `json:"revision"`
	RestoredNodeIDs []string            `json:"restoredNodeIds"`
	Undone          bool                `json:"undone"`
	Write           ExternalCanvasWrite `json:"write"`
}

func (w ExternalCanvasWrite) IsExternal() bool {
	if strings.TrimSpace(w.TurnID) != "" || w.CallerKind == CallerAssistant {
		return false
	}
	if w.Op == "canvas.task.bind" || w.Op == "conversation.message.attach" {
		return false
	}
	if w.CallerKind == CallerExternal {
		return true
	}
	id := strings.TrimSpace(w.ClientID)
	label := strings.TrimSpace(w.ClientLabel)
	return w.CallerKind == CallerManual && (id == "owner-token" || label == "owner-token")
}

func (w ExternalCanvasWrite) PublicView() ExternalCanvasWrite {
	out := w
	out.BeforeDocument = nil
	out.AfterDocument = nil
	if out.ChangedNodeIDs == nil {
		out.ChangedNodeIDs = []string{}
	}
	if out.ModifiedNodes == nil {
		out.ModifiedNodes = []CanvasNodeRef{}
	}
	return out
}

func BuildCanvasCreateWriteRecord(opID, canvasID, turnID string, caller Caller, afterRaw []byte) (*ExternalCanvasWrite, bool) {
	if strings.TrimSpace(opID) == "" || strings.TrimSpace(canvasID) == "" || len(afterRaw) == 0 {
		return nil, false
	}
	var afterDoc map[string]any
	if json.Unmarshal(afterRaw, &afterDoc) != nil {
		return nil, false
	}
	revAfter := canvasRevision(afterDoc)
	if revAfter <= 0 {
		revAfter = 1
	}
	title, _ := afterDoc["title"].(string)
	title = strings.TrimSpace(title)
	summary := "新建画布"
	if title != "" {
		summary = "新建画布 " + title
	}
	now := time.Now().UTC().Format(time.RFC3339)
	return &ExternalCanvasWrite{
		OpID:            strings.TrimSpace(opID),
		CanvasID:        strings.TrimSpace(canvasID),
		Op:              "canvas.create",
		CallerKind:      caller.Kind,
		ClientID:        strings.TrimSpace(caller.ClientID),
		ClientLabel:     caller.EffectiveClientLabel(),
		TurnID:          strings.TrimSpace(turnID),
		RevisionBefore:  0,
		RevisionAfter:   revAfter,
		Summary:         summary,
		ChangedNodeIDs:  []string{},
		DocumentUpdated: true,
		ModifiedNodes:   []CanvasNodeRef{},
		AfterDocument:   append(json.RawMessage(nil), afterRaw...),
		CreatedAt:       now,
		UpdatedAt:       now,
	}, true
}

func BuildCanvasWriteRecord(opID, opName, canvasID, turnID string, caller Caller, beforeRaw, afterRaw []byte) (*ExternalCanvasWrite, bool) {
	if strings.TrimSpace(opID) == "" || strings.TrimSpace(canvasID) == "" || len(beforeRaw) == 0 || len(afterRaw) == 0 {
		return nil, false
	}
	var beforeDoc, afterDoc map[string]any
	if json.Unmarshal(beforeRaw, &beforeDoc) != nil || json.Unmarshal(afterRaw, &afterDoc) != nil {
		return nil, false
	}
	revBefore := canvasRevision(beforeDoc)
	revAfter := canvasRevision(afterDoc)
	if revAfter <= revBefore {
		return nil, false
	}
	createdIDs, updatedIDs, deletedIDs, modifiedNodes := diffCanvasNodes(beforeDoc, afterDoc)
	createdEdges, deletedEdges := diffCanvasEdges(beforeDoc, afterDoc)
	timelineUpdated := !reflect.DeepEqual(beforeDoc["timeline"], afterDoc["timeline"])
	changedIDs := make([]string, 0, len(createdIDs)+len(updatedIDs)+len(deletedIDs))
	for _, list := range [][]string{createdIDs, updatedIDs, deletedIDs} {
		for _, id := range list {
			if id != "" && !slices.Contains(changedIDs, id) {
				changedIDs = append(changedIDs, id)
			}
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	write := &ExternalCanvasWrite{
		OpID:            strings.TrimSpace(opID),
		CanvasID:        strings.TrimSpace(canvasID),
		Op:              strings.TrimSpace(opName),
		CallerKind:      caller.Kind,
		ClientID:        strings.TrimSpace(caller.ClientID),
		ClientLabel:     caller.EffectiveClientLabel(),
		TurnID:          strings.TrimSpace(turnID),
		RevisionBefore:  revBefore,
		RevisionAfter:   revAfter,
		Summary:         summarizeCanvasWrite(opName, modifiedNodes, createdEdges, deletedEdges, timelineUpdated),
		ChangedNodeIDs:  changedIDs,
		CreatedNodeIDs:  createdIDs,
		UpdatedNodeIDs:  updatedIDs,
		DeletedNodeIDs:  deletedIDs,
		CreatedEdgeIDs:  createdEdges,
		DeletedEdgeIDs:  deletedEdges,
		TimelineUpdated: timelineUpdated,
		DocumentUpdated: opName == "canvas.document.commit",
		ModifiedNodes:   modifiedNodes,
		BeforeDocument:  append(json.RawMessage(nil), beforeRaw...),
		AfterDocument:   append(json.RawMessage(nil), afterRaw...),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	return write, true
}

func diffCanvasNodes(beforeDoc, afterDoc map[string]any) (created, updated, deleted []string, modified []CanvasNodeRef) {
	beforeByID := map[string]map[string]any{}
	beforeOrder := []string{}
	for _, raw := range canvasNodes(beforeDoc) {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := node["id"].(string)
		if id == "" {
			continue
		}
		beforeByID[id] = node
		beforeOrder = append(beforeOrder, id)
	}
	afterByID := map[string]map[string]any{}
	for _, raw := range canvasNodes(afterDoc) {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := node["id"].(string)
		if id == "" {
			continue
		}
		afterByID[id] = node
		prev, existed := beforeByID[id]
		if !existed {
			created = append(created, id)
			modified = append(modified, nodeRefFromMap(node, "created"))
		} else if !reflect.DeepEqual(prev, node) {
			updated = append(updated, id)
			modified = append(modified, nodeRefFromMap(node, "updated"))
		}
	}
	for _, id := range beforeOrder {
		if _, exists := afterByID[id]; !exists {
			deleted = append(deleted, id)
			modified = append(modified, nodeRefFromMap(beforeByID[id], "deleted"))
		}
	}
	return created, updated, deleted, modified
}

func diffCanvasEdges(beforeDoc, afterDoc map[string]any) (created, deleted []string) {
	beforeEdges := map[string]bool{}
	beforeList, _ := beforeDoc["connections"].([]any)
	for _, raw := range beforeList {
		if edge, ok := raw.(map[string]any); ok {
			if id, _ := edge["id"].(string); id != "" {
				beforeEdges[id] = true
			}
		}
	}
	afterEdges := map[string]bool{}
	afterList, _ := afterDoc["connections"].([]any)
	for _, raw := range afterList {
		if edge, ok := raw.(map[string]any); ok {
			if id, _ := edge["id"].(string); id != "" {
				afterEdges[id] = true
				if !beforeEdges[id] {
					created = append(created, id)
				}
			}
		}
	}
	for _, raw := range beforeList {
		if edge, ok := raw.(map[string]any); ok {
			if id, _ := edge["id"].(string); id != "" && !afterEdges[id] {
				deleted = append(deleted, id)
			}
		}
	}
	return created, deleted
}

func nodeRefFromMap(node map[string]any, change string) CanvasNodeRef {
	id, _ := node["id"].(string)
	title, _ := node["title"].(string)
	nodeType, _ := node["type"].(string)
	return CanvasNodeRef{
		ID:     id,
		Title:  strings.TrimSpace(title),
		Type:   strings.TrimSpace(nodeType),
		Change: change,
	}
}

func summarizeCanvasWrite(opName string, nodes []CanvasNodeRef, createdEdges, deletedEdges []string, timelineUpdated bool) string {
	var createdTitles, updatedTitles, deletedTitles []string
	for _, n := range nodes {
		label := n.Title
		if label == "" {
			label = n.ID
		}
		switch n.Change {
		case "created":
			createdTitles = append(createdTitles, label)
		case "updated":
			updatedTitles = append(updatedTitles, label)
		case "deleted":
			deletedTitles = append(deletedTitles, label)
		}
	}
	parts := []string{}
	if len(createdTitles) > 0 {
		parts = append(parts, "新增 "+formatTitleSample(createdTitles))
	}
	if len(updatedTitles) > 0 {
		parts = append(parts, "修改 "+formatTitleSample(updatedTitles))
	}
	if len(deletedTitles) > 0 {
		parts = append(parts, "删除 "+formatTitleSample(deletedTitles))
	}
	if len(createdEdges) > 0 || len(deletedEdges) > 0 {
		parts = append(parts, "调整连线")
	}
	if timelineUpdated {
		parts = append(parts, "更新时间线")
	}
	if len(parts) == 0 {
		return "更新画布 (" + opName + ")"
	}
	return strings.Join(parts, " · ")
}

func formatTitleSample(titles []string) string {
	if len(titles) <= 2 {
		return strings.Join(titles, "、")
	}
	return fmt.Sprintf("%s 等 %d 个节点", strings.Join(titles[:2], "、"), len(titles))
}

func UpsertCanvasWriteInTx(tx *gorm.DB, userID string, write ExternalCanvasWrite) error {
	if tx == nil || strings.TrimSpace(write.OpID) == "" || strings.TrimSpace(write.CanvasID) == "" {
		return nil
	}
	toStore := write
	status := "write:internal"
	if write.IsExternal() {
		status = "write:active"
		if write.Undone {
			status = "write:undone"
		}
	} else {
		// 非外部写入（桌面自动保存、内置助手、后台任务绑定）只保留轻量节点变更摘要供冲突诊断使用，不存整份文档快照。
		toStore.BeforeDocument = nil
		toStore.AfterDocument = nil
	}
	encoded, err := json.Marshal(toStore)
	if err != nil {
		return err
	}
	recordID := canvasWriteOpID(write.OpID)
	var existing model.AgentOpRecord
	findErr := tx.Where("user_id = ? AND op_id = ?", userID, recordID).First(&existing).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return tx.Create(&model.AgentOpRecord{
			UserID:      userID,
			OpID:        recordID,
			Op:          canvasWriteOpName,
			PayloadHash: strings.TrimSpace(write.CanvasID),
			Status:      status,
			ResultJSON:  string(encoded),
			CallerKind:  string(write.CallerKind),
			ClientID:    write.ClientID,
			ClientLabel: write.ClientLabel,
		}).Error
	}
	if findErr != nil {
		return findErr
	}
	return tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, recordID).Updates(map[string]any{
		"payload_hash": strings.TrimSpace(write.CanvasID),
		"status":       status,
		"result_json":  string(encoded),
		"caller_kind":  string(write.CallerKind),
		"client_id":    write.ClientID,
		"client_label": write.ClientLabel,
	}).Error
}

func (s *Store) ListExternalCanvasWrites(userID, canvasID string) ([]ExternalCanvasWrite, error) {
	if !s.Available() {
		return []ExternalCanvasWrite{}, nil
	}
	query := s.db.Where("user_id = ? AND op = ? AND status IN ?", userID, canvasWriteOpName, []string{"write:active", "write:undone"})
	if trimmed := strings.TrimSpace(canvasID); trimmed != "" {
		query = query.Where("payload_hash = ?", trimmed)
	}
	var records []model.AgentOpRecord
	if err := query.Order("created_at DESC").Limit(50).Find(&records).Error; err != nil {
		return nil, AsError(err)
	}
	writes := make([]ExternalCanvasWrite, 0, len(records))
	for _, rec := range records {
		var item ExternalCanvasWrite
		if json.Unmarshal([]byte(rec.ResultJSON), &item) != nil {
			continue
		}
		if !item.IsExternal() {
			continue
		}
		writes = append(writes, item.PublicView())
	}
	return writes, nil
}

func (s *Store) UndoExternalCanvasWrite(ctx context.Context, binder DomainBinder, userID, canvasID, opID string, restrictClientID ...string) (*ExternalCanvasWriteUndoResult, error) {
	if !s.Available() {
		return nil, newError(CodeInternal, "op_store_unavailable", "操作记录存储不可用", nil)
	}
	if binder == nil {
		return nil, newError(CodeInternal, "op_domain_unavailable", "操作域绑定不可用", nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	requiredClientID := ""
	if len(restrictClientID) > 0 {
		requiredClientID = strings.TrimSpace(restrictClientID[0])
	}
	var result *ExternalCanvasWriteUndoResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		write, findErr := findExternalWriteForUndoInTx(tx, userID, canvasID, opID, requiredClientID)
		if findErr != nil {
			return findErr
		}
		if write.Undone {
			return Conflict("already_undone", "这次外部改动已经撤销过了", map[string]any{
				"opId":           write.OpID,
				"undoneRevision": write.UndoneRevision,
			})
		}
		domain := binder.BindDomain(tx)
		if domain == nil {
			return newError(CodeInternal, "op_domain_unavailable", "操作域绑定不可用", nil)
		}
		currentRaw, readErr := domain.UserCanvasProject(userID, write.CanvasID)
		if readErr != nil {
			return mapDomainError(readErr)
		}
		var currentDoc map[string]any
		if err := json.Unmarshal(currentRaw, &currentDoc); err != nil {
			return AsError(err)
		}
		currentRev := canvasRevision(currentDoc)
		if write.Op == "canvas.create" {
			var createdDoc map[string]any
			createdInstanceMatch := true
			if len(write.AfterDocument) > 0 && json.Unmarshal(write.AfterDocument, &createdDoc) == nil {
				createdInstanceMatch = reflect.DeepEqual(createdDoc, currentDoc)
			}
			if currentRev != write.RevisionAfter || !createdInstanceMatch {
				return Conflict("canvas_changed_since_write", "画布在该次外部创建后又被修改，已停止删除", map[string]any{
					"currentRevision": currentRev,
					"writeRevision":   write.RevisionAfter,
				})
			}
			deleter, ok := domain.(CanvasProjectCreator)
			if !ok {
				return Unsupported("canvas_delete_unavailable", "当前工作区无法撤销新建画布")
			}
			if delErr := deleter.DeleteUserCanvasProject(userID, write.CanvasID); delErr != nil {
				return mapDomainError(delErr)
			}
			write.Undone = true
			write.UndoneRevision = 0
			write.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			if err := UpsertCanvasWriteInTx(tx, userID, *write); err != nil {
				return AsError(err)
			}
			result = &ExternalCanvasWriteUndoResult{
				CanvasID:        write.CanvasID,
				OpID:            write.OpID,
				ClientID:        write.ClientID,
				ClientLabel:     write.ClientLabel,
				Revision:        0,
				RestoredNodeIDs: []string{},
				Undone:          true,
				Write:           write.PublicView(),
			}
			return nil
		}
		restoredDoc, restoreErr := buildRestoredDocumentForExternalUndo(write, currentDoc, currentRev)
		if restoreErr != nil {
			return restoreErr
		}
		encoded, err := json.Marshal(restoredDoc)
		if err != nil {
			return AsError(err)
		}
		summary, _, commitErr := domain.CommitUserCanvasDocument(userID, write.CanvasID, currentRev, encoded)
		if commitErr != nil {
			return mapDomainError(commitErr)
		}
		write.Undone = true
		write.UndoneRevision = summary.Revision
		write.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := UpsertCanvasWriteInTx(tx, userID, *write); err != nil {
			return AsError(err)
		}
		result = &ExternalCanvasWriteUndoResult{
			CanvasID:        write.CanvasID,
			OpID:            write.OpID,
			ClientID:        write.ClientID,
			ClientLabel:     write.ClientLabel,
			Revision:        summary.Revision,
			RestoredNodeIDs: write.ChangedNodeIDs,
			Undone:          true,
			Write:           write.PublicView(),
		}
		return nil
	})
	if err != nil {
		return nil, AsError(err)
	}
	return result, nil
}

func findExternalWriteForUndoInTx(tx *gorm.DB, userID, canvasID, opID, requiredClientID string) (*ExternalCanvasWrite, error) {
	trimmedOpID := strings.TrimSpace(opID)
	trimmedCanvasID := strings.TrimSpace(canvasID)
	if trimmedOpID != "" && trimmedOpID != "latest" {
		var rec model.AgentOpRecord
		err := tx.Where("user_id = ? AND op_id = ?", userID, canvasWriteOpID(trimmedOpID)).First(&rec).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, NotFound("external_write_not_found", "未找到对应的外部写入记录")
		}
		if err != nil {
			return nil, AsError(err)
		}
		var write ExternalCanvasWrite
		if err := json.Unmarshal([]byte(rec.ResultJSON), &write); err != nil {
			return nil, AsError(err)
		}
		if !write.IsExternal() || (trimmedCanvasID != "" && write.CanvasID != trimmedCanvasID) {
			return nil, NotFound("external_write_not_found", "未找到对应的外部写入记录")
		}
		if requiredClientID != "" && strings.TrimSpace(write.ClientID) != requiredClientID {
			return nil, PermissionDenied("permission_denied", "外部客户端只能撤销自己发起的写入")
		}
		return &write, nil
	}
	if trimmedCanvasID == "" {
		return nil, InvalidArg("invalid_params", "需要指定 opId 或 canvasId")
	}
	query := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND status = ?", userID, canvasWriteOpName, trimmedCanvasID, "write:active")
	if requiredClientID != "" {
		query = query.Where("client_id = ?", requiredClientID)
	}
	var records []model.AgentOpRecord
	if err := query.Order("created_at DESC").Limit(50).Find(&records).Error; err != nil {
		return nil, AsError(err)
	}
	for _, rec := range records {
		var write ExternalCanvasWrite
		if json.Unmarshal([]byte(rec.ResultJSON), &write) != nil {
			continue
		}
		if write.IsExternal() && !write.Undone {
			return &write, nil
		}
	}
	return nil, NotFound("external_write_not_found", "当前画布没有可撤销的外部写入")
}

func buildRestoredDocumentForExternalUndo(write *ExternalCanvasWrite, currentDoc map[string]any, currentRev int64) (map[string]any, error) {
	if len(write.BeforeDocument) == 0 {
		return nil, PreconditionFailed("missing_undo_snapshot", "该次写入缺少撤销快照", nil)
	}
	var beforeDoc map[string]any
	if err := json.Unmarshal(write.BeforeDocument, &beforeDoc); err != nil {
		return nil, AsError(err)
	}
	if currentRev == write.RevisionAfter {
		beforeDoc["id"] = write.CanvasID
		beforeDoc["revision"] = currentRev
		return beforeDoc, nil
	}
	if currentRev < write.RevisionAfter || write.DocumentUpdated || write.TimelineUpdated || len(write.AfterDocument) == 0 {
		return nil, Conflict("canvas_changed_since_write", "画布在该次外部写入后又被修改，已停止覆盖", map[string]any{
			"currentRevision": currentRev,
			"writeRevision":   write.RevisionAfter,
		})
	}
	var afterDoc map[string]any
	if err := json.Unmarshal(write.AfterDocument, &afterDoc); err != nil {
		return nil, AsError(err)
	}
	if !canSurgicallyRevertWrite(write, beforeDoc, afterDoc, currentDoc) {
		return nil, Conflict("canvas_changed_since_write", "画布在该次外部写入后又修改了相关节点，已停止覆盖", map[string]any{
			"currentRevision": currentRev,
			"writeRevision":   write.RevisionAfter,
		})
	}
	return applySurgicalRevert(write, beforeDoc, currentDoc, currentRev), nil
}

func canSurgicallyRevertWrite(write *ExternalCanvasWrite, beforeDoc, afterDoc, currentDoc map[string]any) bool {
	afterNodes := indexDocItems(canvasNodes(afterDoc))
	currentNodes := indexDocItems(canvasNodes(currentDoc))
	beforeNodes := indexDocItems(canvasNodes(beforeDoc))
	for _, id := range write.CreatedNodeIDs {
		if !reflect.DeepEqual(afterNodes[id], currentNodes[id]) {
			return false
		}
	}
	for _, id := range write.UpdatedNodeIDs {
		if beforeNodes[id] == nil || !reflect.DeepEqual(afterNodes[id], currentNodes[id]) {
			return false
		}
	}
	for _, id := range write.DeletedNodeIDs {
		if beforeNodes[id] == nil || currentNodes[id] != nil {
			return false
		}
	}
	afterEdges := indexDocItems(anySlice(afterDoc["connections"]))
	currentEdges := indexDocItems(anySlice(currentDoc["connections"]))
	beforeEdges := indexDocItems(anySlice(beforeDoc["connections"]))
	for _, id := range write.CreatedEdgeIDs {
		if !reflect.DeepEqual(afterEdges[id], currentEdges[id]) {
			return false
		}
	}
	for _, id := range write.DeletedEdgeIDs {
		if beforeEdges[id] == nil || currentEdges[id] != nil {
			return false
		}
	}
	return true
}

func applySurgicalRevert(write *ExternalCanvasWrite, beforeDoc, currentDoc map[string]any, currentRev int64) map[string]any {
	beforeNodes := indexDocItems(canvasNodes(beforeDoc))
	createdSet := map[string]bool{}
	for _, id := range write.CreatedNodeIDs {
		createdSet[id] = true
	}
	updatedSet := map[string]bool{}
	for _, id := range write.UpdatedNodeIDs {
		updatedSet[id] = true
	}
	nextNodes := make([]any, 0, len(canvasNodes(currentDoc))+len(write.DeletedNodeIDs))
	for _, raw := range canvasNodes(currentDoc) {
		node, ok := raw.(map[string]any)
		if !ok {
			nextNodes = append(nextNodes, raw)
			continue
		}
		id, _ := node["id"].(string)
		if createdSet[id] {
			continue
		}
		if updatedSet[id] && beforeNodes[id] != nil {
			nextNodes = append(nextNodes, beforeNodes[id])
			continue
		}
		nextNodes = append(nextNodes, raw)
	}
	for _, id := range write.DeletedNodeIDs {
		if prev := beforeNodes[id]; prev != nil {
			nextNodes = append(nextNodes, prev)
		}
	}
	currentDoc["nodes"] = nextNodes

	createdEdges := map[string]bool{}
	for _, id := range write.CreatedEdgeIDs {
		createdEdges[id] = true
	}
	beforeEdges := indexDocItems(anySlice(beforeDoc["connections"]))
	nextEdges := make([]any, 0, len(anySlice(currentDoc["connections"]))+len(write.DeletedEdgeIDs))
	for _, raw := range anySlice(currentDoc["connections"]) {
		edge, ok := raw.(map[string]any)
		if !ok {
			nextEdges = append(nextEdges, raw)
			continue
		}
		id, _ := edge["id"].(string)
		if createdEdges[id] {
			continue
		}
		nextEdges = append(nextEdges, raw)
	}
	for _, id := range write.DeletedEdgeIDs {
		if prev := beforeEdges[id]; prev != nil {
			nextEdges = append(nextEdges, prev)
		}
	}
	currentDoc["connections"] = nextEdges
	currentDoc["id"] = write.CanvasID
	currentDoc["revision"] = currentRev
	return currentDoc
}

func indexDocItems(items []any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(items))
	for _, raw := range items {
		if item, ok := raw.(map[string]any); ok {
			if id, _ := item["id"].(string); id != "" {
				out[id] = item
			}
		}
	}
	return out
}

func anySlice(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return nil
}

func EnrichCanvasConflictErrorInTx(tx *gorm.DB, domain Domain, userID, canvasID string, expectedRevision *int64, currentRaw []byte, opErr *Error) {
	if opErr == nil || opErr.Code != CodeConflict || (opErr.Reason != "stale_revision" && opErr.Reason != "revision_conflict") {
		return
	}
	trimmedCanvasID := strings.TrimSpace(canvasID)
	if len(currentRaw) == 0 && domain != nil && trimmedCanvasID != "" {
		currentRaw, _ = domain.UserCanvasProject(userID, trimmedCanvasID)
	}
	if len(currentRaw) == 0 {
		return
	}
	var currentDoc map[string]any
	if json.Unmarshal(currentRaw, &currentDoc) != nil {
		return
	}
	currentRev := canvasRevision(currentDoc)
	if opErr.Details == nil {
		opErr.Details = map[string]any{}
	}
	opErr.Details["currentRevision"] = currentRev
	expRev := int64(0)
	if expectedRevision != nil {
		expRev = *expectedRevision
		opErr.Details["expectedRevision"] = expRev
	}
	var modifiedNodes []CanvasNodeRef
	var modifiedNodeIDs []string
	if tx != nil && trimmedCanvasID != "" {
		var records []model.AgentOpRecord
		if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ?", userID, canvasWriteOpName, trimmedCanvasID).
			Order("created_at DESC").Limit(100).Find(&records).Error; err == nil {
			slices.Reverse(records)
			var baselineRaw json.RawMessage
			seen := map[string]bool{}
			for _, rec := range records {
				var write ExternalCanvasWrite
				if json.Unmarshal([]byte(rec.ResultJSON), &write) != nil {
					continue
				}
				if write.Undone || write.RevisionAfter <= expRev || write.RevisionAfter > currentRev {
					continue
				}
				if len(baselineRaw) == 0 && len(write.BeforeDocument) > 0 && write.RevisionBefore == expRev {
					baselineRaw = write.BeforeDocument
				}
				for _, node := range write.ModifiedNodes {
					if node.ID == "" {
						continue
					}
					if !seen[node.ID] {
						seen[node.ID] = true
						modifiedNodeIDs = append(modifiedNodeIDs, node.ID)
						modifiedNodes = append(modifiedNodes, node)
					}
				}
			}
			if len(baselineRaw) > 0 {
				var baseDoc map[string]any
				if json.Unmarshal(baselineRaw, &baseDoc) == nil {
					cIDs, uIDs, dIDs, refs := diffCanvasNodes(baseDoc, currentDoc)
					if len(refs) > 0 {
						modifiedNodes = refs
						modifiedNodeIDs = make([]string, 0, len(cIDs)+len(uIDs)+len(dIDs))
						for _, list := range [][]string{cIDs, uIDs, dIDs} {
							for _, id := range list {
								if id != "" && !slices.Contains(modifiedNodeIDs, id) {
									modifiedNodeIDs = append(modifiedNodeIDs, id)
								}
							}
						}
					}
				}
			}
		}
	}
	if modifiedNodeIDs == nil {
		modifiedNodeIDs = []string{}
	}
	if modifiedNodes == nil {
		modifiedNodes = []CanvasNodeRef{}
	}
	opErr.Details["modifiedNodeIds"] = modifiedNodeIDs
	opErr.Details["modifiedNodes"] = modifiedNodes
}
