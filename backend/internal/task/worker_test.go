package task

import (
	"context"
	"errors"
	"testing"

	"qisitv/backend/internal/model"
)

type fakeLifecycle struct {
	started bool
	stopped bool
	closed  bool
}

func (f *fakeLifecycle) TasksWithOptions(string, ListOptions) ([]Summary, error) { return nil, nil }
func (f *fakeLifecycle) CreateLocalTask(string, CreateRequest) (*model.Task, error) {
	return nil, nil
}

func (f *fakeLifecycle) StartWorker() { f.started = true }
func (f *fakeLifecycle) StopWorker(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	f.stopped = true
	return nil
}
func (f *fakeLifecycle) Close() error { f.closed = true; return nil }

func TestRuntimePropagatesCancellationAndLifecycle(t *testing.T) {
	backend := &fakeLifecycle{}
	runtime := New(backend)
	runtime.StartWorker()
	if !backend.started {
		t.Fatal("worker was not started")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.StopWorker(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("StopWorker error = %v, want context canceled", err)
	}
	if backend.stopped {
		t.Fatal("cancelled stop was reported as drained")
	}
	if err := runtime.StopWorker(context.Background()); err != nil || !backend.stopped {
		t.Fatalf("normal stop = %v stopped=%v", err, backend.stopped)
	}
	if err := runtime.Close(); err != nil || !backend.closed {
		t.Fatalf("close = %v closed=%v", err, backend.closed)
	}
}
