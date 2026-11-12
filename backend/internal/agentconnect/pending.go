package agentconnect

import (
	"qisitv/backend/internal/agentops"
)

// Registry is the narrow credential surface needed at startup.
type Registry interface {
	ListLive() ([]agentops.ClientRegistration, error)
	Revoke(clientID string) error
}

// RevokeConfirmed reports whether a revoke attempt leaves no usable
// credential. A credential that was already gone counts as confirmed.
func RevokeConfirmed(err error) bool {
	if err == nil {
		return true
	}
	return agentops.AsError(err).Reason == "client_not_found"
}

// RetryStaleOneClickCredentials is called once at desktop startup. It revokes
// one-click credentials that are not the current record's client. If the
// auxiliary record cannot be read, it revokes nothing and lets the UI show
// "needs retry" so the user decides.
func RetryStaleOneClickCredentials(clients Registry, dataDir string) error {
	if clients == nil {
		return nil
	}
	manager := NewDefault(dataDir)
	if !manager.Available() {
		return nil
	}
	stateMu.Lock()
	state, err := manager.readState()
	stateMu.Unlock()
	if err != nil {
		return nil
	}
	// An unreadable registry revokes nothing; the UI shows "needs retry".
	items, err := clients.ListLive()
	if err != nil {
		return nil
	}
	for _, kind := range []agentops.ClientKind{agentops.ClientKindClaude, agentops.ClientKindCodex} {
		current := state.Integrations[string(kind)].ClientID
		for _, item := range items {
			if item.Kind != kind || !IsIntegrationOrigin(kind, item.Origin) || item.ID == current {
				continue
			}
			if err := clients.Revoke(item.ID); err != nil && !RevokeConfirmed(err) {
				return err
			}
		}
	}
	return nil
}
