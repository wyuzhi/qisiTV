package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"qisitv/backend/internal/operations"
)

func TestE2EGenerationOrdersEndpointListsPendingProposals(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if err := operations.UpsertGenerationOrderInTx(env.service.Database(), owner.ID, operations.GenerationOrder{
		OrderID: "gp-orders-test", ProposalID: "gp-orders-test", CanvasID: "orders-canvas",
		Status: operations.GenerationOrderPending, Kind: "image", NodeIDs: []string{"n1"},
	}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerE2EGenerationEndpoints(mux, env, owner.ID, "orders-canvas", 6, 5)
	server := httptest.NewServer(mux)
	defer server.Close()
	response, err := http.Get(server.URL + "/__orders?canvasId=orders-canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var payload struct {
		Orders []operations.GenerationOrder `json:"orders"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Orders) != 1 || payload.Orders[0].ProposalID != "gp-orders-test" {
		t.Fatalf("待确认方案没有暴露给驱动: %+v", payload.Orders)
	}
}
