package app

import (
	"qisitv/backend/internal/model"
	localproject "qisitv/backend/internal/project"
)

type ProjectUnitWorkspace struct {
	Unit            model.ProjectUnit             `json:"unit"`
	Workflows       []ProjectWorkflowDetail       `json:"workflows"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []ProjectShotAssetReference   `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
	Assets          []ProjectAssetSummary         `json:"assets"`
	Tasks           []TaskSummary                 `json:"tasks"`
}

type ProjectShotAssetReference = localproject.ShotAssetReference
type ProjectShotAssetReferenceVersion = localproject.ShotAssetReferenceVersion
type ProjectAssetCandidatePage = localproject.AssetCandidatePage
type ProjectAssetPage = localproject.AssetPage

func (s *Service) ProjectUnitWorkspace(userID string, projectID string, unitID string) (ProjectUnitWorkspace, error) {
	workspace, err := s.projectDomain().ProjectUnitWorkspace(userID, projectID, unitID)
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	recent, err := s.TasksWithOptions(userID, TaskListOptions{Limit: 100, ProjectID: projectID})
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	active, err := s.TasksWithOptions(userID, TaskListOptions{Limit: 100, ProjectID: projectID, ActiveOnly: true})
	if err != nil {
		return ProjectUnitWorkspace{}, err
	}
	seen := make(map[string]struct{}, len(recent)+len(active))
	projectTasks := make([]TaskSummary, 0, len(recent)+len(active))
	for _, task := range append(active, recent...) {
		if _, exists := seen[task.ID]; exists {
			continue
		}
		seen[task.ID] = struct{}{}
		projectTasks = append(projectTasks, task)
	}
	shotIDs := make(map[string]struct{}, len(workspace.Shots))
	for _, shot := range workspace.Shots {
		shotIDs[shot.ID] = struct{}{}
	}
	tasks := make([]TaskSummary, 0, len(projectTasks))
	for _, task := range projectTasks {
		context := task.ClientContext
		if context == nil {
			continue
		}
		_, belongsToShot := shotIDs[context.ShotID]
		if context.ChapterID == unitID || belongsToShot {
			tasks = append(tasks, task)
		}
	}
	return ProjectUnitWorkspace{
		Unit: workspace.Unit, Workflows: workspace.Workflows, Shots: workspace.Shots,
		ShotRevisions: workspace.ShotRevisions, ShotArtifacts: workspace.ShotArtifacts,
		ShotReferences: workspace.ShotReferences, AssetCandidates: workspace.AssetCandidates,
		Assets: workspace.Assets, Tasks: tasks,
	}, nil
}
