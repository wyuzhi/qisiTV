//go:build !windows

package webviewlock

import "time"

func prepareAndLeasePlatformProfile(string, bool, time.Duration, time.Duration) (func(), error) {
	return func() {}, nil
}

func waitAndReclaimPlatformProfile(string, time.Duration, time.Duration) error {
	return nil
}
