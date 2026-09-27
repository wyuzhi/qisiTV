package task

import (
	"context"
	"testing"

	"qisitv/backend/internal/model"
)

type fakeBackend struct{ created *model.Task }

func (f fakeBackend) TasksWithOptions(string, ListOptions) ([]Summary, error) {
	return nil, nil
}
func (f fakeBackend) CreateLocalTask(string, CreateRequest) (*model.Task, error) {
	return f.created, nil
}
func (fakeBackend) StartWorker()                     {}
func (fakeBackend) StopWorker(context.Context) error { return nil }
func (fakeBackend) Close() error                     { return nil }

func TestServiceDelegatesLocalTaskCreation(t *testing.T) {
	svc := New(fakeBackend{created: &model.Task{ID: "task"}})
	task, err := svc.CreateTask("local", CreateRequest{Prompt: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if task.ID != "task" {
		t.Fatalf("created task = %#v", task)
	}
}
