package runtimeinfo

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceLockRejectsLiveLegacyProcess(t *testing.T) {
	if os.Getenv("BEEFTV_LOCK_TEST_CHILD") == "1" {
		time.Sleep(time.Minute)
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestWorkspaceLockRejectsLiveLegacyProcess$")
	child.Env = append(os.Environ(), "BEEFTV_LOCK_TEST_CHILD=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	// A default Windows workspace has exactly the same protection as another drive.
	dir := filepath.Join(t.TempDir(), "AppData", "Roaming", "BeefTV")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(Info{BaseURL: "http://127.0.0.1:59999/api", PID: child.Process.Pid})
	if err := os.WriteFile(filepath.Join(dir, FileName), body, 0600); err != nil {
		t.Fatal(err)
	}
	if lock, err := LockWorkspace(dir); err == nil {
		lock.Close()
		t.Fatal("live legacy writer accepted")
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	lock, err := LockWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if runtime.GOOS == "windows" && !strings.Contains(lock.Name(), string(os.PathSeparator)+".beeftv"+string(os.PathSeparator)+"runtime"+string(os.PathSeparator)) {
		t.Fatal("lock remained inside AppData")
	}
	if duplicate, err := LockWorkspace(dir); err == nil {
		duplicate.Close()
		t.Fatal("second writer accepted")
	}
}

func TestWorkspaceLockRecoversStaleCrashedDescriptorAfterPIDReuse(t *testing.T) {
	if os.Getenv("BEEFTV_LOCK_REUSE_CHILD") == "1" {
		time.Sleep(time.Minute)
		return
	}
	child := exec.Command(os.Args[0], "-test.run=^TestWorkspaceLockRecoversStaleCrashedDescriptorAfterPIDReuse$")
	child.Env = append(os.Environ(), "BEEFTV_LOCK_REUSE_CHILD=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()

	dir := filepath.Join(t.TempDir(), "BeefTV")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	descriptorPath, dataDirHash, err := descriptorLocation(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(descriptorPath), 0700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(Info{
		BaseURL:     "http://127.0.0.1:59998/api",
		PID:         child.Process.Pid,
		Version:     "0.1.0",
		StartedAt:   time.Now().UTC().Add(-10 * time.Minute),
		DataDirHash: dataDirHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(descriptorPath, body, 0600); err != nil {
		t.Fatal(err)
	}

	lock, err := LockWorkspace(dir)
	if err != nil {
		t.Fatalf("crashed descriptor with reused PID blocked workspace lock: %v", err)
	}
	defer lock.Close()

	if _, statErr := os.Stat(descriptorPath); !os.IsNotExist(statErr) {
		t.Fatalf("stale descriptor was not cleaned up on lock acquisition: %v", statErr)
	}
}
