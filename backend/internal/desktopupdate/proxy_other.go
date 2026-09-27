//go:build !darwin && !windows

package desktopupdate

func readSystemProxy() systemProxySettings { return systemProxySettings{} }
