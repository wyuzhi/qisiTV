package operations_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"qisitv/backend/internal/operations"
)

func batchConfigureParams(canvasID string, revision int64, nodes ...map[string]any) map[string]any {
	return map[string]any{"canvasId": canvasID, "expectedRevision": revision, "nodes": nodes}
}

func configureNode(nodeID, kind, prompt string) map[string]any {
	return map[string]any{"nodeId": nodeID, "kind": kind, "patch": map[string]any{"prompt": prompt}}
}

func TestCanvasNodesConfigureWritesBatchInOneRevision(t *testing.T) {
	h := newHarness(t)
	h.addNode(t, "n3", "image", "镜头3", map[string]any{"prompt": "原始3"})
	before := h.revisionNow(t)
	caller := operations.ExternalCaller(false)

	result, err := h.execute(t, caller, "canvas.nodes.configure", "batch-configure-1",
		batchConfigureParams(h.canvasID, before, configureNode("n1", "image", "批量一"), configureNode("n3", "image", "批量三")))
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != before+1 {
		t.Fatalf("整批只应增加一次版本: got %d want %d", result.Revision, before+1)
	}
	payload, _ := result.Result.(map[string]any)
	nodes, _ := payload["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("应返回两个节点结果: %#v", payload)
	}
	first, _ := nodes[0].(map[string]any)
	if first["nodeId"] != "n1" || first["draftConfigured"] != true {
		t.Fatalf("节点结果缺少身份或确认字段: %#v", first)
	}
	meta, _ := first["node"].(map[string]any)["metadata"].(map[string]any)
	if meta["composerContent"] != "批量一" {
		t.Fatalf("批量配置未写入草稿: %#v", meta)
	}
	if h.nodeMetaString(t, "n3", "composerContent") != "批量三" {
		t.Fatal("第二个节点没有写入")
	}
	if h.revisionNow(t) != before+1 {
		t.Fatal("画布版本应只增加一次")
	}
}

func TestCanvasNodesConfigureAcceptsTwentyAndRejectsMore(t *testing.T) {
	h := newHarness(t)
	for index := 3; index <= 20; index++ {
		h.addNode(t, fmt.Sprintf("n%d", index), "image", fmt.Sprintf("镜头%d", index), map[string]any{"prompt": "原始"})
	}
	revision := h.revisionNow(t)
	caller := operations.ExternalCaller(false)

	nodes := make([]map[string]any, 0, 20)
	for index := 1; index <= 20; index++ {
		nodes = append(nodes, configureNode(fmt.Sprintf("n%d", index), "image", fmt.Sprintf("批量%d", index)))
	}
	if _, err := h.execute(t, caller, "canvas.nodes.configure", "batch-20", batchConfigureParams(h.canvasID, revision, nodes...)); err != nil {
		t.Fatalf("20 个节点应受理: %v", err)
	}
	if got := h.revisionNow(t); got != revision+1 {
		t.Fatalf("20 个节点应只增加一次版本: got %d want %d", got, revision+1)
	}

	nodes = append(nodes, configureNode("n1", "image", "超出上限"))
	_, err := h.execute(t, caller, "canvas.nodes.configure", "batch-21", batchConfigureParams(h.canvasID, revision+1, nodes...))
	if got := opErr(t, err); got.Reason != "invalid_batch" {
		t.Fatalf("21 个节点应整批拒绝: %#v", got)
	}
	if got := h.revisionNow(t); got != revision+1 {
		t.Fatal("被拒绝的批次不能推进版本")
	}
}

func TestCanvasNodesConfigureRejectsDuplicateNodeID(t *testing.T) {
	h := newHarness(t)
	revision := h.revisionNow(t)
	_, err := h.execute(t, operations.ExternalCaller(false), "canvas.nodes.configure", "batch-duplicate",
		batchConfigureParams(h.canvasID, revision, configureNode("n1", "image", "第一次"), configureNode("n1", "image", "第二次")))
	got := opErr(t, err)
	if got.Reason != "duplicate_node_id" {
		t.Fatalf("重复 nodeId 应拒绝: %#v", got)
	}
	if got.Details["index"] != 2 || got.Details["nodeId"] != "n1" {
		t.Fatalf("错误应写明第几个和哪个节点: %#v", got.Details)
	}
	if !strings.Contains(got.Message, "第 2 个节点（n1）") {
		t.Fatalf("错误文案应可定位: %q", got.Message)
	}
	if h.revisionNow(t) != revision {
		t.Fatal("重复 nodeId 不能写画布")
	}
}

