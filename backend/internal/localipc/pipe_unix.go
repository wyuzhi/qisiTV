//go:build !windows

package localipc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func platformWorkspaceEndpoint(string) string { return "" }

func platformAgentHostEndpoint(string) string { return "" }

func tightenPlatformSecurity(endpoint string) error {
	if !validPlatformEndpoint(endpoint) {
		return fmt.Errorf("无效的本地套接字地址: %s", endpoint)
	}
	return os.Chmod(endpoint, 0o600)
}

func isTransientPlatformSecurityError(err error) bool {
	return errors.Is(err, os.ErrNotExist)
}

func validPlatformEndpoint(endpoint string) bool {
	if validWindowsPipeName(endpoint) {
		return false
	}
	return filepath.IsAbs(endpoint) && strings.HasSuffix(endpoint, ".sock") && len(endpoint) <= 104
}

type unixPipeListener struct {
	*net.UnixListener
	path      string
	closeOnce sync.Once
}

func Listen(endpoint string) (net.Listener, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !validPlatformEndpoint(endpoint) {
		return nil, fmt.Errorf("无效的本地套接字地址: %s", endpoint)
	}
	if err := os.MkdirAll(filepath.Dir(endpoint), 0o700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(endpoint); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("本地套接字路径已被非套接字文件占用")
		}
		_ = os.Remove(endpoint)
	}
	ul, err := net.ListenUnix("unix", &net.UnixAddr{Name: endpoint, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(endpoint, 0o600); err != nil {
		_ = ul.Close()
		_ = os.Remove(endpoint)
		return nil, err
	}
	ul.SetUnlinkOnClose(true)
	return &unixPipeListener{UnixListener: ul, path: endpoint}, nil
}

func (l *unixPipeListener) Accept() (net.Conn, error) {
	conn, err := l.UnixListener.Accept()
	if err != nil {
		return nil, err
	}
	return loopbackPipeConn{Conn: conn}, nil
}

func (l *unixPipeListener) Close() error {
	var err error
	l.closeOnce.Do(func() {
		err = l.UnixListener.Close()
		_ = os.Remove(l.path)
	})
	return err
}

func (l *unixPipeListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

func DialContext(ctx context.Context, endpoint string) (net.Conn, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !validPlatformEndpoint(endpoint) {
		return nil, fmt.Errorf("无效的本地套接字地址: %s", endpoint)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", endpoint)
	if err != nil {
		return nil, err
	}
	return loopbackPipeConn{Conn: conn}, nil
}
