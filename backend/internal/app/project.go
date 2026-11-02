package app

import (
	"qisitv/backend/internal/model"
	localproject "qisitv/backend/internal/project"
)

type CreateProjectRequest = localproject.CreateProjectRequest
type UpdateProjectRequest = localproject.UpdateProjectRequest
type CreateProjectUnitRequest = localproject.CreateProjectUnitRequest
type UpdateProjectUnitRequest = localproject.UpdateProjectUnitRequest
type ImportProjectUnitsRequest = localproject.ImportProjectUnitsRequest
type ReorderProjectUnitsRequest = localproject.ReorderProjectUnitsRequest
type LinkCanvasUnitRequest = localproject.LinkCanvasUnitRequest
type CreateProjectFolderRequest = localproject.CreateProjectFolderRequest
type ProjectSummary = localproject.Summary
type ProjectListPage = localproject.ListPage
type ProjectCore = localproject.Core
type ProjectUnitSummaries = localproject.UnitSummaries
type ProjectOverview = localproject.Overview
type ProjectOverviewMetrics = localproject.OverviewMetrics
type ProjectOverviewUnit = localproject.OverviewUnit
type ProjectCanvasPage = localproject.CanvasPage
type ProjectAssetSummary = localproject.AssetSummary
type ProjectWorkflowDetail = localproject.WorkflowDetail

type ProjectDetail struct {
	Project         model.Project                 `json:"project"`
	Units           []model.ProjectUnit           `json:"units"`
	Canvases        []model.CanvasProject         `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink        `json:"canvasUnitLinks"`
	Assets          []ProjectAssetSummary         `json:"assets"`
	AssetFolders    []model.ProjectAssetFolder    `json:"assetFolders"`
	Workflows       []ProjectWorkflowDetail       `json:"workflows"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []model.ShotAssetReference    `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
	Tasks           []TaskSummary                 `json:"tasks"`
}

func (s *Service) ListProjects(userID string) ([]ProjectSummary, error) {
	return s.projectDomain().ListProjects(userID)
}

func (s *Service) ProjectDetail(userID string, id string) (ProjectDetail, error) {
	if _, err := s.projectDomain().Owned(userID, id); err != nil {
		return ProjectDetail{}, err
	}
	core, err := s.projectDomain().Inspect(userID, id)
	if err != nil {
		return ProjectDetail{}, err
	}
	assets, err := s.projectDomain().ProjectAssets(userID, core.Project.ID)
	if err != nil {
		return ProjectDetail{}, err
	}
	workflows, err := s.projectDomain().ProjectWorkflows(userID, core.Project.ID)
	if err != nil {
		return ProjectDetail{}, err
	}
	tasks, err := s.TasksWithOptions(userID, TaskListOptions{Limit: 100, ProjectID: core.Project.ID})
	if err != nil {
		return ProjectDetail{}, err
	}
	return ProjectDetail{
		Project: core.Project, Units: core.Units, Canvases: core.Canvases, CanvasUnitLinks: core.CanvasUnitLinks,
		Assets: assets, AssetFolders: core.AssetFolders, Workflows: workflows, Shots: core.Shots,
		ShotRevisions: core.ShotRevisions, ShotArtifacts: core.ShotArtifacts, ShotReferences: core.ShotReferences,
		AssetCandidates: core.AssetCandidates, Tasks: tasks,
	}, nil
}

func (s *Service) activeProjectForUser(userID string, projectID string) (*model.Project, error) {
	return s.projectDomain().Active(userID, projectID)
}

func IsProjectNotFound(err error) bool {
	return localproject.IsNotFound(err)
}

func (s *Service) ensureTaskProjectActive(userID string, canvasOrProjectID string) error {
	return s.projectDomain().EnsureTaskScopeActive(userID, canvasOrProjectID)
}

func normalizeProjectPage(page int, pageSize int, maximum int) (int, int) {
	return localproject.NormalizePage(page, pageSize, maximum)
}
