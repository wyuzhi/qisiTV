package operations

import (
	"encoding/json"
	"strings"
)

// operationStore 返回执行操作所需的操作记录存储；缺失时明确失败，不能当成空列表。
func operationStore(ctx *Context) (*Store, error) {
	if ctx == nil || ctx.Store == nil || !ctx.Store.Available() {
		return nil, newError(CodeInternal, "op_store_unavailable", "操作记录存储不可用", nil)
	}
	return ctx.Store, nil
}

func registerExternalWriteOps(r *Registry) {
	r.Register(Op{ExternalOnly: true, ID: "canvas.external.write.list", Summary: "列出外部客户端对画布做过的改动（最近 50 条，含已撤销）；只读，不修改画布", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string","description":"可选，只看某个画布"}}}`),
		Handler: opExternalWriteList})
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, ID: "canvas.external.write.undo", Summary: "撤销一次外部写入。外部客户端只能撤销自己发起的改动；画布在那次改动后又被修改时拒绝撤销并说明原因", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string","description":"改动所在的画布；省略时按写入记录查找"},"writeOpId":{"type":"string","description":"要撤销的外部写入 ID；填 latest 表示该画布最近一次可撤销的外部写入"}},"required":["writeOpId"]}`),
		Handler: opExternalWriteUndo})
}

func opExternalWriteList(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	store, err := operationStore(ctx)
	if err != nil {
		return nil, err
	}
	writes, listErr := store.ListExternalCanvasWrites(ctx.UserID, args.CanvasID)
	if listErr != nil {
		return nil, AsError(listErr)
	}
	return map[string]any{"writes": writes, "returned": len(writes), "limit": 50}, nil
}

func opExternalWriteUndo(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID  string `json:"canvasId"`
		WriteOpID string `json:"writeOpId"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	writeOpID := strings.TrimSpace(args.WriteOpID)
	if writeOpID == "" {
		return nil, InvalidArg("invalid_params", "writeOpId 必填；可用 canvas.external.write.list 查询")
	}
	store, err := operationStore(ctx)
	if err != nil {
		return nil, err
	}
	if ctx.Binder == nil {
		return nil, newError(CodeInternal, "op_domain_unavailable", "操作域绑定不可用", nil)
	}
	// 只有外部客户端受「只能撤销自己的改动」约束；owner/桌面入口沿用原有权限。
	restrictClientID := ""
	if ctx.Caller.Kind == CallerExternal {
		restrictClientID = strings.TrimSpace(ctx.Caller.ClientID)
		if restrictClientID == "" {
			return nil, PermissionDenied("permission_denied", "外部客户端缺少客户端标识，不能撤销画布写入")
		}
	}
	result, undoErr := store.UndoExternalCanvasWrite(ctx.Context, ctx.Binder, ctx.UserID, args.CanvasID, writeOpID, restrictClientID)
	if undoErr != nil {
		return nil, AsError(undoErr)
	}
	return result, nil
}