func TestCanvasNodesConfigureRejectsWholeBatchWhenMiddleNodeInvalid(t *testing.T) {
	h := newHarness(t)
	before := h.revisionNow(t)
	_, err := h.execute(t, operations.ExternalCaller(false), "canvas.nodes.configure", "batch-invalid-middle",
		batchConfigureParams(h.canvasID, before,
			configureNode("n1", "image", "会写入的草稿"),
			configureNode("n2", "video", "类型不匹配"),
			configureNode("n1", "image", "重复也不会执行")))
	got := opErr(t, err)
	if got.Reason != "duplicate_node_id" {
		t.Fatalf("重复检查应先于写入: %#v", got)
	}
	if h.revisionNow(t) != before || h.nodeMetaString(t, "n1", "composerContent") != "" {
		t.Fatal("整批拒绝时画布必须保持原样")
	}

	_, err = h.execute(t, operations.ExternalCaller(false), "canvas.nodes.configure", "batch-invalid-kind",
		batchConfigureParams(h.canvasID, before,
			configureNode("n1", "image", "会写入的草稿"),
			configureNode("n2", "video", "类型不匹配")))
	got = opErr(t, err)
	if got.Reason != "node_kind_mismatch" || got.Details["index"] != 2 || got.Details["nodeId"] != "n2" {
		t.Fatalf("中间节点不合法应定位到第 2 个: %#v", got)
	}
	if !strings.Contains(got.Message, "第 2 个节点（n2）") {
		t.Fatalf("错误文案应可定位: %q", got.Message)
	}
	if h.revisionNow(t) != before || h.nodeMetaString(t, "n1", "composerContent") != "" {
		t.Fatal("中间节点不合法时前面的节点也不能写入")
	}
}

func TestCanvasNodesConfigureRejectsStaleRevision(t *testing.T) {
	h := newHarness(t)
	stale := h.revisionNow(t)
	if _, err := h.execute(t, operations.ExternalCaller(false), "canvas.node.update", "advance-revision", map[string]any{
		"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": stale, "patch": map[string]any{"title": "先改一次"},
	}); err != nil {
		t.Fatal(err)
	}
	_, err := h.execute(t, operations.ExternalCaller(false), "canvas.nodes.configure", "batch-stale",
		batchConfigureParams(h.canvasID, stale, configureNode("n2", "image", "过期写入")))
	got := opErr(t, err)
	if got.Reason != "revision_conflict" || got.Details["currentRevision"] != stale+1 {
		t.Fatalf("过期版本应拒绝并给出当前版本: %#v", got)
	}
	if h.nodeMetaString(t, "n2", "composerContent") != "" {
		t.Fatal("过期版本不能写画布")
	}
}

func TestCanvasNodesConfigureReplayReturnsOriginalWithoutSecondWrite(t *testing.T) {
	h := newHarness(t)
	revision := h.revisionNow(t)
	caller := operations.ExternalCaller(false)
	params := batchConfigureParams(h.canvasID, revision, configureNode("n1", "image", "只写一次"), configureNode("n2", "image", "只写一次二"))

	first, err := h.execute(t, caller, "canvas.nodes.configure", "batch-replay", params)
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.execute(t, caller, "canvas.nodes.configure", "batch-replay", params)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Replayed || second.Revision != first.Revision {
		t.Fatalf("同一 operationId 应回放原结果: first=%+v second=%+v", first, second)
	}
	if got := h.revisionNow(t); got != revision+1 {
		t.Fatalf("回放不能重复写画布: got %d want %d", got, revision+1)
	}
	if got := h.receiptCount(t, "batch-replay"); got != 1 {
		t.Fatalf("同一 operationId 只应有一条回执: %d", got)
	}
}

func TestCanvasNodesGetReturnsRequestedNodesAndMissing(t *testing.T) {
	h := newHarness(t)
	result, err := h.execute(t, operations.ExternalCaller(true), "canvas.nodes.get", "", map[string]any{
		"canvasId": h.canvasID, "nodeIds": []string{"n2", "n2", "missing", "n1", "missing"},
	})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := result.Result.(map[string]any)
	if revision, _ := payload["revision"].(float64); int64(revision) != h.revisionNow(t) {
		t.Fatalf("返回版本应与画布一致: %#v", payload)
	}
	nodes, _ := payload["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("应返回两个节点: %#v", payload)
	}
	if nodes[0].(map[string]any)["id"] != "n2" || nodes[1].(map[string]any)["id"] != "n1" {
		t.Fatalf("应按请求顺序返回: %#v", nodes)
	}
	missing, _ := payload["missingNodeIds"].([]any)
	if len(missing) != 1 || missing[0] != "missing" {
		t.Fatalf("缺失节点应去重列出: %#v", missing)
	}

	if _, err := h.execute(t, operations.ExternalCaller(true), "canvas.nodes.get", "", map[string]any{"canvasId": h.canvasID, "nodeIds": []string{}}); err == nil {
		t.Fatal("空 nodeIds 应拒绝")
	}
	tooMany := make([]string, 51)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf("n%d", index)
	}
	if _, err := h.execute(t, operations.ExternalCaller(true), "canvas.nodes.get", "", map[string]any{"canvasId": h.canvasID, "nodeIds": tooMany}); opErr(t, err).Reason != "invalid_batch" {
		t.Fatal("超过 50 个 nodeId 应拒绝")
	}
}

