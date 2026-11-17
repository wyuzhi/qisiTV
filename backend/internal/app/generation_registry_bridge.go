package app

import (
	"context"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/protocol"
)

var emptyProtocolRegistry, _ = protocol.NewRegistry()

func withProtocolRegistry(ctx context.Context, registry *protocol.Registry) context.Context {
	return generation.WithProtocolRegistry(ctx, registry)
}
func ensureOfficialProtocolAdapter(ctx context.Context, interfaceType string) context.Context {
	return generation.EnsureOfficialProtocolAdapter(ctx, interfaceType)
}
func declarativeProtocolAdapterForContext(ctx context.Context, id string) (protocol.Adapter, bool) {
	return generation.DeclarativeProtocolAdapterForContext(ctx, id)
}
func agentProtocolAdapterForContext(ctx context.Context, id string) (protocol.AgentAdapter, bool) {
	return generation.AgentProtocolAdapterForContext(ctx, id)
}
func loadOfficialFallbackRegistry() *protocol.Registry {
	return generation.LoadOfficialFallbackRegistry()
}
