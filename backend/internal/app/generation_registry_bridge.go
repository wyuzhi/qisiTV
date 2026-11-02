package app

import (
	"context"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/protocol"
)

var emptyProtocolRegistry, _ = protocol.NewRegistry()

func withProtocolRegistry(ctx context.Context, registry *protocol.Registry) context.Context {
	return generation.WithProtocolRegistry(ctx, registry)
}
func protocolRegistryFromContext(ctx context.Context) (*protocol.Registry, bool) {
	return generation.ProtocolRegistryFromContext(ctx)
}
func protocolAdapterForContext(ctx context.Context, id string) (protocol.Adapter, bool) {
	return generation.ProtocolAdapterForContext(ctx, id)
}
func ensureOfficialProtocolAdapter(ctx context.Context, interfaceType string) context.Context {
	return generation.EnsureOfficialProtocolAdapter(ctx, interfaceType)
}
func officialDeclarativeVideoInterface(interfaceType string) (string, bool) {
	return generation.OfficialDeclarativeVideoInterface(interfaceType)
}
func officialDeclarativeImageInterface(interfaceType string) (string, bool) {
	return generation.OfficialDeclarativeImageInterface(interfaceType)
}
func officialDeclarativeAudioInterface(interfaceType string) (string, bool) {
	return generation.OfficialDeclarativeAudioInterface(interfaceType)
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
