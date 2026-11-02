package app

import (
	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/model"
)

type resourceUsage = localasset.ResourceUsage

func (s *Service) deleteUserAssetWithResources(u, aid string, status ...string) error             { return s.resourceDomain().DeleteUserAssetWithResources(u, aid, status...) }
func resourceDeletionJobs(u string, objs map[string]*model.Resource) []model.ResourceDeletionJob  { return localasset.DeletionJobs(u, objs) }
func resourceOccupiedMessage(usages []resourceUsage) string                                       { return localasset.OccupiedMessage(usages) }
func collectOwnedAssetDocumentReferences(raw string, ids map[string]struct{}) error               { return assets.CollectOwnedDocumentReferences(raw, ids) }
func documentReferencesResources(raw string, ids map[string]struct{}) bool                        { return assets.DocumentReferences(raw, ids) }
func (s *Service) deleteLocalResourceObject(objectKey string) error                               { return s.resourceDomain().DeleteLocalObject(objectKey) }
