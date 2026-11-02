package task

import (
	"context"
	"errors"
	"testing"
	"time"

	"qisitv/backend/internal/model"
)

type spyRecoveryPort struct {
	resetBackoffCalls []string
	deliveryCalls     []string
	imageCalls        []string
	videoCalls        []string
	tasks             map[string]*model.Task
}

func (s *spyRecoveryPort) ResetBackoff(_, taskID string) error {
	s.resetBackoffCalls = append(s.resetBackoffCalls, taskID)
	if task := s.tasks[taskID]; task != nil {
		task.NextPollAt = nil
	}
	return nil
}

func (s *spyRecoveryPort) ResumeDelivery(_ context.Context, _, taskID string) (*model.Task, error) {
	s.deliveryCalls = append(s.deliveryCalls, taskID)
	task := s.tasks[taskID]
	if task == nil {
		return nil, errors.New("not found")
	}
	cp := *task
	cp.Stage = "全部生成结果已入库"
	return &cp, nil
}

func (s *spyRecoveryPort) RecoverImage(_ context.Context, _, taskID string) (*model.Task, error) {
	s.imageCalls = append(s.imageCalls, taskID)
	task := s.tasks[taskID]
	if task == nil {
		return nil, errors.New("not found")
	}
	cp := *task
	cp.Status = model.TaskStatusSucceeded
	cp.Stage = "图片已从上游完成回执恢复"
	return &cp, nil
}

func (s *spyRecoveryPort) RecoverVideoOrUpscale(_ context.Context, _, taskID string) (*model.Task, error) {
	s.videoCalls = append(s.videoCalls, taskID)
	task := s.tasks[taskID]
	if task == nil {
		return nil, errors.New("not found")
	}
	cp := *task
	cp.Status = model.TaskStatusSucceeded
	cp.Stage = "视频生成完成"
	return &cp, nil
}

type forbidMutationStore struct {
	tasks     map[string]*model.Task
	retryRun  int
	createRun int
}

func (s *forbidMutationStore) TaskForUser(userID, id string) (*model.Task, error) {
	t := s.tasks[id]
	if t == nil || t.UserID != userID {
		return nil, errors.New("not found")
	}
	cp := *t
	return &cp, nil
}

func (s *forbidMutationStore) TaskByClientOperation(string, string) (*model.Task, error) {
	return nil, nil
}

func (s *forbidMutationStore) ActiveTaskCount(string) (int64, error) {
	return 0, nil
}

func (s *forbidMutationStore) CreateWithLimit(*model.Task, int) error {
	s.createRun++
	return errors.New("CreateWithLimit must never be called by RecoverTask")
}

func (s *forbidMutationStore) Retry(string, *model.Task, int) (*model.Task, error) {
	s.retryRun++
	return nil, errors.New("Retry must never be called by RecoverTask")
}

func (s *forbidMutationStore) CancelIfStatus(string, string, model.TaskStatus, time.Time) (bool, error) {
	return false, errors.New("CancelIfStatus must never be called by RecoverTask")
}

func (s *forbidMutationStore) List(string, int, string, bool) ([]model.Task, error) {
	return nil, nil
}

func (s *forbidMutationStore) Logs(string, string) ([]model.TaskLog, error) {
	return nil, nil
}

func (s *forbidMutationStore) LatestProviderRequestID(string) (string, error) {
	return "", nil
}

type noopRuntime struct {
	draining bool
}

func (r noopRuntime) IsDraining() bool             { return r.draining }
func (r noopRuntime) StopLocalWait(string)         {}
func (r noopRuntime) Dispatch(fn func()) bool      { fn(); return true }

type identityPresenter struct{}

func (identityPresenter) Task(t model.Task) *model.Task          { return &t }
func (identityPresenter) Summaries([]model.Task) []Summary       { return nil }
func (identityPresenter) Logs(l []model.TaskLog) []model.TaskLog { return l }

