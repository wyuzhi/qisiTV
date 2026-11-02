package task

import (
	"encoding/json"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/providerpreset"
	"strconv"
	"strings"
)

// A variable Seedream response is one paid task. Extra destinations derive from
// that task identity, rather than all overwriting its single requested node.
func SeedreamOutputRoot(task model.Task) string {
	if task.Type != "canvas_image" {
		return ""
	}
	name := task.Model
	if i := strings.LastIndex(name, "::"); i >= 0 {
		name = name[i+2:]
	}
	if providerpreset.SeedreamFamily(name) == "" {
		return ""
	}
	var input struct {
		Metadata struct {
			NodeID        string   `json:"nodeId"`
			OutputNodeIDs []string `json:"outputNodeIds"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || len(input.Metadata.OutputNodeIDs) > 1 {
		return ""
	}
	if len(input.Metadata.OutputNodeIDs) == 1 {
		return strings.TrimSpace(input.Metadata.OutputNodeIDs[0])
	}
	return strings.TrimSpace(input.Metadata.NodeID)
}

func SeedreamOutputNodeID(task model.Task, index int) string {
	root := SeedreamOutputRoot(task)
	if root == "" || index < 0 || index > 16 {
		return ""
	}
	if index == 0 {
		return root
	}
	return "image-output-" + task.ID + "-" + strconv.Itoa(index)
}

func OutputBinding(task model.Task, index int) TargetBinding {
	binding := TargetBindingFromInput(task.InputJSON)
	if SeedreamOutputRoot(task) != "" {
		binding.NodeID = SeedreamOutputNodeID(task, index)
	}
	return binding
}

// FrozenOutputNodeIDs returns the destination each output of a multi-output
// image task was frozen to before submission, or nil. Seedream tasks with one
// root derive their outputs from SeedreamOutputRoot instead.
func FrozenOutputNodeIDs(task model.Task) []string {
	if task.Type != "canvas_image" || SeedreamOutputRoot(task) != "" {
		return nil
	}
	var input struct {
		Metadata struct {
			OutputNodeIDs []string `json:"outputNodeIds"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
		return nil
	}
	return input.Metadata.OutputNodeIDs
}

// CanvasBindNodeID is the node one output must bind to: its frozen destination
// when the task froze one per output, otherwise fallback. The bind operation
// and the background scanner both use it, so the scanner never asks to bind
// an output to a node the operation will refuse.
func CanvasBindNodeID(task model.Task, outputIndex int, fallback string) string {
	if ids := FrozenOutputNodeIDs(task); len(ids) > 0 {
		if outputIndex < 0 || outputIndex >= len(ids) {
			return ""
		}
		return strings.TrimSpace(ids[outputIndex])
	}
	return strings.TrimSpace(fallback)
}
