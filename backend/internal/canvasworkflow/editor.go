package canvasworkflow

import (
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/modelcatalog"
)

// EditorDefinition fills public editor fields from a private recipe.
func EditorDefinition(d Definition, recipes RecipesByNode) Definition {
	d = Normalize(d)
	for i, n := range d.Nodes {
		if !strings.HasPrefix(n.OperationID, "generate.") {
			continue
		}
		recipe := recipes[n.ID]
		n.Config = map[string]any{}
		for _, key := range []string{"prompt", "size", "quality", "vquality", "videoSeconds", "seed"} {
			value, ok := recipe.Request.Input[key]
			if key != "prompt" {
				config, _ := recipe.Request.Input["config"].(map[string]any)
				value, ok = config[key]
				if (key == "seed" || key == "videoSeconds") && ok {
					if text, yes := value.(string); yes {
						number, err := strconv.ParseFloat(text, 64)
						if err != nil {
							ok = false
						} else {
							value = number
						}
					}
				}
			}
			if key == "prompt" && !ok {
				value = recipe.Request.Prompt
				ok = true
			}
			if ok {
				switch value.(type) {
				case string, float64, int, bool:
					n.Config[key] = value
				}
			}
		}
		config, _ := recipe.Request.Input["config"].(map[string]any)
		channel := recipe.ChannelID
		if IsOfficialWorkflowChannel(channel) {
			channel = "beeftv"
		}
		if channel != "" && stringValue(config["model"]) != "" {
			n.Config["modelOption"] = channel + "::" + stringValue(config["model"])
		}
		d.Nodes[i] = n
	}
	for i, edge := range d.Edges {
		bindings := []Binding{}
		for _, binding := range recipes[edge.To].Bindings {
			if binding.NodeID == edge.From && !PromptBinding(binding.Field) {
				bindings = append(bindings, binding)
			}
		}
		if len(bindings) == 1 {
			edge.ToPort, edge.Order = bindings[0].Field, bindings[0].Index
			d.Edges[i] = edge
		}
	}
	// Reference identity belongs to the private recipe. Reusable inputs and
	// processing outputs have no original media attached to their public slots.
	for i := range d.Nodes {
		n := &d.Nodes[i]
		if d.PresentationVersion > 0 && (n.Role == "operation" || n.Role == "input" && n.MediaType != "text" && !n.UseDefault) {
			n.ResourceID = ""
		}
	}
	return d
}

// PresentOperations lists operations with the host's current model choices
// and marks media operations when the local encoder cannot run.
func PresentOperations(host CompileHost) []Operation {
	operations := Operations()
	if snapshot, err := host.ProviderConfig(); err == nil {
		upscaleChannels := []FieldOption{}
		if host.UpscaleAvailable("") == nil {
			upscaleChannels = append(upscaleChannels, FieldOption{Label: "官方算力", Value: "beeftv"})
		}
		textModels := []FieldOption{}
		for _, model := range DescribeModels(snapshot) {
			if model.Enabled && model.Capability == "text" && model.Protocol != "" {
				textModels = append(textModels, FieldOption{Label: model.DisplayName, Value: model.ChannelID + "::" + model.Model})
			}
		}
		for i := range operations {
			for j := range operations[i].Fields {
				field := &operations[i].Fields[j]
				if strings.HasPrefix(operations[i].ID, "generate.") && field.Key == "modelOption" {
					raw, _ := json.Marshal(snapshot)
					for _, candidate := range modelcatalog.ParseLocalChannelModels(raw) {
						if candidate.Enabled && generation.UpscaleMediaType(candidate.Model) == "" && candidate.Capability == operations[i].OutputType && candidate.Protocol != "" {
							field.Options = append(field.Options, FieldOption{Label: candidate.DisplayName + " · " + candidate.ChannelID, Value: candidate.ChannelID + "::" + candidate.Model, Capabilities: candidate.CapabilityConfig})
						}
					}
				}
				if strings.HasSuffix(operations[i].ID, ".ai-upscale") && field.Key == "channelId" {
					field.Options = upscaleChannels
				}
				if operations[i].ID == "image.describe" && field.Key == "modelOption" {
					field.Options = textModels
				}
			}
		}
	}
	path, err := mediatools.ResolveFFmpeg()
	if err == nil {
		var info os.FileInfo
		info, err = os.Stat(path)
		if err == nil && (!info.Mode().IsRegular() || runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0) {
			err = os.ErrPermission
		}
	}
	if err != nil {
		for i := range operations {
			if IsMediaOperation(operations[i].ID) || operations[i].ID == "video.trim" || operations[i].ID == "video.merge" {
				operations[i].UnavailableReason = "本机媒体编码器不可用，请更新安装版后重试"
			}
		}
	}
	return operations
}
