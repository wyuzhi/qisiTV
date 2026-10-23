// Command qisitv retains legacy schema inspection only. Build cmd/beeftv as
// qisitv for the native, independently authorized engine CLI and MCP server.
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
		_, err := fmt.Fprintln(out, `qisiTV legacy schema inspector

  qisitv tools                         List operations and JSON schemas
Legacy direct HTTP operations have been retired. Build ./cmd/beeftv as qisitv
and configure your Agent at https://cheeser.link/qisitv/#/agents.
This entry point never reads launch-token files or sends workspace requests.`)
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
	return errors.New("LEGACY_NATIVE_PROTOCOL_RETIRED: build ./cmd/beeftv as qisitv and configure an authorized client at https://cheeser.link/qisitv/#/agents")
}
