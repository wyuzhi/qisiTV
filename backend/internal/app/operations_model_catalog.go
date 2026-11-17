package app

import "infinite-canvas/backend/internal/modelcatalog"

// Desktop execution uses its provider snapshot, not hosted database channels.
// The public sanitizer excludes execution addresses, headers and credentials.
func (s *operationSession) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	if !s.service.IsLocalMode() {
		return s.service.ModelCatalog(nil)
	}
	body, err := s.service.ReadLocalModelConfig()
	if err != nil {
		return nil, err
	}
	return modelcatalog.PublicCatalogFromLocalSnapshot(body, s.service.PluginDomain().LookupWorkflow)
}
