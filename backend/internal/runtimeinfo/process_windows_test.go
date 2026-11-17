package runtimeinfo

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestTerminatedWindowsProcessWithOpenHandleIsNotAlive(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	// Retaining a handle keeps the process object accessible after termination.
	held, err := os.FindProcess(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if ProcessAlive(cmd.Process.Pid) {
		t.Fatal("terminated process with a retained handle reported alive")
	}
}

func TestWindowsProcessMatchesStartRejectsRecycledPIDCreatedAfterDescriptor(t *testing.T) {
	pid := os.Getpid()
	if !processMatchesStart(pid, time.Now().UTC()) {
		t.Fatal("current process should match a descriptor written after process creation")
	}
	if processMatchesStart(pid, time.Now().UTC().Add(-10*time.Minute)) {
		t.Fatal("process created minutes after descriptor timestamp was treated as original runtime")
	}
}
