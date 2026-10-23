package taskdelivery

import (
	"os/exec"
	"strings"
	"testing"
)

func TestTaskDeliveryDoesNotDependOnAppOrProviders(t *testing.T) {
	deps, err := exec.Command("go", "list", "-deps", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("list taskdelivery deps: %v\n%s", err, deps)
	}
	for _, dependency := range strings.Fields(string(deps)) {
		if dependency == "qisitv/backend/internal/app" {
			t.Fatal("taskdelivery depends on internal/app")
		}
	}
	direct, err := exec.Command("go", "list", "-f", "{{join .Imports \"\\n\"}}", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("list taskdelivery imports: %v\n%s", err, direct)
	}
	forbiddenDirect := map[string]bool{
		"qisitv/backend/internal/generation": true,
		"qisitv/backend/internal/provider":   true,
		"qisitv/backend/internal/protocol":   true,
		"qisitv/backend/internal/outbound":   true,
	}
	for _, dependency := range strings.Fields(string(direct)) {
		if forbiddenDirect[dependency] {
			t.Fatalf("taskdelivery directly imports %s", dependency)
		}
	}
}
