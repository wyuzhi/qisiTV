//go:build windows

package localipc

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func readPipeDACLString(t *testing.T, endpoint string) string {
	t.Helper()
	ptr, err := windows.UTF16PtrFromString(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(
		ptr,
		windows.READ_CONTROL,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS,
		0,
	)
	if err != nil {
		t.Fatalf("CreateFile(READ_CONTROL): %v", err)
	}
	defer windows.CloseHandle(h)

	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo: %v", err)
	}
	return sd.String()
}

func assertCurrentUserOnlyPipeSDDL(t *testing.T, sddl, userSID string) {
	t.Helper()
	// ConvertSecurityDescriptorToStringSecurityDescriptorW abbreviates the built-in
	// Local Administrator RID (-500, e.g. runneradmin on GitHub Actions) as "LA".
	hasOwnerAllow := strings.Contains(sddl, ";"+userSID+")") ||
		(strings.HasSuffix(userSID, "-500") && strings.Contains(sddl, ";LA)"))
	if !strings.HasPrefix(sddl, "D:P") || !strings.Contains(sddl, ";NU)") || !hasOwnerAllow {
		t.Fatalf("expected protected current-user + deny-network SDDL for %s, got %q", userSID, sddl)
	}
	for _, forbidden := range []string{";WD)", ";AN)", ";AU)", ";BU)"} {
		if strings.Contains(sddl, forbidden) {
			t.Fatalf("pipe DACL must not grant broad principal %s: %q", forbidden, sddl)
		}
	}
}

func TestWindowsPipeDACLDeniesNetworkAndEveryone(t *testing.T) {
	userSID, err := currentUserSIDString()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Go-created server pipe via Listen.
	goPipe := AgentHostEndpoint()
	listener, err := Listen(goPipe)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer listener.Close()

	assertCurrentUserOnlyPipeSDDL(t, readPipeDACLString(t, goPipe), userSID)

	// 2. Child-created pipe with default NULL SECURITY_ATTRIBUTES (matching libuv)
	// tightened via TightenEndpointSecurity before credentials are sent.
	libuvPipe := AgentHostEndpoint()
	namePtr, err := windows.UTF16PtrFromString(libuvPipe)
	if err != nil {
		t.Fatal(err)
	}
	rawHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.WRITE_DAC|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		windows.PIPE_UNLIMITED_INSTANCES,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe default DACL: %v", err)
	}
	defer windows.CloseHandle(rawHandle)

	if err := TightenEndpointSecurity(libuvPipe); err != nil {
		t.Fatalf("TightenEndpointSecurity: %v", err)
	}
	firstSD, err := windows.GetSecurityInfo(rawHandle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo(rawHandle): %v", err)
	}
	assertCurrentUserOnlyPipeSDDL(t, firstSD.String(), userSID)

	// 3. Subsequent pipe instance created with NULL SECURITY_ATTRIBUTES (exact libuv
	// accept-loop behavior for the next request carrying credentials) must inherit
	// the tightened kernel named-pipe object DACL rather than reverting to Everyone.
	secondHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		windows.PIPE_UNLIMITED_INSTANCES,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe second instance: %v", err)
	}
	defer windows.CloseHandle(secondHandle)

	secondSD, err := windows.GetSecurityInfo(secondHandle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo(secondHandle): %v", err)
	}
	assertCurrentUserOnlyPipeSDDL(t, secondSD.String(), userSID)
	// Also verify client-side CreateFile(READ_CONTROL) against the live second instance.
	assertCurrentUserOnlyPipeSDDL(t, readPipeDACLString(t, libuvPipe), userSID)
}

func TestDialContextBoundsWaitWhenAllPipeInstancesAreBusy(t *testing.T) {
	busyPipe := AgentHostEndpoint()
	namePtr, err := windows.UTF16PtrFromString(busyPipe)
	if err != nil {
		t.Fatal(err)
	}
	// MaxInstances=1: once connected, all instances are busy (ERROR_PIPE_BUSY).
	srvHandle, err := windows.CreateNamedPipe(
		namePtr,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT,
		1,
		4096,
		4096,
		0,
		nil,
	)
	if err != nil {
		t.Fatalf("CreateNamedPipe(max=1): %v", err)
	}
	defer windows.CloseHandle(srvHandle)

	occupant, err := windows.CreateFile(
		namePtr,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS,
		0,
	)
	if err != nil {
		t.Fatalf("occupy sole pipe instance: %v", err)
	}
	defer windows.CloseHandle(occupant)

	prevTimeout := defaultDialTimeout
	defaultDialTimeout = 120 * time.Millisecond
	defer func() { defaultDialTimeout = prevTimeout }()

	start := time.Now()
	conn, dialErr := DialContext(context.Background(), busyPipe)
	if dialErr == nil {
		_ = conn.Close()
		t.Fatal("expected busy pipe dial without caller deadline to time out")
	}
	if !errors.Is(dialErr, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", dialErr)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("expected bounded dial failure within 2s, took %v", elapsed)
	}
}
