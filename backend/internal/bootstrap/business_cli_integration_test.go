package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"qisitv/backend/internal/agentops"
	"qisitv/backend/internal/editing"
)

func TestExternalCLIAndMCPRealBusinessUpload(t *testing.T) {
	h := newDesktopHarness(t)
	_, canvas, rev := seedOpsAcceptanceCanvas(t, h)
	reg, token, err := agentops.NewClientRegistry(h.dataDir).Register("external-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h.rt.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	dir := t.TempDir()
	bin := filepath.Join(dir, "beeftv")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "./cmd/beeftv")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	env := append(os.Environ(), "BEEFTV_BASE_URL="+server.URL+"/api", "BEEFTV_CLIENT_ID="+reg.ID, "BEEFTV_CLIENT_TOKEN="+token, "BEEFTV_OWNER_TOKEN=", "BEEFTV_DESKTOP_TOKEN=")
	run := func(args ...string) []byte {
		command := exec.CommandContext(ctx, bin, args...)
		command.Env = env
		out, err := command.CombinedOutput()
		if err != nil {
			t.Fatal(args, err, string(out))
		}
		return out
	}
	discovery := run("business", "discover")
	if !bytes.Contains(discovery, []byte("business_post_tasks")) || !bytes.Contains(discovery, []byte("business_post_plugins")) {
		t.Fatal("missing business capability discovery")
	}
	move := run("ops", "call", "canvas.node.move", "--operation-id", "cli-generic-move", "--params", acceptanceJSON(t, map[string]any{"canvasId": canvas, "nodeId": "n1", "expectedRevision": rev, "position": map[string]any{"x": 20, "y": 40}}))
	if !bytes.Contains(move, []byte("revision")) {
		t.Fatal("generic op did not execute")
	}
	var imageBytes bytes.Buffer
	_ = png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 32, 32)))
	pngPath := filepath.Join(dir, "reference.png")
	if err = os.WriteFile(pngPath, imageBytes.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	ffmpeg, err := editing.ResolveFFmpegBinary()
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"image": pngPath, "audio": filepath.Join(dir, "reference.wav"), "video": filepath.Join(dir, "reference.mp4")}
	fixtures := [][]string{{"-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", files["audio"]}, {"-f", "lavfi", "-i", "testsrc2=size=64x64:rate=8:duration=1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", files["video"]}}
	for _, args := range fixtures {
		out, err := exec.CommandContext(ctx, ffmpeg, append([]string{"-nostdin", "-v", "error", "-y"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatal(err, string(out))
		}
	}
	for _, kind := range []string{"image", "audio", "video"} {
		out := run("business", "upload", "--file", files[kind], "--params", acceptanceJSON(t, map[string]any{"body": map[string]any{"kind": kind}}))
		var response map[string]any
		if json.Unmarshal(out, &response) != nil || response["resource"] == nil {
			t.Fatal("real upload failed", kind, string(out))
		}
		resource := response["resource"].(map[string]any)
		if resource["mimeType"] == "" {
			t.Fatal("not actual media")
		}
	}
	connect := func(args ...string) *mcp.ClientSession {
		command := exec.Command(bin, append([]string{"mcp", "serve"}, args...)...)
		command.Env = env
		session, err := mcp.NewClient(&mcp.Implementation{Name: "business-fixture", Version: "1"}, nil).Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		return session
	}
	toolText := func(result *mcp.CallToolResult) string {
		var parts []string
		for _, content := range result.Content {
			if text, ok := content.(*mcp.TextContent); ok {
				parts = append(parts, text.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	sensitive := func(name string) bool {
		return strings.Contains(name, "agent_clients") || strings.Contains(name, "assistant_host")
	}

	// Default: workspace operations plus the business gateway, not one tool per route.
	session := connect()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
		if sensitive(tool.Name) {
			t.Fatal("sensitive MCP tool exposed", tool.Name)
		}
	}
	if !names["business.list"] || !names["business.call"] || names["business_post_resources"] || len(tools.Tools) >= 100 {
		t.Fatalf("default MCP must expose the business gateway instead of every route: %d tools", len(tools.Tools))
	}
	catalog, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.list", Arguments: map[string]any{}})
	if err != nil || catalog.IsError || !strings.Contains(toolText(catalog), "business_post_resources") {
		t.Fatalf("business.list must find the resource upload: %v %s", err, toolText(catalog))
	}
	if sensitive(toolText(catalog)) {
		t.Fatal("sensitive handler listed by business.list")
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "business.call", Arguments: map[string]any{"tool": "business_post_resources", "filePath": pngPath, "body": map[string]any{"kind": "image"}, "operationId": "mcp-gateway-upload-1"}})
	if err != nil || result.IsError || !strings.Contains(toolText(result), "resource") {
		t.Fatalf("official MCP real upload through business.call err=%v result=%s", err, toolText(result))
	}

	// Opt-in: every business route as its own tool, as before.
	all := connect("--all-business-tools")
	listed, err := all.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) < 100 {
		t.Fatal("--all-business-tools only exposed", len(listed.Tools))
	}
	found := false
	for _, tool := range listed.Tools {
		found = found || tool.Name == "business_post_resources"
		if sensitive(tool.Name) {
			t.Fatal("sensitive MCP tool exposed", tool.Name)
		}
		if tool.Name == "business.list" || tool.Name == "business.call" {
			t.Fatal("--all-business-tools must not also register the gateway", tool.Name)
		}
	}
	if !found {
		t.Fatal("MCP missing resource upload")
	}
	direct, err := all.CallTool(ctx, &mcp.CallToolParams{Name: "business_post_resources", Arguments: map[string]any{"filePath": pngPath, "body": map[string]any{"kind": "image"}, "operationId": "mcp-route-upload-1"}})
	if err != nil || direct.IsError || len(direct.Content) == 0 {
		t.Fatalf("official MCP real upload err=%v result=%s", err, toolText(direct))
	}
}