func TestCanvasNodesBatchReadOnlyAndAssistantBoundaries(t *testing.T) {
	h := newHarness(t)
	revision := h.revisionNow(t)
	readOnly := operations.ExternalCaller(true)
	if _, err := h.execute(t, readOnly, "canvas.nodes.get", "", map[string]any{"canvasId": h.canvasID, "nodeIds": []string{"n1"}}); err != nil {
		t.Fatalf("只读客户端应能读取指定节点: %v", err)
	}
	_, err := h.execute(t, readOnly, "canvas.nodes.configure", "read-only-write",
		batchConfigureParams(h.canvasID, revision, configureNode("n1", "image", "只读不能写")))
	if got := opErr(t, err); got.Code != operations.CodeReadOnly {
		t.Fatalf("只读客户端不能批量写入: %#v", got)
	}

	for _, id := range []string{"canvas.nodes.configure", "canvas.nodes.get"} {
		for _, descriptor := range h.registry.List(h.assistant()) {
			if descriptor.ID == id {
				t.Fatalf("内置助手不应看到 %s", id)
			}
		}
	}
	_, err = h.execute(t, h.assistant(), "canvas.nodes.configure", "assistant-write",
		batchConfigureParams(h.canvasID, revision, configureNode("n1", "image", "助手不能写")))
	if got := opErr(t, err); got.Code != operations.CodePermissionDenied {
		t.Fatalf("内置助手不能调用批量写: %#v", got)
	}
	if h.revisionNow(t) != revision {
		t.Fatal("被拒绝的调用不能写画布")
	}
}

func TestCanvasNodesConfigureMatchesSingleNodeWrite(t *testing.T) {
	h := newHarness(t)
	caller := operations.ExternalCaller(false)
	first := h.revisionNow(t)
	if _, err := h.execute(t, caller, "canvas.node.configure", "single-parity", map[string]any{
		"canvasId": h.canvasID, "nodeId": "n1", "kind": "image", "expectedRevision": first,
		"patch": map[string]any{"prompt": "单节点草稿"},
	}); err != nil {
		t.Fatal(err)
	}
	afterSingle := h.revisionNow(t)
	if afterSingle != first+1 {
		t.Fatalf("单节点写入应只增加一次版本: %d -> %d", first, afterSingle)
	}
	batchResult, err := h.execute(t, caller, "canvas.nodes.configure", "batch-parity",
		batchConfigureParams(h.canvasID, afterSingle, configureNode("n2", "image", "批量草稿")))
	if err != nil {
		t.Fatal(err)
	}
	if batchResult.Revision != afterSingle+1 {
		t.Fatalf("批量写入应只增加一次版本: %d -> %d", afterSingle, batchResult.Revision)
	}
	if h.nodeMetaString(t, "n1", "composerContent") != "单节点草稿" || h.nodeMetaString(t, "n2", "composerContent") != "批量草稿" {
		t.Fatal("单节点与批量应写入相同的草稿字段")
	}
	if h.nodeMetaString(t, "n1", "prompt") != "原始" {
		t.Fatal("批量写入不应改动批次外节点")
	}

	store := operations.NewStore(h.service.Database())
	writes, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if len(writes) != 2 {
		t.Fatalf("单节点和批量应各记一次外部写入: %+v", writes)
	}
	for _, write := range writes {
		if len(write.UpdatedNodeIDs) != 1 {
			t.Fatalf("每次写入只应包含自己的节点: %+v", write)
		}
	}
}

func TestCanvasNodesConfigureUndoRestoresWholeBatch(t *testing.T) {
	h := newHarness(t)
	store := operations.NewStore(h.service.Database())
	caller := operations.ExternalCaller(false)
	caller.ClientID = "dsh-plugin"
	caller.ClientLabel = "DeepSeek Harness"
	before := h.revisionNow(t)
	result, err := h.execute(t, caller, "canvas.nodes.configure", "batch-undo",
		batchConfigureParams(h.canvasID, before, configureNode("n1", "image", "整批一"), configureNode("n2", "image", "整批二")))
	if err != nil {
		t.Fatal(err)
	}
	writes, err := store.ListExternalCanvasWrites(h.userID, h.canvasID)
	if err != nil {
		t.Fatal(err)
	}
	if len(writes) != 1 || len(writes[0].UpdatedNodeIDs) != 2 || writes[0].Op != "canvas.nodes.configure" {
		t.Fatalf("批量写应记为一次操作: %+v", writes)
	}

	undo, err := store.UndoExternalCanvasWrite(context.Background(), h.service, h.userID, h.canvasID, "batch-undo", "dsh-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if len(undo.RestoredNodeIDs) != 2 || undo.Revision <= result.Revision {
		t.Fatalf("撤销应整批恢复: %+v", undo)
	}
	if h.nodeMetaString(t, "n1", "composerContent") != "" || h.nodeMetaString(t, "n2", "composerContent") != "" {
		t.Fatal("撤销后两个节点都应恢复原状")
	}
}
