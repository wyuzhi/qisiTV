package operations

import (
	"encoding/json"

	"qisitv/backend/internal/agentguide"
)

// registerAgentGuideOp 暴露所有外部 Agent 共用的画布使用说明。
// 内置助手不经过这份说明；ExternalOnly 让它不出现在任何助手模式下。
func registerAgentGuideOp(r *Registry) {
	r.Register(Op{ExternalOnly: true, ID: "agent.guide", Summary: "读取 qisiTV 外部 Agent 使用说明（与一键接入安装的技能同一份）", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct{}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			return agentguide.Current(), nil
		}})
}
