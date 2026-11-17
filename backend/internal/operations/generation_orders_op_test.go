package operations_test

import (
	"encoding/json"
	"testing"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/operations"
)

func seedGenerationOrder(t *testing.T, h *harness, proposalID, canvasID string, status operations.GenerationOrderStatus) {
	t.Helper()
	order := operations.GenerationOrder{
		OrderID:    proposalID,
		ProposalID: proposalID,
		CanvasID:   canvasID,
		Status:     status,
		Kind:       "image",
		NodeIDs:    []string{"n1"},
	}
	if err := operations.UpsertGenerationOrderInTx(h.service.Database(), h.userID, order); err != nil {
		t.Fatalf("seed generation order %s: %v", proposalID, err)
	}
}

func TestGenerationOrderListFiltersAndPaginates(t *testing.T) {
	h := newHarness(t)
	otherCanvas := "other-canvas"
	seedGenerationOrder(t, h, "order-pending-a", h.canvasID, operations.GenerationOrderPending)
	seedGenerationOrder(t, h, "order-submitted-a", h.canvasID, operations.GenerationOrderSubmitted)
	seedGenerationOrder(t, h, "order-pending-b", otherCanvas, operations.GenerationOrderPending)

	caller := operations.ExternalCaller(true)
	all, err := h.execute(t, caller, "canvas.generation.orders", "", map[string]any{})
	if err != nil {
		t.Fatalf("list generation orders: %v", err)
	}
	page := decodeGenerationOrderPage(t, all)
	if page.Total != 3 || len(page.Orders) != 3 || page.Page != 1 || page.PageSize != 20 {
		t.Fatalf("unexpected first page: %+v", page)
	}

	filtered, err := h.execute(t, caller, "canvas.generation.orders", "", map[string]any{
		"canvasId": h.canvasID,
		"status":   "pending",
	})
	if err != nil {
		t.Fatalf("filter generation orders: %v", err)
	}
	filteredPage := decodeGenerationOrderPage(t, filtered)
	if filteredPage.Total != 1 || len(filteredPage.Orders) != 1 || filteredPage.Orders[0].ProposalID != "order-pending-a" {
		t.Fatalf("unexpected filtered page: %+v", filteredPage)
	}

	first, err := h.execute(t, caller, "canvas.generation.orders", "", map[string]any{"page": 1, "pageSize": 1})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.execute(t, caller, "canvas.generation.orders", "", map[string]any{"page": 2, "pageSize": 1})
	if err != nil {
		t.Fatal(err)
	}
	firstPage := decodeGenerationOrderPage(t, first)
	secondPage := decodeGenerationOrderPage(t, second)
	if firstPage.Total != 3 || len(firstPage.Orders) != 1 || len(secondPage.Orders) != 1 {
		t.Fatalf("unexpected paging: first=%+v second=%+v", firstPage, secondPage)
	}
	if firstPage.Orders[0].ProposalID == secondPage.Orders[0].ProposalID {
		t.Fatalf("pages overlap: %s", firstPage.Orders[0].ProposalID)
	}
}

func TestGenerationOrderListRejectsUnknownStatus(t *testing.T) {
	h := newHarness(t)
	_, err := h.execute(t, operations.ExternalCaller(true), "canvas.generation.orders", "", map[string]any{"status": "bogus"})
	if got := opErr(t, err); got.Code != operations.CodeInvalidArgument || got.Reason != "invalid_status" {
		t.Fatalf("unknown status must be rejected, got %+v", got)
	}
}

func decodeGenerationOrderPage(t *testing.T, result operations.Result) operations.GenerationOrderPage {
	t.Helper()
	raw, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	var page operations.GenerationOrderPage
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestGenerationOrderListExcludesOtherUsers(t *testing.T) {
	h := newHarness(t)
	if err := operations.UpsertGenerationOrderInTx(h.service.Database(), "other-user", operations.GenerationOrder{
		OrderID: "other-order", ProposalID: "other-order", CanvasID: h.canvasID,
		Status: operations.GenerationOrderPending, Kind: "image", NodeIDs: []string{"n1"},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := h.execute(t, operations.ExternalCaller(true), "canvas.generation.orders", "", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	page := decodeGenerationOrderPage(t, result)
	if page.Total != 0 || len(page.Orders) != 0 {
		t.Fatalf("other user's orders must not be visible: %+v", page)
	}
}

func TestGenerationOrderPaginationIsStableForEqualTimestamps(t *testing.T) {
	h := newHarness(t)
	for _, id := range []string{"order-same-a", "order-same-b", "order-same-c"} {
		seedGenerationOrder(t, h, id, h.canvasID, operations.GenerationOrderPending)
	}
	sameTime := time.Now().UTC().Add(-time.Hour)
	if err := h.service.Database().Model(&model.AgentOpRecord{}).
		Where("op_id IN ?", []string{"generation-order:order-same-a", "generation-order:order-same-b", "generation-order:order-same-c"}).
		Update("created_at", sameTime).Error; err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for page := 1; page <= 3; page++ {
		result, err := h.execute(t, operations.ExternalCaller(true), "canvas.generation.orders", "", map[string]any{"page": page, "pageSize": 1})
		if err != nil {
			t.Fatal(err)
		}
		decoded := decodeGenerationOrderPage(t, result)
		if len(decoded.Orders) != 1 {
			t.Fatalf("page %d: %+v", page, decoded)
		}
		id := decoded.Orders[0].ProposalID
		if seen[id] {
			t.Fatalf("equal timestamps repeated %s across pages", id)
		}
		seen[id] = true
	}
	if len(seen) != 3 {
		t.Fatalf("expected 3 unique orders, got %v", seen)
	}
}
