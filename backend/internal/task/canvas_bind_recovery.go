package task

import (
	"encoding/json"
	"strconv"
	"strings"

	"qisitv/backend/internal/model"
)

const (
	canvasBindRecoveryPrefix = model.CanvasBindRecoveryPrefix
	// #25 wrote versions 1-3 with per-field node snapshots and no revision.
	// Those markers must not decode as this format.
	canvasBindRecoveryVersion = 4
)

// CanvasBindRecovery records a terminal bind refusal without creating a second
// task lifecycle. It lives in the existing private recovery_outcome column.
// The successful task outcome remains owned by ComputeOutcome; this marker only
// controls the background delivery scanner.
type CanvasBindRecovery struct {
	Version int                        `json:"version"`
	Targets []CanvasBindRecoveryTarget `json:"targets"`
}

// CanvasBindRecoveryTarget remembers one refused target. Revision is the canvas
// revision the refusing bind read; zero means the refusal did not depend on
// the canvas (the task itself names another node or canvas).
type CanvasBindRecoveryTarget struct {
	NodeID      string `json:"nodeId"`
	OutputIndex int    `json:"outputIndex"`
	Reason      string `json:"reason"`
	Revision    int64  `json:"revision,omitempty"`
}

// DecodeCanvasBindRecovery accepts only the marker written by this package.
// Existing image recovery conclusions (no_result/unrecoverable) remain
// untouched and continue to be interpreted by ComputeOutcome.
func DecodeCanvasBindRecovery(raw *string) (CanvasBindRecovery, bool) {
	if raw == nil || !strings.HasPrefix(*raw, canvasBindRecoveryPrefix) {
		return CanvasBindRecovery{}, false
	}
	var state CanvasBindRecovery
	if json.Unmarshal([]byte(strings.TrimPrefix(*raw, canvasBindRecoveryPrefix)), &state) != nil || state.Version != canvasBindRecoveryVersion {
		return CanvasBindRecovery{}, false
	}
	return state, true
}

func EncodeCanvasBindRecovery(state CanvasBindRecovery) (*string, error) {
	state.Version = canvasBindRecoveryVersion
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	value := canvasBindRecoveryPrefix + string(encoded)
	return &value, nil
}

func (state *CanvasBindRecovery) Target(nodeID string, outputIndex int) (CanvasBindRecoveryTarget, bool) {
	if state == nil {
		return CanvasBindRecoveryTarget{}, false
	}
	for _, target := range state.Targets {
		if target.NodeID == strings.TrimSpace(nodeID) && target.OutputIndex == outputIndex {
			return target, true
		}
	}
	return CanvasBindRecoveryTarget{}, false
}

func (state *CanvasBindRecovery) Upsert(target CanvasBindRecoveryTarget) {
	if state == nil || strings.TrimSpace(target.NodeID) == "" {
		return
	}
	target.NodeID = strings.TrimSpace(target.NodeID)
	for i := range state.Targets {
		if state.Targets[i].NodeID == target.NodeID && state.Targets[i].OutputIndex == target.OutputIndex {
			state.Targets[i] = target
			return
		}
	}
	state.Targets = append(state.Targets, target)
}

func (state *CanvasBindRecovery) Remove(nodeID string, outputIndex int) bool {
	if state == nil {
		return false
	}
	nodeID = strings.TrimSpace(nodeID)
	for i, target := range state.Targets {
		if target.NodeID == nodeID && target.OutputIndex == outputIndex {
			state.Targets = append(state.Targets[:i], state.Targets[i+1:]...)
			return true
		}
	}
	return false
}

func (state CanvasBindRecovery) Empty() bool { return len(state.Targets) == 0 }

// Outcome is the value to store in recovery_outcome: nil clears the column
// once no refused target remains.
func (state CanvasBindRecovery) Outcome() (*string, error) {
	if state.Empty() {
		return nil, nil
	}
	return EncodeCanvasBindRecovery(state)
}

// IsTerminalCanvasBindReason reports refusals that retrying cannot change
// until the canvas (or the task) changes.
func IsTerminalCanvasBindReason(reason string) bool {
	switch reason {
	case "node_deleted", "node_task_mismatch", "node_mismatch", "canvas_mismatch":
		return true
	default:
		return false
	}
}

// NewCanvasBindRefusal builds the marker for one refused target from the bind
// operation's reason and details. Node refusals must carry the revision the
// refusing bind read (details.canvasBinding.revision), never a fresh read: a
// write that lands after the refusal must make the marker stale.
func NewCanvasBindRefusal(nodeID string, outputIndex int, reason string, details map[string]any) (CanvasBindRecoveryTarget, bool) {
	if !IsTerminalCanvasBindReason(reason) {
		return CanvasBindRecoveryTarget{}, false
	}
	marker := CanvasBindRecoveryTarget{NodeID: nodeID, OutputIndex: outputIndex, Reason: reason}
	if reason == "node_deleted" || reason == "node_task_mismatch" {
		binding, _ := details["canvasBinding"].(map[string]any)
		switch value := binding["revision"].(type) {
		case int64:
			marker.Revision = value
		case float64:
			marker.Revision = int64(value)
		case json.Number:
			marker.Revision, _ = value.Int64()
		}
		if marker.Revision <= 0 {
			return CanvasBindRecoveryTarget{}, false
		}
	}
	return marker, true
}

