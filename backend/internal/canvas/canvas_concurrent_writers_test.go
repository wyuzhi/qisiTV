package canvas

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

// 用户手动编辑、助手写入、生成结果回写三类写者共用同一份画布文档。
// 每个写者都走各自的真实入口（CommitUserCanvasDocument / CreateUserCanvasNodes /
// BindTaskOutputToExistingNode），冲突后重读重试，最终不得丢任何一处改动，
// 且 revision 每次成功写入恰好加 1。

type concurrentCanvasFixture struct {
	svc *Service
	id  string
}

func newConcurrentCanvasFixture(t *testing.T, id string) concurrentCanvasFixture {
	t.Helper()
	svc := newCanvasHistoryTestService(t)
	raw := fmt.Sprintf(`{"id":%q,"revision":0,"title":"并发画布","nodes":[{"id":"gen","type":"text","title":"生成中","metadata":{"taskId":"task-1","status":"loading"}}],"connections":[]}`, id)
	if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(raw)); err != nil {
		t.Fatal(err)
	}
	return concurrentCanvasFixture{svc: svc, id: id}
}

func (f concurrentCanvasFixture) read(t *testing.T) (map[string]any, int64) {
	t.Helper()
	doc, err := f.svc.loadCanvasDoc("owner", f.id)
	if err != nil {
		t.Fatal(err)
	}
	return doc, canvasRevisionValue(doc)
}

// userEdit 模拟前端手动编辑：基于读到的 revision 追加节点并整体提交 nodes。
// staleRevision > 0 时先用该旧 revision 提交一次，必须被拒绝，再重读重试。
func (f concurrentCanvasFixture) userEdit(t *testing.T, nodeID string, staleRevision int64) {
	t.Helper()
	overlayFor := func(doc map[string]any) json.RawMessage {
		nodes := append(canvasDocNodes(doc), map[string]any{"id": nodeID, "type": "text", "title": "手动"})
		overlay, _ := json.Marshal(map[string]any{"nodes": nodes})
		return overlay
	}
	if staleRevision > 0 {
		doc, _ := f.read(t)
		if _, _, err := f.svc.CommitUserCanvasDocument("owner", f.id, staleRevision, overlayFor(doc)); !isCanvasRevisionConflict(err) {
			t.Errorf("stale user commit err = %v, want revision conflict", err)
		}
	}
	for attempt := 0; attempt < 50; attempt++ {
		doc, rev := f.read(t)
		_, _, err := f.svc.CommitUserCanvasDocument("owner", f.id, rev, overlayFor(doc))
		if err == nil {
			return
		}
		if !isCanvasRevisionConflict(err) {
			t.Errorf("user commit: %v", err)
			return
		}
	}
	t.Errorf("user edit never committed")
}

func (f concurrentCanvasFixture) assistantWrite(t *testing.T, staleRevision int64) {
	t.Helper()
	draft := []NodeDraft{{Type: "text", Title: "助手节点", Prompt: "助手写入"}}
	if staleRevision > 0 {
		if _, _, err := f.svc.CreateUserCanvasNodes("owner", f.id, draft, staleRevision); !isCanvasRevisionConflict(err) {
			t.Errorf("stale assistant write err = %v, want revision conflict", err)
		}
	}
	for attempt := 0; attempt < 50; attempt++ {
		_, rev := f.read(t)
		_, _, err := f.svc.CreateUserCanvasNodes("owner", f.id, draft, rev)
		if err == nil {
			return
		}
		if !isCanvasRevisionConflict(err) {
			t.Errorf("assistant write: %v", err)
			return
		}
	}
	t.Errorf("assistant write never committed")
}

func (f concurrentCanvasFixture) bind(t *testing.T) {
	t.Helper()
	// 内部自带有限次重试；同时只有另外两个写者，最多冲突两次。
	if _, err := f.svc.BindTaskOutputToExistingNode("owner", TaskOutputBind{
		CanvasID: f.id, NodeID: "gen", TaskID: "task-1", EffectKey: "bind:task-1:gen:0",
		MediaType: "text", Content: "生成结果",
	}); err != nil {
		t.Errorf("bind: %v", err)
	}
}

func (f concurrentCanvasFixture) assertAllLanded(t *testing.T, startRevision int64) {
	t.Helper()
	doc, rev := f.read(t)
	if rev != startRevision+3 {
		t.Fatalf("revision = %d, want %d (each write advances exactly once)", rev, startRevision+3)
	}
	if got := nodeString(nodeMetadata(findCanvasNode(doc, "gen")), "content"); got != "生成结果" {
		t.Fatalf("generation result lost, content = %q", got)
	}
	if findCanvasNode(doc, "user-1") == nil {
		t.Fatalf("user edit lost: %v", doc["nodes"])
	}
	assistant := 0
	for _, raw := range canvasDocNodes(doc) {
		if n, _ := raw.(map[string]any); n != nil && n["title"] == "助手节点" {
			assistant++
		}
	}
	if assistant != 1 {
		t.Fatalf("assistant nodes = %d, want 1: %v", assistant, doc["nodes"])
	}
	if len(canvasDocNodes(doc)) != 3 {
		t.Fatalf("nodes = %d, want 3: %v", len(canvasDocNodes(doc)), doc["nodes"])
	}
}

func TestCanvasThreeWritersSequentialOrdersWithStaleRetries(t *testing.T) {
	orders := [][]string{
		{"user", "assistant", "bind"}, {"user", "bind", "assistant"},
		{"assistant", "user", "bind"}, {"assistant", "bind", "user"},
		{"bind", "user", "assistant"}, {"bind", "assistant", "user"},
	}
	for _, order := range orders {
		t.Run(fmt.Sprint(order), func(t *testing.T) {
			f := newConcurrentCanvasFixture(t, "canvas-seq")
			_, start := f.read(t)
			// 三个写者都先拿到起始 revision；后写者的第一次尝试必然是过期的。
			for i, who := range order {
				stale := int64(0)
				if i > 0 {
					stale = start
				}
				switch who {
				case "user":
					f.userEdit(t, "user-1", stale)
				case "assistant":
					f.assistantWrite(t, stale)
				case "bind":
					f.bind(t)
				}
			}
			f.assertAllLanded(t, start)
		})
	}
}

func TestCanvasThreeWritersConcurrent(t *testing.T) {
	for round := 0; round < 30; round++ {
		f := newConcurrentCanvasFixture(t, "canvas-par")
		_, start := f.read(t)
		var wg sync.WaitGroup
		gate := make(chan struct{})
		for _, run := range []func(){
			func() { f.userEdit(t, "user-1", 0) },
			func() { f.assistantWrite(t, 0) },
			func() { f.bind(t) },
		} {
			wg.Add(1)
			go func(run func()) {
				defer wg.Done()
				<-gate
				run()
			}(run)
		}
		close(gate)
		wg.Wait()
		if t.Failed() {
			t.Fatalf("round %d failed", round)
		}
		f.assertAllLanded(t, start)
	}
}
