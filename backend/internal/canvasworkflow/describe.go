package canvasworkflow

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/modelcatalog"
)

const describePrompt = "请根据参考图片反推一段适合用于 AI 生图的提示词。只输出提示词正文，不要解释。覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。"

// Text task execution is separate from canvas media-generation capabilities.
// An absent vision declaration is left to the configured model, as on the main canvas.
func DescribeModels(snapshot map[string]any) []modelcatalog.LocalChannelModel {
	raw, _ := json.Marshal(snapshot)
	out := []modelcatalog.LocalChannelModel{}
	for _, candidate := range modelcatalog.ParseLocalChannelModels(raw) {
		if !candidate.Enabled || candidate.Capability != "text" || candidate.Protocol == "" {
			continue
		}
		if candidate.CapabilityConfig != nil {
			b, _ := json.Marshal(candidate.CapabilityConfig)
			profile, err := modelcatalog.DecodeModelCapabilityConfig(string(b))
			if err != nil || profile == nil || profile.Text == nil || profile.Text.References.MaxImages < 1 {
				continue
			}
		}
		out = append(out, candidate)
	}
	preferred := stringValue(snapshot["textModel"])
	for i, item := range out {
		if item.ChannelID+"::"+item.Model == preferred {
			out[0], out[i] = out[i], out[0]
			break
		}
	}
	return out
}

func DescribeRequest(host CompileHost, n Node, resource, operation string) (RecipeRequest, error) {
	option, _ := n.Config["modelOption"].(string)
	snapshot, err := host.ProviderConfig()
	if err != nil {
		return RecipeRequest{}, err
	}
	for _, candidate := range DescribeModels(snapshot) {
		if !candidate.Enabled || candidate.Capability != "text" || candidate.ChannelID+"::"+candidate.Model != option || candidate.Protocol == "" {
			continue
		}
		config := map[string]any{"model": candidate.Model, "interfaceType": candidate.Protocol, "baseUrl": candidate.BaseURL, "capabilityConfig": candidate.CapabilityConfig}
		input := map[string]any{"mode": "text", "config": config}
		channelID := candidate.ChannelID
		if beeftv.IsManagedChannel(candidate.ChannelID, "", candidate.BaseURL) {
			channelID = "@beeftv"
		}
		if err := RefreshCredentials(host, input, channelID); err != nil {
			return RecipeRequest{}, err
		}
		prompt, _ := n.Config["prompt"].(string)
		if strings.TrimSpace(prompt) == "" {
			prompt = describePrompt
		}
		input["prompt"] = prompt
		if resource != "" {
			input["referenceImages"] = []any{map[string]any{"storageKey": "resource:" + resource}}
		}
		input["metadata"] = map[string]any{"clientOperationId": operation, "nodeId": n.ID, "source": "canvas-workflow"}
		return RecipeRequest{Type: "canvas_text", Prompt: prompt, Model: candidate.Model, Input: input}, nil
	}
	return RecipeRequest{}, BadRequest("请选择已启用、支持识图的文本模型")
}