// StillRefused reports whether a refused target can be skipped this scan.
// Node refusals depend on the canvas, so they are retried after any canvas
// write: the revision only moves forward and every save increments it. This
// does not try to predict which edits make the bind succeed. node_mismatch and
// canvas_mismatch are decided from the task alone.
func (target CanvasBindRecoveryTarget) StillRefused(currentRevision func() (int64, error)) bool {
	if target.Reason != "node_deleted" && target.Reason != "node_task_mismatch" {
		return true
	}
	if target.Revision <= 0 {
		// Without the refusal's revision the marker cannot prove anything.
		return false
	}
	revision, err := currentRevision()
	return err == nil && revision == target.Revision
}

// CanvasBindPass is one background scan over a task's canvas bind targets: it
// says which targets to skip, records terminal refusals, drops markers for
// targets that bound or are no longer listed, and clears markers left by older
// formats. Call Finish only after every current target went through Skip.
type CanvasBindPass struct {
	state CanvasBindRecovery
	seen  map[string]bool
	dirty bool
}

func NewCanvasBindPass(raw *string) *CanvasBindPass {
	state, ok := DecodeCanvasBindRecovery(raw)
	// Formats 1-3 do not decode and never block a bind; clear them on this pass.
	stale := !ok && raw != nil && strings.HasPrefix(*raw, canvasBindRecoveryPrefix)
	return &CanvasBindPass{state: state, seen: map[string]bool{}, dirty: stale}
}

func canvasBindKey(nodeID string, outputIndex int) string {
	return strings.TrimSpace(nodeID) + "\x00" + strconv.Itoa(outputIndex)
}

// Skip reports whether the target's recorded refusal still holds.
func (p *CanvasBindPass) Skip(nodeID string, outputIndex int, currentRevision func() (int64, error)) bool {
	p.seen[canvasBindKey(nodeID, outputIndex)] = true
	marker, ok := p.state.Target(nodeID, outputIndex)
	return ok && marker.StillRefused(currentRevision)
}

// Refused records a terminal refusal and reports whether the reason was one.
func (p *CanvasBindPass) Refused(nodeID string, outputIndex int, reason string, details map[string]any) bool {
	if !IsTerminalCanvasBindReason(reason) {
		return false
	}
	if marker, ok := NewCanvasBindRefusal(nodeID, outputIndex, reason, details); ok {
		p.state.Upsert(marker)
		p.dirty = true
	}
	return true
}

// Bound drops the marker of a target that bound.
func (p *CanvasBindPass) Bound(nodeID string, outputIndex int) {
	if p.state.Remove(nodeID, outputIndex) {
		p.dirty = true
	}
}

// Finish drops markers for targets this pass did not see and returns the value
// to store when anything changed (nil clears the marker).
func (p *CanvasBindPass) Finish() (*string, bool, error) {
	kept := make([]CanvasBindRecoveryTarget, 0, len(p.state.Targets))
	for _, target := range p.state.Targets {
		if p.seen[canvasBindKey(target.NodeID, target.OutputIndex)] {
			kept = append(kept, target)
		} else {
			p.dirty = true
		}
	}
	p.state.Targets = kept
	if !p.dirty {
		return nil, false, nil
	}
	outcome, err := p.state.Outcome()
	return outcome, true, err
}

type CanvasBindTarget struct {
	NodeID      string
	OutputIndex int
}

type MessageBindTarget struct {
	ConversationID string
	MessageID      string
	OutputIndex    int
}

