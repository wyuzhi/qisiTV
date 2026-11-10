package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/buildinfo"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

const harnessTokenHeader = "X-Beeftv-Harness-Token"

// The DSH Host marks every request it proxies for the embedded workspace page.
// Its own calls carry no marker, because it registers its MCP client here.
const harnessPageHeader = "X-Beeftv-Harness-Page"

type harnessRuntimeConfig struct {
	DesktopRuntimeConfig
	BridgeURL   string `json:"bridgeURL"`
	BridgeToken string `json:"bridgeToken"`
	Owned       bool   `json:"owned"`
	Attached    bool   `json:"attached"`
	Version     string `json:"version"`
}

type desktopHarness struct {
	config  harnessRuntimeConfig
	server  *http.Server
	control net.Listener
}

var desktopHarnesses sync.Map // *bootstrap.Runtime -> *desktopHarness

func handleHarnessCommand(args []string) (bool, error) {
	if !hasHarnessFlag(args) {
		return false, nil
	}
	flags := flag.NewFlagSet("BeefTV harness runtime", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Bool("harness-runtime", false, "run or attach the local workspace backend")
	attachOnly := flags.Bool("harness-attach-only", false, "attach without opening a workspace backend")
	explicitDataDir := flags.String("data-dir", "", "absolute workspace data directory")
	if err := flags.Parse(args); err != nil {
		return true, err
	}
	if flags.NArg() != 0 {
		return true, errors.New("harness runtime does not accept positional arguments")
	}
	if !harnessControlSupported {
		return true, errors.New("harness runtime requires macOS or Linux")
	}
	dataDir, err := defaultDataDir()
	if *explicitDataDir != "" {
		dataDir, err = explicitDesktopDataDir(*explicitDataDir)
	}
	if err != nil {
		return true, err
	}
	if config, err := attachDesktopHarness(dataDir); err == nil {
		return true, json.NewEncoder(os.Stdout).Encode(config)
	}
	if *attachOnly {
		return true, errors.New("本机 BeefTV 尚未就绪，请先启动桌面应用")
	}
	// Readiness is the only stdout record. Backend diagnostics belong on stderr.
	gin.DefaultWriter = os.Stderr
	gin.DefaultErrorWriter = os.Stderr
	if err := configureDesktopTemp(dataDir); err != nil {
		return true, err
	}
	app := newDesktopApp(dataDir)
	if err := app.start(context.Background()); err != nil {
		// The lock can race another primary process publishing its control socket.
		for i := 0; i < 20; i++ {
			if config, attachErr := attachDesktopHarness(dataDir); attachErr == nil {
				return true, json.NewEncoder(os.Stdout).Encode(config)
			}
			time.Sleep(100 * time.Millisecond)
		}
		return true, err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = app.stop(ctx)
	}()
	bridge, ok := desktopHarnesses.Load(app.runtime())
	if !ok {
		return true, errors.New("harness bridge did not start")
	}
	config := bridge.(*desktopHarness).config
	config.Owned = true
	if err := json.NewEncoder(os.Stdout).Encode(config); err != nil {
		return true, err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	inputClosed := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(inputClosed) }()
	select {
	case <-ctx.Done():
	case <-inputClosed:
	case err := <-app.runtime().Errors():
		return true, err
	}
	return true, nil
}

func hasHarnessFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--harness-runtime" {
			return true
		}
	}
	return false
}

func startDesktopHarness(runtime *bootstrap.Runtime, dataDir string) error {
	if !harnessControlSupported {
		return nil
	}
	token, err := httptransport.NewLaunchToken()
	if err != nil {
		return err
	}
	frontend, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	config := harnessRuntimeConfig{
		DesktopRuntimeConfig: DesktopRuntimeConfig{BaseURL: runtime.BaseURL(), LaunchToken: runtime.LaunchToken(), UIBootstrapToken: runtime.UIBootstrapToken()},
		BridgeURL:            "http://" + listener.Addr().String(), BridgeToken: token, Version: buildinfo.Current().Version,
	}
	bridge := &desktopHarness{config: config}
	bridge.server = &http.Server{Handler: harnessHTTPHandler(config, runtime.Handler(), frontend), ReadHeaderTimeout: 10 * time.Second}
	control, err := listenHarnessControl(dataDir, config)
	if err != nil {
		_ = listener.Close()
		return err
	}
	bridge.control = control
	desktopHarnesses.Store(runtime, bridge)
	go func() { _ = bridge.server.Serve(listener) }()
	return nil
}

func closeDesktopRuntime(ctx context.Context, runtime *bootstrap.Runtime) error {
	var bridgeErr error
	if stored, ok := desktopHarnesses.LoadAndDelete(runtime); ok {
		bridge := stored.(*desktopHarness)
		bridgeErr = errors.Join(bridge.control.Close(), bridge.server.Close())
	}
	return errors.Join(bridgeErr, runtime.Close(ctx))
}

// harnessManagedPath reports routes DeepSeek Harness manages itself. Client
// credentials are issued only to the Host, never to the embedded page.
func harnessManagedPath(cleaned string, page bool) bool {
	under := func(prefix string) bool { return cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") }
	return under("/api/assistant") || under("/api/ops/clients") || page && under("/api/agent-clients")
}

func harnessHTTPHandler(config harnessRuntimeConfig, api http.Handler, frontend fs.FS) http.Handler {
	files := http.FileServer(http.FS(frontend))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented := r.Header.Get(harnessTokenHeader)
		if config.BridgeToken == "" || subtle.ConstantTimeCompare([]byte(presented), []byte(config.BridgeToken)) != 1 {
			http.Error(w, "harness authorization required", http.StatusForbidden)
			return
		}
		request := r.Clone(r.Context())
		cleaned := path.Clean("/" + strings.TrimPrefix(request.URL.Path, "/"))
		if cleaned == "/beeftv/app" || strings.HasPrefix(cleaned, "/beeftv/app/") {
			cleaned = strings.TrimPrefix(cleaned, "/beeftv/app")
		}
		if cleaned == "" {
			cleaned = "/"
		}
		if strings.HasPrefix(cleaned, "/resources/") {
			cleaned = "/api" + cleaned
		}
		// Routing reads only the cleaned path, so the checks below see exactly what the backend routes.
		request.URL.Path = cleaned
		request.URL.RawPath = ""
		if harnessManagedPath(cleaned, request.Header.Get(harnessPageHeader) != "") {
			http.Error(w, "managed by DeepSeek Harness", http.StatusForbidden)
			return
		}
		if cleaned == "/api" || strings.HasPrefix(cleaned, "/api/") {
			// The private bridge capability represents the same trusted local shell.
			backendURL, _ := url.Parse(config.BaseURL)
			request.Host = backendURL.Host
			request.Header.Set("Origin", "wails://wails")
			for _, header := range []string{harnessTokenHeader, harnessPageHeader, "X-Beeftv-Client", "X-Beeftv-Owner", "X-Beeftv-Agent-Turn", "X-Beeftv-Agent-Token"} {
				request.Header.Del(header)
			}
			request.Header.Set("X-Desktop-Token", config.LaunchToken)
			request.Header.Set("X-Beeftv-UI-Bootstrap", config.UIBootstrapToken)
			api.ServeHTTP(w, request)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(frontend, name); err != nil || info.IsDir() {
			if path.Ext(name) != "" || strings.HasPrefix(name, "__desktop/") {
				http.NotFound(w, request)
				return
			}
			request.URL.Path = "/"
		}
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, request)
	})
}
