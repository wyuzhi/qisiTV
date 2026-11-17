package operations

import (
	"encoding/json"
)

// canvas.generation.regenerate 与 submit 共用参数、校验、审批与计费路径；
// 唯一区别是目标节点上已经结束的旧任务可以释放，让新任务在原地接替它。
// 旧结果仍留在素材库，操作重放也不会重复建任务或扣费。
func registerGenerationRegenerate(r *Registry) {
	r.Register(Op{ExternalOnly: true, ReplaySafe: true, SubmitsGeneration: true, ID: "canvas.generation.regenerate", Summary: "在原地重做已结束的画布生成并计费", Scope: ScopeCanvas,
		Params: json.RawMessage(generationSubmitParams), Handler: opGenerationRegenerate})
}

func opGenerationRegenerate(ctx *Context, raw json.RawMessage) (any, error) {
	return admitGeneration(ctx, raw, generationRegenerate)
}
