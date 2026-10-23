package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"qisitv/backend/internal/agentops"
)

func TestQisiAgentConfigurationRootsAndScopedCredentials(t *testing.T) {
	for _, item := range []struct {
		kind agentops.ClientKind
		root string
	}{
		{agentops.ClientKindWorkBuddy, "mcpServers"}, {agentops.ClientKindVSCode, "servers"},
		{agentops.ClientKindOpenClaw, "mcpServers"}, {agentops.ClientKindHermes, "mcpServers"}, {agentops.ClientKindCodeBuddy, "mcpServers"},
	} {
		if agentops.NormalizeClientKind(string(item.kind)) != item.kind {
			t.Fatal("unsupported kind", item.kind)
		}
		setup := clientSetup(item.kind, "/installed/cli/qisitv", "/private/workspace", agentops.ClientRegistration{ID: "client-fixture", Mode: agentops.ClientReadOnly}, "scoped-token")
		var config map[string]map[string]struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		}
		if err := json.Unmarshal([]byte(setup["json"].(string)), &config); err != nil {
			t.Fatal(err)
		}
		entry, ok := config[item.root]["qisitv"]
		if !ok || entry.Command != "/installed/cli/qisitv" || entry.Env["BEEFTV_CLIENT_ID"] != "client-fixture" || entry.Env["BEEFTV_CLIENT_TOKEN"] != "scoped-token" || len(entry.Env) != 3 || !strings.Contains(strings.Join(entry.Args, " "), "--read-only") {
			t.Fatal("wrong client credential/config", item.kind)
		}
	}
}
