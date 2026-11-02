package bootstrap

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"qisitv/backend/internal/agentops"
	"qisitv/backend/internal/model"
)

// Official MCP transport and real task admission; the worker is never started,
// and the only configured provider is a reserved .invalid hostname.
func TestExternalMCPGenerationApprovalAndReceipt(t *testing.T) {
	h := newDesktopHarness(t)
	owner, canvasID, _ := seedOpsAcceptanceCanvas(t, h)
	if err := h.rt.service.SaveLocalModelConfig([]byte(`{"imageModel":"custom::qwen-image-2.1","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"fixture","models":["qwen-image-2.1"],"modelProfiles":[{"model":"qwen-image-2.1","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := h.rt.service.UserCanvasProject(owner, canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"].([]any)[0].(map[string]any)["metadata"] = map[string]any{"prompt": "A wooden tray", "size": "1:1"}
	if _, err := h.rt.service.UpsertUserCanvasProject(owner, []byte(acceptanceJSON(t, doc))); err != nil {
		t.Fatal(err)
	}
	reg, token, err := agentops.NewClientRegistry(h.dataDir).Register("generation-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h.rt.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	bin := filepath.Join(t.TempDir(), "beeftv")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "./cmd/beeftv")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	command := exec.CommandContext(ctx, bin, "mcp", "serve")
	command.Env = append(os.Environ(), "BEEFTV_BASE_URL="+server.URL+"/api", "BEEFTV_CLIENT_ID="+reg.ID, "BEEFTV_CLIENT_TOKEN="+token, "BEEFTV_OWNER_TOKEN=", "BEEFTV_DESKTOP_TOKEN=")
	client := mcp.NewClient(&mcp.Implementation{Name: "generation-fixture", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s: %v %+v", name, err, result)
		}
		for _, c := range result.Content {
			if text, ok := c.(*mcp.TextContent); ok {
				var result map[string]any
				if err := json.Unmarshal([]byte(text.Text), &result); err != nil {
					t.Fatal(err)
				}
				return result
			}
		}
		t.Fatal("missing MCP receipt")
		return nil
	}
	proposal := call("canvas.generation.propose", map[string]any{"canvasId": canvasID, "nodeIds": []string{"n1"}, "kind": "image"})
	next := proposal["result"].(map[string]any)["nextAction"].(map[string]any)
	if next["approval"] != "external-client" || next["operation"] != "canvas.generation.submit" {
		t.Fatal(next)
	}
	var count int64
	h.rt.service.Database().Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("proposal purchased generation")
	}
	args := next["params"].(map[string]any)
	args["operationId"] = "mcp-generation-confirmed-once"
	first := call("canvas.generation.submit", args)
	second := call("canvas.generation.submit", args)
	if first["replayed"] != false || second["replayed"] != true || acceptanceJSON(t, first["result"]) != acceptanceJSON(t, second["result"]) {
		t.Fatal("MCP did not recover original receipt", first, second)
	}
	var tasks []model.Task
	if err := h.rt.service.Database().Find(&tasks).Error; err != nil || len(tasks) != 1 || tasks[0].Status != model.TaskStatusQueued {
		t.Fatal("wrong admission", len(tasks), err)
	}
	// No assistant UI round or automatic continuation is introduced.
	h.rt.service.Database().Model(&model.AssistantTurn{}).Count(&count)
	if count != 0 {
		t.Fatal("external MCP created assistant approval")
	}
}