func CanvasBindTargets(task model.Task, intents []CanvasBindingIntent) []CanvasBindTarget {
	seen := map[string]bool{}
	targets := make([]CanvasBindTarget, 0, len(intents)+1)
	add := func(nodeID string, outputIndex int) {
		nodeID = strings.TrimSpace(nodeID)
		if nodeID == "" {
			return
		}
		key := nodeID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, CanvasBindTarget{NodeID: nodeID, OutputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(CanvasBindNodeID(task, intent.OutputIndex, intent.TargetBinding.NodeID), intent.OutputIndex)
	}
	switch strings.TrimSpace(task.Type) {
	case "canvas_text", "text_replay":
		add(TargetBindingFromInput(task.InputJSON).NodeID, 0)
	}
	return targets
}

func MessageBindTargets(task model.Task, intents []CanvasBindingIntent) []MessageBindTarget {
	seen := map[string]bool{}
	targets := make([]MessageBindTarget, 0, len(intents)+1)
	add := func(conversationID, messageID string, outputIndex int) {
		conversationID = strings.TrimSpace(conversationID)
		messageID = strings.TrimSpace(messageID)
		if conversationID == "" || messageID == "" {
			return
		}
		key := conversationID + ":" + messageID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, MessageBindTarget{ConversationID: conversationID, MessageID: messageID, OutputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(intent.TargetBinding.ConversationID, intent.TargetBinding.MessageID, intent.OutputIndex)
	}
	target := TargetBindingFromInput(task.InputJSON)
	add(target.ConversationID, target.MessageID, 0)
	return targets
}

func HasCanvasBindMarker(raw *string) bool {
	return raw != nil && strings.HasPrefix(*raw, canvasBindRecoveryPrefix)
}

// TaskCanvasIDs returns the canvas IDs that must exist before background
// recovery prepares Seedream output nodes, binds canvas nodes, or registers
// canvas-scoped workflow outputs. Non-canvas tasks (such as short-drama
// project tasks or conversation-only tasks) return nil.
func TaskCanvasIDs(task model.Task, intents []CanvasBindingIntent, isOwnedProject func(string) (bool, error)) ([]string, error) {
	var input struct {
		WorkflowStepID   string   `json:"workflowStepId"`
		DomainProjectID  string   `json:"domainProjectId"`
		CanvasID         string   `json:"canvasId"`
		NodeID           string   `json:"nodeId"`
		OutputNodeIDs    []string `json:"outputNodeIds"`
		Source           string   `json:"source"`
		Operation        string   `json:"operation"`
		CharacterAssetID string   `json:"characterAssetId"`
		ChapterID        string   `json:"chapterId"`
		Metadata         struct {
			WorkflowStepID   string   `json:"workflowStepId"`
			DomainProjectID  string   `json:"domainProjectId"`
			CanvasID         string   `json:"canvasId"`
			NodeID           string   `json:"nodeId"`
			OutputNodeIDs    []string `json:"outputNodeIds"`
			Source           string   `json:"source"`
			Operation        string   `json:"operation"`
			CharacterAssetID string   `json:"characterAssetId"`
			ChapterID        string   `json:"chapterId"`
		} `json:"metadata"`
	}
	if raw := strings.TrimSpace(task.InputJSON); raw != "" {
		_ = json.Unmarshal([]byte(raw), &input)
	}
	first := func(a, b string) string {
		if v := strings.TrimSpace(a); v != "" {
			return v
		}
		return strings.TrimSpace(b)
	}
	workflowStepID := first(input.WorkflowStepID, input.Metadata.WorkflowStepID)
	domainProjectID := first(input.DomainProjectID, input.Metadata.DomainProjectID)
	canvasID := first(input.CanvasID, input.Metadata.CanvasID)
	nodeID := first(input.NodeID, input.Metadata.NodeID)
	source := first(input.Source, input.Metadata.Source)
	operation := first(input.Operation, input.Metadata.Operation)
	characterAssetID := first(input.CharacterAssetID, input.Metadata.CharacterAssetID)
	chapterID := first(input.ChapterID, input.Metadata.ChapterID)

	hasCanvasWork := nodeID != "" || len(input.OutputNodeIDs) > 0 || len(input.Metadata.OutputNodeIDs) > 0 ||
		len(CanvasBindTargets(task, intents)) > 0 || SeedreamOutputRoot(task) != "" || len(FrozenOutputNodeIDs(task)) > 0 ||
		workflowStepID != "" || canvasID != "" || HasCanvasBindMarker(task.RecoveryOutcome) ||
		source == "canvas" || source == "canvas-workflow"
	if !hasCanvasWork {
		return nil, nil
	}

	projectID := strings.TrimSpace(task.ProjectID)
	projectIsBusiness := (domainProjectID != "" && projectID != "" && projectID == domainProjectID) ||
		operation == "character_turnaround" || characterAssetID != "" || chapterID != "" ||
		source == "short-drama-chapter-storyboard" || strings.HasPrefix(nodeID, "character-turnaround:")
	if !projectIsBusiness && projectID != "" && isOwnedProject != nil {
		owned, err := isOwnedProject(projectID)
		if err != nil {
			return nil, err
		}
		projectIsBusiness = owned
	}
	if projectIsBusiness {
		return nil, nil
	}

	var ids []string
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		for _, existing := range ids {
			if existing == id {
				return
			}
		}
		ids = append(ids, id)
	}
	add(projectID)
	add(canvasID)
	return ids, nil
}

// TaskCanvasState returns the canvas IDs required by the task and whether any
// required canvas is currently absent.
func TaskCanvasState(task model.Task, intents []CanvasBindingIntent, isOwnedProject func(string) (bool, error), canvasExists func(string) (bool, error)) ([]string, bool, error) {
	ids, err := TaskCanvasIDs(task, intents, isOwnedProject)
	if err != nil || len(ids) == 0 || canvasExists == nil {
		return ids, false, err
	}
	for _, id := range ids {
		exists, err := canvasExists(id)
		if err != nil {
			return ids, false, err
		}
		if !exists {
			return ids, true, nil
		}
	}
	return ids, false, nil
}

// TaskCanvasMissing reports whether any canvas required by the task is absent.
func TaskCanvasMissing(task model.Task, intents []CanvasBindingIntent, isOwnedProject func(string) (bool, error), canvasExists func(string) (bool, error)) (bool, error) {
	_, missing, err := TaskCanvasState(task, intents, isOwnedProject, canvasExists)
	return missing, err
}
