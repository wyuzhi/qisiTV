package task

import (
	"errors"
	"sync"

	"gorm.io/gorm"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

// CanvasFailureScan writes failed canvas generation tasks back onto their nodes,
// the failure counterpart of RecoverPendingCanvasBindings. It runs on every
// delivery recovery pass: a failure's outcome can still change after the task
// stops (provider recovery, settlement), and a node can point at the task only
// later (a delayed client save, a canvas history restore), so no single
// terminal hook sees the final answer.
type CanvasFailureScan struct {
	mu      sync.Mutex
	afterID string
	// checked holds the outcome and canvas revision each task was last checked
	// at. The canvas document is read again only when either one changes.
	checked map[string]canvasFailureCheck
}

type canvasFailureCheck struct {
	outcome  Outcome
	revision int64
}

type CanvasFailureDeps struct {
	Repo    *repository.Repository
	Outcome func(model.Task) (Outcome, error)
	// Record writes the failures of one canvas onto the nodes still referencing
	// them and returns the canvas revision those nodes were checked at.
	Record func(userID, canvasID string, tasks []model.Task, outcomes []Outcome) (int64, error)
}

// Run handles one page. Every outcome goes to Record, which marks nodes failed
// only for a failed outcome and otherwise just keeps an already failed node in
// step with its task.
func (scan *CanvasFailureScan) Run(deps CanvasFailureDeps, limit int) error {
	if deps.Repo == nil {
		return nil
	}
	if limit <= 0 {
		limit = CanvasBindRecoveryBatch
	}
	scan.mu.Lock()
	defer scan.mu.Unlock()
	tasks, err := deps.Repo.FailedCanvasGenerationTasks(scan.afterID, limit)
	if err != nil {
		if BindInfrastructureUnavailable(err) {
			return nil
		}
		return err
	}
	scan.afterID = ""
	if len(tasks) == limit {
		scan.afterID = tasks[len(tasks)-1].ID
	}
	if scan.checked == nil {
		scan.checked = map[string]canvasFailureCheck{}
	}
	type canvasFailures struct {
		userID, canvasID string
		tasks            []model.Task
		outcomes         []Outcome
	}
	var groups []*canvasFailures
	byCanvas := map[[2]string]*canvasFailures{}
	var last error
	for _, task := range tasks {
		outcome, err := deps.Outcome(task)
		if err != nil {
			last = err
			continue
		}
		key := [2]string{task.UserID, task.ProjectID}
		group := byCanvas[key]
		if group == nil {
			group = &canvasFailures{userID: task.UserID, canvasID: task.ProjectID}
			byCanvas[key] = group
			groups = append(groups, group)
		}
		group.tasks = append(group.tasks, task)
		group.outcomes = append(group.outcomes, outcome)
	}
	for _, group := range groups {
		project, err := deps.Repo.CanvasProjectMetadata(group.userID, group.canvasID)
		if errors.Is(err, gorm.ErrRecordNotFound) || BindInfrastructureUnavailable(err) {
			continue
		}
		if err != nil {
			last = err
			continue
		}
		if scan.unchanged(group.tasks, group.outcomes, project.Revision) {
			continue
		}
		revision, err := deps.Record(group.userID, group.canvasID, group.tasks, group.outcomes)
		if err != nil {
			last = err
			continue
		}
		for i, task := range group.tasks {
			scan.checked[task.ID] = canvasFailureCheck{outcome: group.outcomes[i], revision: revision}
		}
	}
	return last
}

func (scan *CanvasFailureScan) unchanged(tasks []model.Task, outcomes []Outcome, revision int64) bool {
	for i, task := range tasks {
		if scan.checked[task.ID] != (canvasFailureCheck{outcome: outcomes[i], revision: revision}) {
			return false
		}
	}
	return true
}
