//go:build !darwin && !linux

package main

import (
	"errors"
	"net"
)

const harnessControlSupported = false

func listenHarnessControl(string, harnessRuntimeConfig) (net.Listener, error) {
	return nil, errors.New("harness control requires macOS or Linux")
}

func attachDesktopHarness(string) (harnessRuntimeConfig, error) {
	return harnessRuntimeConfig{}, errors.New("harness control requires macOS or Linux")
}
