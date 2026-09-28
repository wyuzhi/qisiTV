package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"qisitv/backend/internal/browserbridge"
)

func runMCP(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("mcp", flag.ContinueOnError)
	port := flags.Int("port", 0, "Local bridge port; default reuses the configured port or 17372")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *port < 0 || *port > 65535 || flags.NArg() != 0 {
		return errors.New("invalid MCP arguments")
	}
	var client *browserbridge.Client
	var release func()
	var leaseFailed <-chan error
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		client, err = ensureLocalBridge(ctx, *port)
		if err != nil {
			return err
		}
		release, leaseFailed, err = client.HoldLease(ctx)
		if err == nil {
			break
		}
		var rpc *browserbridge.RPCError
		if !errors.As(err, &rpc) || rpc.Code != "SERVICE_STOPPING" && rpc.Code != "CONNECTOR_UNAVAILABLE" {
			return err
		}
		// The last old lease can expire between discovery and acquisition. Only
		// this startup handshake is retryable; no canvas tool has run yet.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	if err != nil {
		return err
	}
	defer release()
	mcpCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-mcpCtx.Done():
		case err := <-leaseFailed:
			fmt.Fprintln(os.Stderr, "qisiTV MCP lost its local service:", err)
			cancel()
		}
	}()
	return browserbridge.NewMCPServer(client).Run(mcpCtx, &mcp.StdioTransport{})
}

func existingBridge(ctx context.Context, port int) (*browserbridge.Client, error) {
	config, err := browserbridge.LoadConfig()
	if err != nil {
		path, pathErr := browserbridge.ConfigPath()
		if pathErr != nil {
			return nil, pathErr
		}
		if _, statErr := os.Stat(path); errors.Is(statErr, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if port != 0 {
		parsed, _ := url.Parse(config.Address)
		if parsed.Port() != strconv.Itoa(port) {
			return nil, errors.New("configured qisiTV service uses a different port; use a separate configuration directory when testing")
		}
	}
	client := browserbridge.NewClient(config)
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if _, err := client.Authenticate(probeCtx); err != nil {
		var networkError *url.Error
		if errors.As(err, &networkError) {
			return nil, nil
		}
		return nil, err
	}
	return client, nil
}

func ensureLocalBridge(ctx context.Context, port int) (*browserbridge.Client, error) {
	if client, err := existingBridge(ctx, port); client != nil || err != nil {
		return client, err
	}
	if port == 0 {
		port = browserbridge.DefaultPort
		if config, err := browserbridge.LoadConfig(); err == nil {
			parsed, _ := url.Parse(config.Address)
			port, _ = strconv.Atoi(parsed.Port())
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	child := exec.Command(executable, "managed-serve", "--port", strconv.Itoa(port))
	detachService(child)
	// No inherited stdio: the bridge must not hold the MCP client's protocol pipes
	// open after that client exits. Startup diagnostics are reported by this parent.
	if err = child.Start(); err != nil {
		return nil, fmt.Errorf("cannot start the qisiTV local service: %w", err)
	}
	go func() { _ = child.Wait() }()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if client, err := existingBridge(ctx, port); client != nil || err != nil {
			return client, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, fmt.Errorf("qisiTV could not start its local service at %s; another program or an older connector may occupy the port", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		case <-ticker.C:
		}
	}
}
