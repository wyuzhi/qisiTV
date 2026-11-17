package task

import (
	"qisitv/backend/internal/model"
	"testing"
)

func TestSeedreamOutputIdentitiesStayTaskScoped(t *testing.T) {
	task := model.Task{ID: "task", Type: "canvas_image", Model: "channel::dola-seedream-5-0-pro-260628", InputJSON: `{"metadata":{"nodeId":"root"}}`}
	if OutputBinding(task, 0).NodeID != "root" || OutputBinding(task, 1).NodeID != "image-output-task-1" || SeedreamOutputNodeID(task, 29) != "image-output-task-29" || SeedreamOutputNodeID(task, 99) != "image-output-task-99" || SeedreamOutputNodeID(task, 100) != "" {
		t.Fatal("wrong destinations")
	}
	task.ID = "other"
	if OutputBinding(task, 1).NodeID != "image-output-other-1" {
		t.Fatal("not scoped to task")
	}
	task.InputJSON = `{"metadata":{"nodeId":"root","outputNodeIds":["a","b"]}}`
	if SeedreamOutputRoot(task) != "" {
		t.Fatal("fixed destinations changed")
	}
	task.Model = "channel::gpt-image-2"
	task.InputJSON = `{"metadata":{"nodeId":"root"}}`
	if OutputBinding(task, 1).NodeID != "root" {
		t.Fatal("unrelated model changed")
	}
}
