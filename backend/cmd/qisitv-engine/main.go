// qisitv-engine hosts the native workspace behind an explicitly paired web UI.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/browserbridge"
	"qisitv/backend/internal/buildinfo"
	"qisitv/backend/internal/desktopstorage"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "qisiTV engine:", err)
		os.Exit(1)
	}
}

func defaultDataDir() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("QISITV_ENGINE_DATA_DIR")); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", errors.New("QISITV_ENGINE_DATA_DIR must be absolute")
		}
		return configured, nil
	}
	root, err := engineProfileRoot()
	if err != nil {
		return "", err
	}
	return root, nil
}

func engineProfileRoot() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "qisiTV", "Engine", "workspace"), nil
}

func run(ctx context.Context, args []string) error {
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	if len(args) > 0 {
		switch args[0] {
		case "storage":
			return storageCommand(ctx, args[1:])
		case "version", "--version":
			fmt.Println("qisitv-engine", buildinfo.Current().Version)
			return nil
		case "serve", "managed-serve":
			args = args[1:]
		}
	}
	defaultDir, err := defaultDataDir()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("qisitv-engine", flag.ContinueOnError)
	port := flags.Int("port", browserbridge.DefaultPort, "Loopback gateway port")
	dataDir := flags.String("data-dir", defaultDir, "Private absolute engine data directory")
	projectsDir := flags.String("projects-dir", "", "Explicitly confirmed absolute project root; otherwise choose it in the paired website")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *port < 1 || *port > 65535 || !filepath.IsAbs(*dataDir) {
		return errors.New("use an absolute --data-dir and a port between 1 and 65535")
	}
	var locationLock *os.File
	explicitData := strings.TrimSpace(os.Getenv("QISITV_ENGINE_DATA_DIR")) != ""
	flags.Visit(func(value *flag.Flag) {
		if value.Name == "data-dir" {
			explicitData = true
		}
	})
	if !explicitData {
		profile, err := engineProfileRoot()
		if err != nil {
			return err
		}
		locationLock, err = lockEngineLocation(profile)
		if err != nil {
			return err
		}
		defer locationLock.Close()
		// Re-resolve under the same lock used by an offline migration.
		*dataDir, err = desktopstorage.Resolve(profile)
		if err != nil {
			return err
		}
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("cannot open the local gateway; stop the previous qisiTV connector first: %w", err)
	}
	defer listener.Close()
	var shell *engineShell
	runtime, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: *dataDir, DatabaseDriver: "sqlite", ListenAddr: "127.0.0.1:0", AutoMigrate: true, ShutdownTimeout: 10 * time.Minute, RouterMiddleware: []gin.HandlerFunc{engineFolderGuard(func() *engineShell { return shell })}})
	if err != nil {
		return err
	}
	if locationLock != nil {
		_ = locationLock.Close()
	}
	defer func() {
		stop()
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		_ = runtime.Close(closeCtx)
	}()
	shell, err = newEngineShell(ctx, runtime, *dataDir, *projectsDir)
	if err != nil {
		return err
	}
	shell.stop = stop
	if err := runtime.Start(); err != nil {
		return err
	}
	config, err := browserbridge.SaveConfig("http://" + listener.Addr().String())
	if err != nil {
		return err
	}
	bridge := browserbridge.NewServer(config.AgentToken, *port)
	gateway, err := browserbridge.NewEngineGateway(browserbridge.EngineConfig{BaseURL: runtime.BaseURL(), LaunchToken: runtime.LaunchToken(), UIBootstrapToken: runtime.UIBootstrapToken(), Version: buildinfo.Current().Version, Shell: shell, Ready: runtime.Ready, WorkspaceConfigured: shell.configured, ProjectDirectory: shell.directory, CheckWritable: shell.checkWritable})
	if err != nil {
		return err
	}
	bridge.SetEngine(gateway)
	// The native engine owns durable tasks and remains available independently
	// of an MCP client's lifetime. The existing MCP-only bridge keeps its leases.
	server := &http.Server{Handler: bridge, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	fmt.Fprintln(os.Stderr, "qisiTV 本机引擎已启动。打开 https://cheeser.link/qisitv/ 并通过 qisitv_pair 完成配对。")
	var serveErr error
	select {
	case <-ctx.Done():
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	case err := <-runtime.Errors():
		serveErr = err
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
	}
	return serveErr
}
