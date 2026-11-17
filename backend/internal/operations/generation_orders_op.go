package operations

import (
	"encoding/json"
	"strings"
)

func registerGenerationOrderListOp(r *Registry) {
	r.Register(Op{ExternalOnly: true, ID: "canvas.generation.orders", Summary: "列出生成单，可按画布和状态过滤并分页；只读，不创建任务也不扣费", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string","description":"可选，只看某个画布"},"status":{"type":"string","enum":["pending","approved","submitted"],"description":"可选，生成单状态"},"page":{"type":"integer","description":"页码，从 1 开始，默认 1"},"pageSize":{"type":"integer","description":"每页数量，默认 20，最多 100"}}}`),
		Handler: opGenerationOrderList})
}

func opGenerationOrderList(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
		Status   string `json:"status"`
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	status := strings.TrimSpace(args.Status)
	switch status {
	case "", string(GenerationOrderPending), string(GenerationOrderApproved), string(GenerationOrderSubmitted):
	default:
		return nil, InvalidArg("invalid_status", "status 只能是 pending、approved 或 submitted")
	}
	store, err := operationStore(ctx)
	if err != nil {
		return nil, err
	}
	page, queryErr := store.ListGenerationOrdersPage(ctx.UserID, GenerationOrderQuery{
		CanvasID: args.CanvasID,
		Status:   status,
		Page:     args.Page,
		PageSize: args.PageSize,
	})
	if queryErr != nil {
		return nil, AsError(queryErr)
	}
	return page, nil
}
