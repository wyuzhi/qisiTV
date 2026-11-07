package agentops_test

import (
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/skills"
	"testing"
)

func TestSkillReadRequiresExactExplicitPin(t *testing.T) {
	pin := skills.Pin{SkillID: "skill-one", VersionID: "version-one", ContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	scope := &agentops.AssistantScope{CanvasID: "canvas", SkillPins: map[skills.Pin]bool{pin: true}}
	for _, op := range []string{"skill.get", "skill.file"} {
		raw, _ := json.Marshal(pin)
		if err := scope.Allows(registeredScopeOp(t, op), raw); err != nil {
			t.Fatal(err)
		}
		for _, other := range []skills.Pin{{SkillID: pin.SkillID, VersionID: "new-version", ContentHash: pin.ContentHash}, {SkillID: "unselected", VersionID: pin.VersionID, ContentHash: pin.ContentHash}, {SkillID: pin.SkillID, VersionID: pin.VersionID, ContentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}} {
			raw, _ := json.Marshal(other)
			if err := scope.Allows(registeredScopeOp(t, op), raw); err == nil {
				t.Fatalf("unselected version accepted: %+v", other)
			}
		}
		empty := &agentops.AssistantScope{CanvasID: "canvas"}
		if err := empty.Allows(registeredScopeOp(t, op), raw); err == nil {
			t.Fatal("installed list implicitly authorized read")
		}
	}
}

func TestSkillReadAllowsConversationAndInstalledPinsOnly(t *testing.T) {
	earlier := skills.Pin{SkillID: "skill-earlier", VersionID: "version-one", ContentHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
	installed := skills.Pin{SkillID: "skill-installed", VersionID: "version-two", ContentHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
	scope := &agentops.AssistantScope{CanvasID: "canvas", PermissionMode: "canvas", SkillPins: map[skills.Pin]bool{earlier: true},
		SkillInstalled: func(pin skills.Pin) bool { return pin == installed }}
	for _, op := range []string{"skill.get", "skill.file"} {
		for _, pin := range []skills.Pin{earlier, installed} {
			raw, _ := json.Marshal(pin)
			if err := scope.Allows(registeredScopeOp(t, op), raw); err != nil {
				t.Fatalf("%s %+v: %v", op, pin, err)
			}
		}
		stale := installed
		stale.VersionID = "version-old"
		raw, _ := json.Marshal(stale)
		if err := scope.Allows(registeredScopeOp(t, op), raw); err == nil {
			t.Fatal("non-current installed version accepted")
		}
	}
	if err := scope.Allows(registeredScopeOp(t, "skill.catalog"), json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
}

func TestSkillScriptRunRequiresPinnedSkillAndNonReadOnlyMode(t *testing.T) {
	pinned := skills.Pin{SkillID: "skill-pinned", VersionID: "v1", ContentHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}
	installedOnly := skills.Pin{SkillID: "skill-installed", VersionID: "v2", ContentHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}
	scope := &agentops.AssistantScope{
		CanvasID:       "canvas",
		PermissionMode: "canvas",
		SkillPins:      map[skills.Pin]bool{pinned: true},
		SkillInstalled: func(pin skills.Pin) bool { return pin == installedOnly },
	}
	op := registeredScopeOp(t, "skill.script.run")
	okPayload, _ := json.Marshal(map[string]any{
		"canvasId":    "canvas",
		"skillId":     pinned.SkillID,
		"versionId":   pinned.VersionID,
		"contentHash": pinned.ContentHash,
		"scriptPath":  "scripts/run.js",
	})
	if err := scope.Allows(op, okPayload); err != nil {
		t.Fatalf("expected pinned skill script to be allowed, got %v", err)
	}
	unpinnedPayload, _ := json.Marshal(map[string]any{
		"canvasId":    "canvas",
		"skillId":     installedOnly.SkillID,
		"versionId":   installedOnly.VersionID,
		"contentHash": installedOnly.ContentHash,
		"scriptPath":  "scripts/run.js",
	})
	if err := scope.Allows(op, unpinnedPayload); err == nil {
		t.Fatal("expected unpinned catalog-only skill script to be rejected")
	}
	wrongCanvasPayload, _ := json.Marshal(map[string]any{
		"canvasId":    "other-canvas",
		"skillId":     pinned.SkillID,
		"versionId":   pinned.VersionID,
		"contentHash": pinned.ContentHash,
		"scriptPath":  "scripts/run.js",
	})
	if err := scope.Allows(op, wrongCanvasPayload); err == nil {
		t.Fatal("expected wrong canvasId to be rejected in canvas mode")
	}
	readOnlyScope := &agentops.AssistantScope{
		CanvasID:       "canvas",
		PermissionMode: "read-only",
		SkillPins:      map[skills.Pin]bool{pinned: true},
	}
	if err := readOnlyScope.Allows(op, okPayload); err == nil {
		t.Fatal("expected read-only mode to reject skill.script.run")
	}
}
