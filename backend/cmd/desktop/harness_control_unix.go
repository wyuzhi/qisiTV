//go:build darwin || linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const harnessControlSupported = true

func harnessSocketPath(dataDir string) (string, error) {
	canonical, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(canonical); err == nil {
		canonical = resolved
	}
	digest := sha256.Sum256([]byte(canonical))
	// A relocated data directory may exceed Unix's socket pathname limit.
	return filepath.Join("/tmp", fmt.Sprintf("beeftv-harness-%d-%s.sock", os.Getuid(), hex.EncodeToString(digest[:12]))), nil
}

func validateHarnessSocket(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 || stat.Uid != uint32(os.Getuid()) {
		return errors.New("harness control socket is not private to the current user")
	}
	return nil
}

func listenHarnessControl(dataDir string, config harnessRuntimeConfig) (net.Listener, error) {
	socketPath, err := harnessSocketPath(dataDir)
	if err != nil {
		return nil, err
	}
	// The caller already holds the workspace lock, so only stale sockets can remain.
	if info, err := os.Lstat(socketPath); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Getuid()) {
			return nil, errors.New("harness control socket is not private to the current user")
		}
		if err := os.Remove(socketPath); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	go func() {
		for {
			conn, err := listener.AcceptUnix()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				if err := validateHarnessPeer(conn); err != nil {
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				_ = json.NewEncoder(conn).Encode(config)
			}()
		}
	}()
	return listener, nil
}

func attachDesktopHarness(dataDir string) (harnessRuntimeConfig, error) {
	socketPath, err := harnessSocketPath(dataDir)
	if err != nil {
		return harnessRuntimeConfig{}, err
	}
	if err := validateHarnessSocket(socketPath); err != nil {
		return harnessRuntimeConfig{}, err
	}
	conn, err := net.DialTimeout("unix", socketPath, 300*time.Millisecond)
	if err != nil {
		return harnessRuntimeConfig{}, err
	}
	defer conn.Close()
	if err := validateHarnessPeer(conn.(*net.UnixConn)); err != nil {
		return harnessRuntimeConfig{}, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var config harnessRuntimeConfig
	if err := json.NewDecoder(io.LimitReader(conn, 64*1024)).Decode(&config); err != nil {
		return harnessRuntimeConfig{}, err
	}
	if config.BaseURL == "" || config.LaunchToken == "" || config.BridgeURL == "" || config.BridgeToken == "" {
		return harnessRuntimeConfig{}, errors.New("harness control returned an incomplete configuration")
	}
	config.Owned = false
	config.Attached = true
	return config, nil
}
