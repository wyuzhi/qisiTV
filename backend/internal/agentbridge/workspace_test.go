package agentbridge_test

import (
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"qisitv/backend/internal/agentbridge"
	"qisitv/backend/internal/bootstrap"
)

// This verifies the Agent contract against the actual local HTTP routes,
// SQLite, resource guard and canvas revision service, not a mock handler.
func TestAgentRoundTripThroughRealWorkspace(t *testing.T) {
	ctx := context.Background()
	runtime, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Start(); err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(ctx)
	client, err := agentbridge.New(runtime.BaseURL(), runtime.LaunchToken())
	if err != nil {
		t.Fatal(err)
	}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		result, err := client.Call(ctx, name, args)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return result
	}
	call("canvas_create", map[string]any{"canvasId": "agent-integration", "title": "Agent round trip"})
	call("canvas_add_node", map[string]any{"canvasId": "agent-integration", "node": map[string]any{"id": "script", "type": "text", "title": "Script", "metadata": map[string]any{"content": "A quiet scene"}}})
	call("canvas_add_node", map[string]any{"canvasId": "agent-integration", "node": map[string]any{"id": "video", "type": "video", "title": "Video output"}})
	filePath := filepath.Join(t.TempDir(), "reference.png")
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(file, image.NewRGBA(image.Rect(0, 0, 96, 48))); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	imported := call("asset_import", map[string]any{"canvasId": "agent-integration", "path": filePath, "kind": "image", "nodeId": "reference"})
	if imported["assetId"] == "" || imported["resourceId"] == "" {
		t.Fatal("missing media bindings")
	}
	call("canvas_connect_nodes", map[string]any{"canvasId": "agent-integration", "connection": map[string]any{"id": "ref-video", "fromNodeId": "reference", "toNodeId": "video"}})
	data := call("canvas_get", map[string]any{"canvasId": "agent-integration"})
	project := data["project"].(map[string]any)
	revision := project["revision"].(float64)
	if len(project["nodes"].([]any)) != 3 || len(project["connections"].([]any)) != 1 {
		t.Fatalf("lost canvas data: %#v", project)
	}
	call("canvas_update_node", map[string]any{"canvasId": "agent-integration", "nodeId": "script", "baseRevision": revision, "patch": map[string]any{"position": map[string]any{"x": 42, "y": 18}}})
	if _, err = client.Call(ctx, "canvas_delete_node", map[string]any{"canvasId": "agent-integration", "nodeId": "script", "baseRevision": revision}); err == nil {
		t.Fatal("stale write succeeded")
	}
	data = call("canvas_get", map[string]any{"canvasId": "agent-integration"})
	nodes := data["project"].(map[string]any)["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatal("stale write removed a node")
	}
	call("canvas_disconnect", map[string]any{"canvasId": "agent-integration", "connectionId": "ref-video"})
	call("canvas_delete_node", map[string]any{"canvasId": "agent-integration", "nodeId": "reference"})
	call("canvas_interaction", map[string]any{"canvasId": "agent-integration"})
	call("canvas_current", nil)
}
