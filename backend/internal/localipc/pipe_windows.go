//go:build windows

package localipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32DLL        = windows.NewLazySystemDLL("kernel32.dll")
	procWaitNamedPipe  = kernel32DLL.NewProc("WaitNamedPipeW")
	defaultDialTimeout = 30 * time.Second
)

const pipeBufferSize = 64 * 1024

func platformWorkspaceEndpoint(dataDir string) string {
	if strings.TrimSpace(dataDir) == "" {
		return ""
	}
	return `\\.\pipe\beeftv-ws-` + canonicalDataDirDigest(dataDir) + "-" + strconv.Itoa(os.Getpid())
}

func platformAgentHostEndpoint(randomID string) string {
	return `\\.\pipe\beeftv-agent-` + sanitizeToken(randomID, 24) + "-" + strconv.Itoa(os.Getpid())
}

func validPlatformEndpoint(endpoint string) bool {
	return validWindowsPipeName(endpoint)
}

type windowsPipeFileConn struct {
	file *os.File
}

func newWindowsPipeConn(h windows.Handle, name string) net.Conn {
	return &windowsPipeFileConn{file: os.NewFile(uintptr(h), name)}
}

func (c *windowsPipeFileConn) Read(b []byte) (int, error)         { return c.file.Read(b) }
func (c *windowsPipeFileConn) Write(b []byte) (int, error)        { return c.file.Write(b) }
func (c *windowsPipeFileConn) Close() error                       { return c.file.Close() }
func (c *windowsPipeFileConn) SetDeadline(t time.Time) error      { return c.file.SetDeadline(t) }
func (c *windowsPipeFileConn) SetReadDeadline(t time.Time) error  { return c.file.SetReadDeadline(t) }
func (c *windowsPipeFileConn) SetWriteDeadline(t time.Time) error { return c.file.SetWriteDeadline(t) }
func (c *windowsPipeFileConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}
func (c *windowsPipeFileConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

type windowsPipeListener struct {
	path          string
	sd            *windows.SECURITY_DESCRIPTOR
	closeEvent    windows.Handle
	mu            sync.Mutex
	pendingHandle windows.Handle
	closed        bool
	acceptWG      sync.WaitGroup
	closeOnce     sync.Once
}

// Listen binds a current-user-only Windows Named Pipe with remote SMB clients rejected.
func Listen(endpoint string) (net.Listener, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !validWindowsPipeName(endpoint) {
		return nil, fmt.Errorf("无效的本地命名管道地址: %s", endpoint)
	}
	sd, err := currentUserSecurityDescriptor()
	if err != nil {
		return nil, err
	}
	closeEvent, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return nil, err
	}
	l := &windowsPipeListener{
		path:       endpoint,
		sd:         sd,
		closeEvent: closeEvent,
	}
	first, err := l.createInstance(true)
	if err != nil {
		_ = windows.CloseHandle(closeEvent)
		return nil, err
	}
	l.pendingHandle = first
	return l, nil
}

func (l *windowsPipeListener) createInstance(first bool) (windows.Handle, error) {
	namePtr, err := windows.UTF16PtrFromString(l.path)
	if err != nil {
		return 0, err
	}
	openMode := uint32(windows.PIPE_ACCESS_DUPLEX | windows.FILE_FLAG_OVERLAPPED)
	if first {
		openMode |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
	}
	pipeMode := uint32(windows.PIPE_TYPE_BYTE | windows.PIPE_READMODE_BYTE | windows.PIPE_WAIT | windows.PIPE_REJECT_REMOTE_CLIENTS)
	sa := &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: l.sd,
	}
	return windows.CreateNamedPipe(
		namePtr,
		openMode,
		pipeMode,
		windows.PIPE_UNLIMITED_INSTANCES,
		pipeBufferSize,
		pipeBufferSize,
		0,
		sa,
	)
}

func (l *windowsPipeListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, net.ErrClosed
	}
	l.acceptWG.Add(1)
	l.mu.Unlock()
	defer l.acceptWG.Done()

	for {
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil, net.ErrClosed
		}
		h := l.pendingHandle
		l.pendingHandle = 0
		l.mu.Unlock()

		if h == 0 {
			var err error
			h, err = l.createInstance(false)
			if err != nil {
				l.mu.Lock()
				closed := l.closed
				l.mu.Unlock()
				if closed {
					return nil, net.ErrClosed
				}
				return nil, err
			}
		}

		connected, err := l.waitConnect(h)
		if !connected {
			_ = windows.CloseHandle(h)
			if err != nil {
				return nil, err
			}
			continue
		}

		// Pre-create the next server pipe instance before returning so concurrent
		// clients always find a listening kernel pipe instance.
		l.mu.Lock()
		if !l.closed && l.pendingHandle == 0 {
			if next, nextErr := l.createInstance(false); nextErr == nil {
				l.pendingHandle = next
			}
		}
		if l.closed {
			l.mu.Unlock()
			_ = windows.CloseHandle(h)
			return nil, net.ErrClosed
		}
		l.mu.Unlock()

		return newWindowsPipeConn(h, l.path), nil
	}
}

