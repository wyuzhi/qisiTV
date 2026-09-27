package app

import (
	"encoding/json"
	"strings"

	"qisitv/backend/internal/model"
)

// Only user-editable image options cross the approval boundary. Targets,
// references, prompt, snapshot and generation mode remain server-authored.
type CloudAgentMediaSettings struct {
	LogicalModelID  string `json:"logicalModelId,omitempty"`
	ChannelID       string `json:"channelId,omitempty"`
	ChannelModelKey string `json:"channelModelKey,omitempty"`
	Size            string `json:"size"`
	Quality         string `json:"quality"`
}

func (s *Service) updateCloudAgentMediaApproval(run *model.CloudAgentExecution, state *cloudAgentRuntime, settings CloudAgentMediaSettings) error {
	call := state.Approval.Call
	if call.Function.Name != "generate_media" {
		return BadAuthRequest("当前审批不是图片生成，不能修改生成参数")
	}
	var args cloudAgentMediaArgs
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return err
	}
	if args.Mode != "image" {
		return BadAuthRequest("仅图片生成审批支持修改模型、画幅和质量")
	}
	args.LogicalModelID, args.ChannelID, args.ChannelModelKey = settings.LogicalModelID, settings.ChannelID, settings.ChannelModelKey
	args.Size, args.Quality = settings.Size, settings.Quality
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	call.Function.Arguments = string(raw)
	req, plan, err := s.prepareCloudAgentMedia(run, state, call)
	if err != nil {
		return err
	}
	// Dry admission uses the same model, ownership and option checks as task
	// submission, without reserving credits or creating a generation task.
	req.creationPrepare = &creationTaskPreparation{}
	task, err := s.CreateTask(run.UserID, req)
	if err != nil {
		return err
	}
	var resolved struct {
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &resolved); err != nil {
		return err
	}
	if err := validateCloudAgentResolvedMediaOptions(req.Input["config"].(map[string]any), resolved.Config); err != nil {
		return err
	}
	name, err := s.cloudAgentMediaModelName(args)
	if err != nil {
		return err
	}
	state.Calls[state.CallIndex] = call
	state.Approval.Call = call
	state.Approval.CallHash = cloudAgentApprovalCallHash(call)
	state.Approval.ModelName = name
	state.Approval.Preview = cloudAgentMediaApprovalPreview(plan, name)
	return nil
}

func validateCloudAgentResolvedMediaOptions(requested, resolved map[string]any) error {
	for _, key := range []string{"size", "videoSeconds", "vquality", "quality", "count", "videoGenerateAudio"} {
		if value := stringValue(requested[key]); value != "" && !strings.EqualFold(value, stringValue(resolved[key])) {
			return creationConflict("模型解析后的生成规格与审批参数不同，请重新读取目录并审批")
		}
	}
	return nil
}
