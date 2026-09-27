// Command mcp exposes the running qisiTV workspace over MCP stdio.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"qisitv/backend/internal/agentbridge"
)

func main() {
	log.SetOutput(os.Stderr)
	client, err := agentbridge.FromEnvironment()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err = agentbridge.NewMCPServer(client).Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