func (l *windowsPipeListener) waitConnect(h windows.Handle) (bool, error) {
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(ev)

	var ov windows.Overlapped
	ov.HEvent = ev
	err = windows.ConnectNamedPipe(h, &ov)
	switch {
	case err == nil || errors.Is(err, windows.ERROR_PIPE_CONNECTED):
		return true, nil
	case errors.Is(err, windows.ERROR_NO_DATA):
		return false, nil
	case errors.Is(err, windows.ERROR_IO_PENDING):
		idx, waitErr := windows.WaitForMultipleObjects([]windows.Handle{ev, l.closeEvent}, false, windows.INFINITE)
		if waitErr != nil || idx != windows.WAIT_OBJECT_0 {
			_ = windows.CancelIoEx(h, &ov)
			var transferred uint32
			_ = windows.GetOverlappedResult(h, &ov, &transferred, true)
			return false, net.ErrClosed
		}
		var transferred uint32
		if resErr := windows.GetOverlappedResult(h, &ov, &transferred, false); resErr != nil {
			if errors.Is(resErr, windows.ERROR_PIPE_CONNECTED) {
				return true, nil
			}
			return false, nil
		}
		return true, nil
	default:
		l.mu.Lock()
		closed := l.closed
		l.mu.Unlock()
		if closed {
			return false, net.ErrClosed
		}
		return false, err
	}
}

func (l *windowsPipeListener) Close() error {
	l.closeOnce.Do(func() {
		l.mu.Lock()
		l.closed = true
		pending := l.pendingHandle
		l.pendingHandle = 0
		l.mu.Unlock()

		_ = windows.SetEvent(l.closeEvent)
		if pending != 0 {
			_ = windows.CloseHandle(pending)
		}
		l.acceptWG.Wait()
		_ = windows.CloseHandle(l.closeEvent)
	})
	return nil
}

func (l *windowsPipeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

// DialContext connects to a local BeefTV Windows Named Pipe with anonymous SQOS
// so the pipe server cannot impersonate the caller's token.
func DialContext(ctx context.Context, endpoint string) (net.Conn, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !validWindowsPipeName(endpoint) {
		return nil, fmt.Errorf("无效的本地命名管道地址: %s", endpoint)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline && defaultDialTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultDialTimeout)
		defer cancel()
	}
	namePtr, err := windows.UTF16PtrFromString(endpoint)
	if err != nil {
		return nil, err
	}
	flags := uint32(windows.FILE_FLAG_OVERLAPPED | windows.SECURITY_SQOS_PRESENT | windows.SECURITY_ANONYMOUS)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := windows.CreateFile(
			namePtr,
			windows.GENERIC_READ|windows.GENERIC_WRITE,
			0,
			nil,
			windows.OPEN_EXISTING,
			flags,
			0,
		)
		if err == nil {
			return newWindowsPipeConn(h, endpoint), nil
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) {
			return nil, err
		}
		waitMs := uint32(50)
		if deadline, ok := ctx.Deadline(); ok {
			rem := time.Until(deadline)
			if rem <= 0 {
				return nil, context.DeadlineExceeded
			}
			if rem < 50*time.Millisecond {
				waitMs = max(1, uint32(rem/time.Millisecond))
			}
		}
		r1, _, _ := procWaitNamedPipe.Call(uintptr(unsafe.Pointer(namePtr)), uintptr(waitMs))
		if r1 == 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
}

// tightenPlatformSecurity replaces the kernel Named Pipe DACL (e.g. on a pipe
// created by Node/libuv with default NULL SECURITY_ATTRIBUTES) with our strict
// protected DACL denying NT AUTHORITY\NETWORK and granting only the current user SID.
func tightenPlatformSecurity(endpoint string) error {
	if !validWindowsPipeName(endpoint) {
		return fmt.Errorf("无效的本地命名管道地址: %s", endpoint)
	}
	sd, err := currentUserSecurityDescriptor()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	namePtr, err := windows.UTF16PtrFromString(endpoint)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(
		namePtr,
		windows.WRITE_DAC,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS,
		0,
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.SetSecurityInfo(
		h,
		windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	)
}

func isTransientPlatformSecurityError(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PATH_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PIPE_BUSY)
}

func currentUserSIDString() (string, error) {
	tok, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer tok.Close()
	user, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func currentUserSecurityDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	sid, err := currentUserSIDString()
	if err != nil {
		return nil, err
	}
	// Protected DACL explicitly denying NT AUTHORITY\NETWORK (NU) and granting
	// GENERIC_ALL only to the exact current user SID (stripping Everyone/Anonymous),
	// plus Medium Mandatory Label so normal-integrity CLI processes can talk to an
	// elevated desktop instance of the same user while Low/Untrusted sandboxes cannot.
	baseDACL := "D:P(D;;GA;;;NU)(A;;GA;;;" + sid + ")"
	if sd, err := windows.SecurityDescriptorFromString(baseDACL + "S:(ML;;NW;;;ME)"); err == nil {
		return sd, nil
	}
	return windows.SecurityDescriptorFromString(baseDACL)
}