func TestRecoverTaskRoutesOnlyFreeRecoveryAndNeverCreatesOrRetries(t *testing.T) {
	future := time.Now().Add(time.Minute)
	tasks := map[string]*model.Task{
		"task-delivery": {
			ID:       "task-delivery",
			UserID:   "user-1",
			Type:     "canvas_image",
			Status:   model.TaskStatusSucceeded,
			RouteRun: 2,
		},
		"task-image": {
			ID:         "task-image",
			UserID:     "user-1",
			Type:       "canvas_image",
			Model:      "nanobanana-pro",
			Status:     model.TaskStatusFailed,
			RouteRun:   1,
			NextPollAt: &future,
		},
		"task-video": {
			ID:                "task-video",
			UserID:            "user-1",
			Type:              "canvas_video",
			Model:             "seedance-2.0",
			Status:            model.TaskStatusFailed,
			ProviderRequestID: "prov-video-1",
			RouteRun:          3,
			NextPollAt:        &future,
		},
		"task-image-upscale": {
			ID:                "task-image-upscale",
			UserID:            "user-1",
			Type:              "canvas_image",
			Model:             "topaz-standard-v2",
			InputJSON:         `{"mode":"image","upscale":{"factor":2}}`,
			Status:            model.TaskStatusFailed,
			ProviderRequestID: "prov-upscale-1",
			RouteRun:          1,
			NextPollAt:        &future,
		},
		"task-cancelled": {
			ID:       "task-cancelled",
			UserID:   "user-1",
			Type:     "canvas_video",
			Status:   model.TaskStatusCancelled,
			RouteRun: 1,
		},
	}

	store := &forbidMutationStore{tasks: tasks}
	recovery := &spyRecoveryPort{tasks: tasks}
	svc := NewService(store, Dependencies{
		Runtime:  noopRuntime{},
		Recovery: recovery,
		Present:  identityPresenter{},
	})

	ctx := context.Background()

	deliv, err := svc.RecoverTask(ctx, "user-1", "task-delivery")
	if err != nil {
		t.Fatalf("RecoverTask(delivery) error = %v", err)
	}
	if deliv.RouteRun != 2 || len(recovery.deliveryCalls) != 1 {
		t.Fatalf("unexpected delivery recover result: %+v calls=%v", deliv, recovery.deliveryCalls)
	}

	img, err := svc.RecoverTask(ctx, "user-1", "task-image")
	if err != nil {
		t.Fatalf("RecoverTask(image) error = %v", err)
	}
	if img.Status != model.TaskStatusSucceeded || img.RouteRun != 1 || len(recovery.imageCalls) != 1 {
		t.Fatalf("unexpected image recover result: %+v calls=%v", img, recovery.imageCalls)
	}

	vid, err := svc.RecoverTask(ctx, "user-1", "task-video")
	if err != nil {
		t.Fatalf("RecoverTask(video) error = %v", err)
	}
	if vid.Status != model.TaskStatusSucceeded || vid.RouteRun != 3 || len(recovery.videoCalls) != 1 {
		t.Fatalf("unexpected video recover result: %+v calls=%v", vid, recovery.videoCalls)
	}

	up, err := svc.RecoverTask(ctx, "user-1", "task-image-upscale")
	if err != nil {
		t.Fatalf("RecoverTask(image-upscale) error = %v", err)
	}
	if up.Status != model.TaskStatusSucceeded || up.RouteRun != 1 || len(recovery.videoCalls) != 2 {
		t.Fatalf("expected image upscale to route to RecoverVideoOrUpscale, got %+v videoCalls=%v imageCalls=%v", up, recovery.videoCalls, recovery.imageCalls)
	}
	if len(recovery.resetBackoffCalls) != 3 {
		t.Fatalf("expected ResetBackoff on all 3 failed tasks, got %v", recovery.resetBackoffCalls)
	}

	if _, err := svc.RecoverTask(ctx, "user-1", "task-cancelled"); err == nil {
		t.Fatal("expected cancelled task to be rejected by RecoverTask")
	}
	if store.retryRun != 0 || store.createRun != 0 {
		t.Fatalf("RecoverTask must never call Retry (%d) or CreateWithLimit (%d)", store.retryRun, store.createRun)
	}
}
