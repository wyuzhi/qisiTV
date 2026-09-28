// qisitv-connect links MCP clients with a paired qisiTV website.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"qisitv/backend/internal/browserbridge"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "qisiTV:", err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) error {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "serve":
		return serve(ctx, args, false)
	case "managed-serve":
		return serve(ctx, args, true)
	case "mcp":
		return runMCP(ctx, args)
	case "version", "--version":
		fmt.Println("qisitv-connect", browserbridge.Version)
		return nil
	case "help", "--help", "-h":
		fmt.Println("qisitv-connect install-codex Register qisitv-web MCP in Codex (only when you run this command)\nqisitv-connect mcp          Run MCP stdio; the local bridge starts and stops automatically\nqisitv-connect pair-code    Issue a new one-use browser pairing code\nqisitv-connect status       Show connected browser projects\nqisitv-connect call NAME JSON  Call an Agent tool from the terminal\nqisitv-connect serve        Manually run the local bridge for debugging\nqisitv-connect version")
		return nil
	case "install-codex":
		path, err := os.Executable()
		if err != nil {
			return err
		}
		codex, err := codexExecutable()
		if err != nil {
			return err
		}
		cmd := exec.CommandContext(ctx, codex, "mcp", "add", "qisitv-web", "--", path, "mcp")
		cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("could not register Codex MCP; install the Codex CLI first: %w", err)
		}
		fmt.Println("Registered qisitv-web. Reload Codex tools or open a new chat, then ask: Use qisitv_pair to connect my qisiTV canvas. Codex starts the local service automatically; no separate terminal window is needed.")
		return nil
	}
	config, err := browserbridge.LoadConfig()
	if err != nil {
		return err
	}
	client := browserbridge.NewClient(config)
	switch command {
	case "pair-code":
		reply, err := client.Request(ctx, http.MethodPost, "/agent/pair-code", map[string]any{})
		if err != nil {
			return err
		}
		fmt.Printf("Browser pairing code: %s\nValid until: %s\n", reply["code"], reply["expiresAt"])
		return nil
	case "status":
		reply, err := client.Request(ctx, http.MethodGet, "/agent/sessions", nil)
		if err != nil {
			return err
		}
		return printJSON(reply)
	case "call":
		if len(args) != 2 {
			return errors.New("usage: qisitv-connect call NAME '{\"argument\":\"value\"}'")
		}
		var input map[string]any
		if err := json.Unmarshal([]byte(args[1]), &input); err != nil {
			return errors.New("arguments must be a JSON object")
		}
		reply, err := client.Call(ctx, args[0], input)
		if err != nil {
			return err
		}
		return printJSON(reply)
	default:
		return fmt.Errorf("unknown command %q; run qisitv-connect help", command)
	}
}

func codexExecutable() (string, error) {
	if path, err := exec.LookPath("codex"); err == nil {
		return path, nil
	}
	// Finder-launched terminals do not always inherit a package manager's PATH.
	home, _ := os.UserHomeDir()
	candidates := []string{filepath.Join(home, ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"}
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/Applications/Codex.app/Contents/Resources/codex")
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
			return path, nil
		}
	}
	return "", errors.New("Codex CLI was not found. Install it or add it to PATH, then run install-codex again")
}
func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
func serve(ctx context.Context, args []string, managed bool) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := flags.Int("port", browserbridge.DefaultPort, "Loopback port")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *port < 1 || *port > 65535 {
		return errors.New("invalid port")
	}
	address := "127.0.0.1:" + strconv.Itoa(*port)
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return fmt.Errorf("cannot listen on %s; another connector may already be running: %w", address, err)
	}
	defer listener.Close()
	config, err := browserbridge.SaveConfig("http://" + address)
	if err != nil {
		return err
	}
	bridge := browserbridge.NewServer(config.AgentToken, *port)
	var idle <-chan struct{}
	if managed {
		idle = bridge.ManageIdle(ctx, browserbridge.ManagedIdleGrace, browserbridge.ManagedLeaseTTL)
	} else {
		code, expiry := bridge.NewPairCode()
		fmt.Fprintf(os.Stderr, "qisiTV local bridge %s (manual debug mode)\nOpen https://cheeser.link/qisitv/#/local\nPairing code: %s\nValid until: %s (one use)\nKeep this debug window open. Normal Codex use starts this service automatically.\n", browserbridge.Version, code, expiry.Format(time.RFC3339))
	}
	server := &http.Server{Handler: bridge, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		select {
		case <-ctx.Done():
		case <-idle:
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err = server.Serve(listener); errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
