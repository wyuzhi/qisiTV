package main

import (
	"errors"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

func validateHarnessPeer(conn *net.UnixConn) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var peerErr error
	err = raw.Control(func(fd uintptr) {
		credentials, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		peerErr = err
		if err == nil && credentials.Uid != uint32(os.Getuid()) {
			peerErr = errors.New("harness peer belongs to another user")
		}
	})
	return errors.Join(err, peerErr)
}
