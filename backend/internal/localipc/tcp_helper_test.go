package localipc

import "net"

func ListenTCPForTest() (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:0")
}
