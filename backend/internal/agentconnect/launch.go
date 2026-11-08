package agentconnect

import (
	"strings"

	"infinite-canvas/backend/internal/agentops"
)

// ServerName is the MCP server entry this product owns in an agent's config.
const ServerName = "beeftv"

// SkillName is the directory name used in every agent's user-level skills dir.
const SkillName = "beeftv-canvas"

// EnvVar keeps the generated command and config in a stable order.
type EnvVar struct {
	Key   string
	Value string
}

// LaunchSpec is the single source for how external agents start the bundled
// CLI. The pasteable setup snippet and the direct writer both use it.
type LaunchSpec struct {
	Command string
	Args    []string
	Env     []EnvVar
}

// EnvMap returns the environment as a map for JSON configs.
func (s LaunchSpec) EnvMap() map[string]string {
	env := make(map[string]string, len(s.Env))
	for _, item := range s.Env {
		env[item.Key] = item.Value
	}
	return env
}

// Launch builds the MCP launch for a desktop one-click credential. The token
// itself stays in a 0600 file under BeefTV's data directory; only its path is
// passed to the agent so it never appears in process arguments.
func Launch(cliPath, dataDir, tokenFile string, mode agentops.ClientMode, clientID string) LaunchSpec {
	return launchSpec(cliPath, dataDir, mode, clientID, "BEEFTV_CLIENT_TOKEN_FILE", tokenFile)
}

// ManualLaunch keeps the pasteable manual setup unchanged: the token is part
// of the command the user copies into their own terminal.
func ManualLaunch(cliPath, dataDir string, mode agentops.ClientMode, clientID, token string) LaunchSpec {
	return launchSpec(cliPath, dataDir, mode, clientID, "BEEFTV_CLIENT_TOKEN", token)
}

func launchSpec(cliPath, dataDir string, mode agentops.ClientMode, clientID, tokenKey, tokenValue string) LaunchSpec {
	args := []string{"mcp", "serve"}
	if mode == agentops.ClientReadOnly {
		args = append(args, "--read-only")
	}
	return LaunchSpec{
		Command: cliPath,
		Args:    args,
		Env: []EnvVar{
			{Key: "BEEFTV_DATA_DIR", Value: dataDir},
			{Key: "BEEFTV_CLIENT_ID", Value: clientID},
			{Key: tokenKey, Value: tokenValue},
		},
	}
}

// IntegrationOrigin is the persisted credential origin for a desktop
// one-click connection. Identity never depends on the display label, so a
// manual connection that happens to be called "Claude Code" stays manual.
func IntegrationOrigin(kind agentops.ClientKind) string {
	switch kind {
	case agentops.ClientKindClaude:
		return "one-click:claude"
	case agentops.ClientKindCodex:
		return "one-click:codex"
	default:
		return ""
	}
}

// IsIntegrationOrigin reports whether a registration came from one-click.
// Empty origin (including legacy files) is always a manual connection.
func IsIntegrationOrigin(kind agentops.ClientKind, origin string) bool {
	expected := IntegrationOrigin(kind)
	return expected != "" && strings.TrimSpace(origin) == expected
}
