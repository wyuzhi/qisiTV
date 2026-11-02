package app

import (
	"context"
	"log"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/repository"
)

func catalogGraphFromRepo(graph *repository.LogicalModelGraph) modelcatalog.LogicalModelGraph {
	return modelcatalog.CatalogGraphFromRepo(graph)
}

func (s *Service) ensureRouter() *modelcatalog.Router {
	if s == nil {
		return nil
	}
	s.routerMu.Lock()
	defer s.routerMu.Unlock()
	if s.router == nil {
		s.router = modelcatalog.NewRouter(modelcatalog.NewRepoCatalogLoader(s.repo), time.Now, s.routeCatalogSideEffects, s.routeCatalogTTL, s.routeCatalogMaxStale)
	}
	return s.router
}

func (s *Service) routeStore() modelcatalog.RouteStore {
	return modelcatalog.NewRepoRouteStore(s.repo)
}

func (s *Service) taskInputCodec() modelcatalog.TaskInputCodec {
	return modelcatalog.TaskInputCodec{
		Decrypt:            s.decryptTaskInputJSON,
		ProtectSecrets:     s.protectTaskSecrets,
		ValidateCapability: s.ValidateTaskCapability,
	}
}

func (s *Service) routeCatalogSideEffects(context.Context) {
	if s.coordinator != nil {
		coordCtx, cancel := context.WithTimeout(context.Background(), runtimeCoordinationTimeout)
		defer cancel()
		if err := s.coordinator.BumpRouteCatalogVersion(coordCtx); err != nil {
			log.Printf("logical model route catalog distributed invalidation failed: %v", err)
		}
	}
	s.initReadCaches()
	if s.routeVersionReadCache != nil {
		s.routeVersionReadCache.Clear()
	}
}

func routeFailureInfo(err error) modelcatalog.FailureInfo { return generation.RouteFailureInfo(err) }
func routeFailureCode(err error) string                   { return generation.RouteFailureCode(err) }
func safeRouteRejection(err error) bool                   { return generation.SafeCatalogRouteRejection(err) }

func (s *Service) imageSubmissionView(attempt *model.RouteAttempt, task *model.Task) modelcatalog.ImageSubmissionView {
	return modelcatalog.ImageSubmissionViewFromRepo(s.repo, attempt, task)
}
