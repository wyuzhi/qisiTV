package taskbinding

import (
	"os/exec"
	"strings"
	"testing"
)

func TestTaskBindingDoesNotDependOnAppOrOperations(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/taskbinding")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list taskbinding dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "qisitv/backend/internal/app" {
			t.Fatal("taskbinding still depends on the application service kernel")
		}
		if dependency == "qisitv/backend/internal/operations" {
			t.Fatal("taskbinding still depends on the operations registry")
		}
		if dependency == "qisitv/backend/internal/canvas" {
			t.Fatal("taskbinding still depends on canvas document writes")
		}
	}
}
