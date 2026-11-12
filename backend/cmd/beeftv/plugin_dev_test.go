package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func capturePluginCommand(t *testing.T, args ...string) (map[string]any, error) {
	t.Helper()
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	runErr := runPlugin(args)
	writer.Close()
	os.Stdout = original
	var buffer bytes.Buffer
	if _, err := io.Copy(&buffer, reader); err != nil {
		t.Fatal(err)
	}
	if runErr != nil {
		return nil, runErr
	}
	var out map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &out); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, buffer.String())
	}
	return out, nil
}

func TestPluginTryBuildsTheRequestWithoutSendingIt(t *testing.T) {
	out, err := capturePluginCommand(t, "try", filepath.Join("..", "..", "..", "plugin-packages", "openai-chat-completions"),
		"--base-url", "https://openrouter.ai/api/v1", "--model", "m-1", "--prompt", "你好", "--options", `{"temperature":0.3}`)
	if err != nil {
		t.Fatal(err)
	}
	if out["method"] != "POST" || out["url"] != "https://openrouter.ai/api/v1/chat/completions" {
		t.Fatalf("request = %#v", out)
	}
	body, _ := out["body"].(map[string]any)
	messages, _ := body["messages"].([]any)
	if body["model"] != "m-1" || body["temperature"] != 0.3 || len(messages) != 1 {
		t.Fatalf("body = %#v", body)
	}
}

func TestPluginValidateReportsTheBrokenField(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"apiVersion":"beeftv.plugin/v2","id":"demo","name":"Demo","version":"0.1.0","contributes":{"providers":[{"id":"demo-chat","label":"Demo","capabilities":["text"],"scopes":["user.custom-channel"],"presets":[{"id":"x","label":"X","baseUrl":"ftp://bad"}],"create":{"method":"POST","path":"/v1/chat/completions"},"response":{"textPaths":["choices.0.message.content"]}}]}}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := capturePluginCommand(t, "validate", dir)
	if err == nil || !strings.Contains(err.Error(), "presets[0].baseUrl") {
		t.Fatalf("expected the failing field to be named, got %v", err)
	}
}

func TestPluginValidateAcceptsEveryShippedInterface(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "plugin-packages", "*.qisitv-plugin"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no packaged interfaces: %v", err)
	}
	for _, path := range paths {
		if _, err := capturePluginCommand(t, "validate", path); err != nil {
			t.Fatalf("%s: %v", filepath.Base(path), err)
		}
	}
}
