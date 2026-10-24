package project

import (
	"os/exec"
	"strings"
	"testing"
)

func TestProjectDomainDoesNotDependOnApplicationService(t *testing.T) {
	command := exec.Command("go", "list", "-deps", ".")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("list project dependencies: %v", err)
	}
	for _, dependency := range strings.Fields(string(output)) {
		if dependency == "qisitv/backend/internal/app" {
			t.Fatal("project domain still depends on the application service kernel")
		}
	}
}
