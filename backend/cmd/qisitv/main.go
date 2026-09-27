// Command qisitv shares the exact MCP operation/validation layer for terminal agents.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"qisitv/backend/internal/agentbridge"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": err.Error()})
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		_, err := fmt.Fprintln(out, `qisiTV local canvas CLI

  qisitv tools                         List operations and JSON schemas
  qisitv call TOOL '{"key":"value"}'     Call an operation
  qisitv call TOOL --file args.json     Read arguments from a JSON file
  qisitv call TOOL -                    Read arguments from stdin

Environment: QISITV_URL (default http://127.0.0.1:8080/api),
QISITV_TOKEN or QISITV_TOKEN_FILE (only when required by the local runtime).
The workspace must already be running. All output is JSON except this help.
task_submit requires explicit cost consent; no operation automatically retries.`)
		return err
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	if args[0] == "tools" && len(args) == 1 {
		return encoder.Encode(agentbridge.Tools())
	}
	if args[0] != "call" || len(args) < 2 || len(args) > 4 {
		return errors.New("usage: qisitv call TOOL [JSON | --file PATH | -]")
	}
	var raw []byte
	var err error
	if len(args) == 2 {
		raw = []byte("{}")
	} else if args[2] == "--file" && len(args) == 4 {
		raw, err = os.ReadFile(args[3])
	} else if args[2] == "-" && len(args) == 3 {
		raw, err = io.ReadAll(io.LimitReader(in, (5<<20)+1))
	} else if len(args) == 3 {
		raw = []byte(args[2])
	} else {
		return errors.New("invalid argument source")
	}
	if err != nil {
		return err
	}
	if len(raw) > 5<<20 {
		return errors.New("arguments exceed 5 MiB")
	}
	var values map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	if err = decoder.Decode(&values); err != nil {
		return fmt.Errorf("invalid JSON arguments: %w", err)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("only one JSON object is allowed")
	}
	client, err := agentbridge.FromEnvironment()
	if err != nil {
		return err
	}
	result, err := client.Call(ctx, args[1], values)
	if err != nil {
		return err
	}
	return encoder.Encode(result)
}
