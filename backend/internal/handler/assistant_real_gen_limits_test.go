package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/operations"
)

func TestE2EGenerationRejectsConfirmDelayInRealMode(t *testing.T) {
	t.Setenv("BEEFTV_REAL_GEN_TEST_CONFIRM_DELAY_MS", "1")
	if err := e2eValidateConfirmDelay(false); err == nil {
		t.Fatal("真实模式不应接受测试延迟")
	}
	if err := e2eValidateConfirmDelay(true); err != nil {
		t.Fatalf("假模式应允许测试延迟: %v", err)
	}
	t.Setenv("BEEFTV_REAL_GEN_TEST_CONFIRM_DELAY_MS", "")
	if err := e2eValidateConfirmDelay(false); err != nil {
		t.Fatalf("未设置测试延迟时真实模式不应失败: %v", err)
	}
}

func TestE2EGenerationOrderLimits(t *testing.T) {
	videoTarget := func(id, seconds string) operations.GenerationTarget {
		return operations.GenerationTarget{NodeID: id, Kind: "video", Parameters: map[string]string{"seconds": seconds}}
	}
	video := func(seconds string, nodes int) operations.GenerationOrder {
		order := operations.GenerationOrder{Kind: "video"}
		for index := 0; index < nodes; index++ {
			id := "node-" + string(rune('a'+index))
			order.NodeIDs = append(order.NodeIDs, id)
			order.Targets = append(order.Targets, videoTarget(id, seconds))
		}
		return order
	}
	image := operations.GenerationOrder{Kind: "image", NodeIDs: []string{"image-1"},
		Targets: []operations.GenerationTarget{{NodeID: "image-1", Kind: "image"}}}
	cases := []struct {
		name  string
		order operations.GenerationOrder
		used  int
		max   int
		want  string
	}{
		{"image fits", image, 5, 6, ""},
		{"image exceeds cap", image, 6, 6, "task_limit"},
		{"video 5s fits", video("5", 2), 2, 6, ""},
		{"video longer than limit", video("6", 1), 0, 6, "video_seconds_limit"},
		{"video seconds missing", video("", 1), 0, 6, "video_seconds_unknown"},
		{"video exceeds cap", video("5", 2), 5, 6, "task_limit"},
		{"full plan counts not first batch", operations.GenerationOrder{Kind: "image", NodeIDs: []string{"img"},
			Targets: []operations.GenerationTarget{{NodeID: "img", Kind: "image"}, videoTarget("vid", "5")}}, 1, 2, "task_limit"},
		{"full plan checks later video seconds", operations.GenerationOrder{Kind: "image", NodeIDs: []string{"img"},
			Targets: []operations.GenerationTarget{{NodeID: "img", Kind: "image"}, videoTarget("vid", "10")}}, 0, 6, "video_seconds_limit"},
		{"audio rejected", operations.GenerationOrder{Kind: "audio", NodeIDs: []string{"audio-1"},
			Targets: []operations.GenerationTarget{{NodeID: "audio-1", Kind: "audio"}}}, 0, 6, "unsupported_generation_kind"},
		{"mixed audio rejected", operations.GenerationOrder{Kind: "image", NodeIDs: []string{"img"},
			Targets: []operations.GenerationTarget{{NodeID: "img", Kind: "image"}, {NodeID: "audio-1", Kind: "audio"}}}, 0, 6, "unsupported_generation_kind"},
		{"production plan missing targets", operations.GenerationOrder{Kind: "image", NodeIDs: []string{"img"},
			Targets: []operations.GenerationTarget{{NodeID: "img", Kind: "image"}}, ProductionNodeIDs: []string{"img", "vid"}}, 0, 6, "plan_targets_incomplete"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := e2eSkipGenerationOrder(tc.order, tc.used, tc.max, 5)
			if tc.want == "" && got != "" {
				t.Fatalf("expected allowed, got %q", got)
			}
			if tc.want != "" && !strings.HasPrefix(got, tc.want) {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestE2EGenerationUsedTasksCountsAudio(t *testing.T) {
	summaries := []app.TaskSummary{
		{Type: "canvas_image"}, {Type: "canvas_video"}, {Type: "canvas_audio"}, {Type: "timeline_render"},
	}
	if used := e2eUsedGenerationTasks(summaries); used != 3 {
		t.Fatalf("图片/视频/音频任务都应计入额度: %d", used)
	}
}

func TestE2EGenerationConfirmRejectsForeignCanvas(t *testing.T) {
	mux := http.NewServeMux()
	registerE2EGenerationEndpoints(mux, &assistantTestEnv{}, "user", "registered-canvas", 6, 5)
	server := httptest.NewServer(mux)
	defer server.Close()
	for _, endpoint := range []struct {
		path string
		body string
	}{
		{"/__confirm", `{"canvasId":"foreign-canvas"}`},
		{"/__begin", `{"canvasId":"foreign-canvas","turnId":"00000000000000aa"}`},
	} {
		response, err := http.Post(server.URL+endpoint.path, "application/json", strings.NewReader(endpoint.body))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s 接受了非测试画布: %d", endpoint.path, response.StatusCode)
		}
	}
	for _, path := range []string{"/__tasks?canvasId=foreign-canvas", "/__canvas?canvasId=foreign-canvas"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s 接受了非测试画布: %d", path, response.StatusCode)
		}
	}
}

func TestE2EGenerationConfirmationGateSerializesQuota(t *testing.T) {
	var mu sync.Mutex
	approvals := 0
	gate := &e2eConfirmationGate{
		maxTasks: 1, maxVideoSeconds: 5,
		scan: func() (int, error) { return 0, nil },
		approve: func(order operations.GenerationOrder) (any, error) {
			mu.Lock()
			approvals++
			mu.Unlock()
			time.Sleep(10 * time.Millisecond)
			return map[string]any{"taskIds": order.NodeIDs}, nil
		},
	}
	orders := []operations.GenerationOrder{
		{ProposalID: "p1", Kind: "image", NodeIDs: []string{"n1"}, Targets: []operations.GenerationTarget{{NodeID: "n1", Kind: "image"}}},
		{ProposalID: "p2", Kind: "image", NodeIDs: []string{"n2"}, Targets: []operations.GenerationTarget{{NodeID: "n2", Kind: "image"}}},
	}
	decisions := make([]map[string]any, len(orders))
	var wg sync.WaitGroup
	for index := range orders {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			decisions[index] = gate.confirm(orders[index])
		}(index)
	}
	wg.Wait()
	approved := 0
	for _, decision := range decisions {
		if decision["approved"] == true {
			approved++
		}
	}
	if approvals != 1 || approved != 1 {
		t.Fatalf("并发确认超过上限: approvals=%d approved=%d decisions=%s", approvals, approved, mustJSON(decisions))
	}
	if gate.currentUsed() != 1 {
		t.Fatalf("额度预留不对: %d", gate.currentUsed())
	}
}

func mustJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
