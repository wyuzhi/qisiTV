package bootstrap

import (
	"os/exec"
	"strings"
	"testing"
)

func TestDesktopDependencyGraphDoesNotContainServiceAliasPackage(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./cmd/desktop")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list desktop dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "qisitv/backend/internal/service" {
			t.Fatal("desktop dependency graph still contains the service alias package")
		}
	}
}

func TestTaskDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", "./internal/task")
	command.Dir = "../.."
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list task dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "qisitv/backend/internal/app" {
			t.Fatal("task domain still depends on the application service kernel")
		}
	}
}
