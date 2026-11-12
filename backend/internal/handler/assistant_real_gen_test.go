package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 真实宿主 + 真实 Go 业务层 + 可真实出图/出视频的生成链路。
//
// 默认跳过；BEEFTV_REAL_GEN=1 时用本测试内的本地假 OpenAI 图片/视频上游返回合法产物，
// 只验证「分镜 → 首帧图 → 检查 → 视频 → 剪成片 → 下载产物」整条流程。
// 设置 BEEFTV_REAL_GEN_URL / BEEFTV_REAL_GEN_KEY 后自动改为转发真实网关，费用自理。
// 上游密钥只从环境变量进入本进程内存，不写入配置、日志或报告。
func TestAssistantRealGenerationEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns the real agent host and local task worker")
	}
	if os.Getenv("BEEFTV_REAL_GEN") != "1" && strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_URL")) == "" {
		t.Skip("设置 BEEFTV_REAL_GEN=1 跑本地假生成；设置 BEEFTV_REAL_GEN_URL 跑真实生成")
	}
	harness := newE2EGenerationHarness(t, false)
	reportRaw := harness.runDriver(t, map[string]any{
		"messages":        harness.messages,
		"maxTasks":        harness.maxTasks,
		"maxVideoSeconds": harness.maxVideoSeconds,
	}, true)
	assertCompleteGenerationReport(t, reportRaw)
	if harness.fake && harness.upstream.contentHits.Load() < 2 {
		t.Fatalf("假上游返回的绝对 content 地址没有经代理下载: hits=%d", harness.upstream.contentHits.Load())
	}
}

type e2eGenerationHarness struct {
	env             *assistantTestEnv
	ownerID         string
	canvasID        string
	serverURL       string
	root            string
	out             string
	fake            bool
	upstreamURL     string
	upstreamKey     string
	upstream        *e2eGenerationUpstream
	provider        map[string]any
	maxTasks        int
	maxVideoSeconds int
	messages        []string
}

func newE2EGenerationHarness(t *testing.T, forceFake bool) *e2eGenerationHarness {
	t.Helper()
	upstreamURL := strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_URL"))
	upstreamKey := strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_KEY"))
	fake := forceFake || upstreamURL == ""
	if forceFake {
		upstreamURL = ""
	}
	if !fake && upstreamKey == "" {
		t.Fatal("设置 BEEFTV_REAL_GEN_URL 时必须同时通过 BEEFTV_REAL_GEN_KEY 提供密钥")
	}
	if err := e2eValidateConfirmDelay(fake); err != nil {
		t.Fatal(err)
	}

	// 生成任务走官方声明式插件；测试里从仓库内插件目录现场打包。
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", buildE2EProtocolPackages(t))
	env := newAssistantTestEnv(t, nil)
	// 任务 Worker 与 HTTP 写路径并发访问同一个 SQLite；按生产本地库的配置串行化连接并放宽忙等，
	// 避免组合运行多个 E2E 用例时出现瞬时 database is locked。
	if sqlDB, dbErr := env.service.Database().DB(); dbErr == nil {
		sqlDB.SetMaxOpenConns(1)
		sqlDB.SetMaxIdleConns(1)
		_ = env.service.Database().Exec("PRAGMA busy_timeout = 10000").Error
		_ = env.service.Database().Exec("PRAGMA journal_mode = WAL").Error
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}

	var png, mp4 []byte
	if fake {
		png, mp4 = generateFakeGenerationMedia(t)
	}
	upstream := newE2EGenerationUpstream(fake, upstreamURL, upstreamKey, png, mp4)
	upstream.imageDelay = time.Duration(envInt("BEEFTV_REAL_GEN_TEST_IMAGE_DELAY_MS", 0)) * time.Millisecond
	upstreamServer := httptest.NewServer(upstream)
	t.Cleanup(upstreamServer.Close)
	upstream.publicBase = upstreamServer.URL
	if fake {
		upstream.rewriteSource = "https://fake-upstream.example"
	} else {
		upstream.rewriteSource = upstreamURL
	}
	if err := env.service.SaveLocalModelConfig(e2eModelConfig(upstreamServer.URL + "/v1")); err != nil {
		t.Fatal(err)
	}

	canvasID := "real-gen-canvas"
	canvas, _ := json.Marshal(map[string]any{"id": canvasID, "title": "真实生成测评", "revision": 0, "nodes": []any{}, "connections": []any{}})
	if _, err := env.service.UpsertUserCanvasProject(owner.ID, canvas); err != nil {
		t.Fatal(err)
	}

	env.service.StartWorker()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = env.service.StopWorker(ctx)
	})

	maxTasks := envInt("BEEFTV_REAL_GEN_MAX_TASKS", 6)
	maxVideoSeconds := envInt("BEEFTV_REAL_GEN_MAX_VIDEO_SECONDS", 5)
	mux := http.NewServeMux()
	mux.Handle("/", env.router)
	registerE2EGenerationEndpoints(mux, env, owner.ID, canvasID, maxTasks, maxVideoSeconds)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	out := os.Getenv("BEEFTV_REAL_GEN_OUT")
	if out == "" {
		out = t.TempDir()
	}
	provider := map[string]any{"fake": true}
	if !fake {
		provider = map[string]any{"baseUrl": upstreamURL, "model": textModelName(), "api": "openai-completions"}
	}
	return &e2eGenerationHarness{
		env: env, ownerID: owner.ID, canvasID: canvasID, serverURL: server.URL, root: root, out: out,
		fake: fake, upstreamURL: upstreamURL, upstreamKey: upstreamKey, upstream: upstream, provider: provider,
		maxTasks: maxTasks, maxVideoSeconds: maxVideoSeconds,
		messages: []string{
			"做一个两镜头的竖屏短片：清晨海边，一只柴犬追着浪花跑。先给我分镜和两张首帧图的方案。",
			"首帧图出来了，帮我检查一下画面有没有问题。没问题就给这两个镜头做视频方案，每个镜头 5 秒。",
			"把两个镜头剪成一个成片。",
		},
	}
}

func (h *e2eGenerationHarness) prepareDriver(t *testing.T, extra map[string]any) (*exec.Cmd, context.CancelFunc, string, *bytes.Buffer) {
	t.Helper()
	out := h.out
	if override, ok := extra["outDir"].(string); ok && override != "" {
		out = override
	}
	driverConfig := map[string]any{
		"root": h.root, "directory": t.TempDir(), "backend": h.serverURL + "/api",
		"beginUrl": h.serverURL + "/__begin", "confirmUrl": h.serverURL + "/__confirm",
		"tasksUrl": h.serverURL + "/__tasks", "canvasUrl": h.serverURL + "/__canvas",
		"artifactUrl": h.serverURL + "/__artifact", "mediaReviewUrl": h.serverURL + "/__media-review",
		"cancelUrl": h.serverURL + "/__cancel", "shutdownUrl": h.serverURL + "/__shutdown",
		"ordersUrl": h.serverURL + "/__orders",
		"hostToken": assistantTestHostToken, "provider": h.provider, "canvasId": h.canvasID,
		"messages": h.messages, "outDir": out, "maxRequests": 160,
		"maxTasks": h.maxTasks, "maxVideoSeconds": h.maxVideoSeconds,
		"turnTimeoutMs":  envInt("BEEFTV_REAL_GEN_TURN_TIMEOUT_MS", 600000),
		"imageTimeoutMs": envInt("BEEFTV_REAL_GEN_IMAGE_TIMEOUT_MS", 300000),
		"videoTimeoutMs": envInt("BEEFTV_REAL_GEN_VIDEO_TIMEOUT_MS", 900000),
		"pollIntervalMs": envInt("BEEFTV_REAL_GEN_POLL_INTERVAL_MS", 1000),
	}
	for key, value := range extra {
		driverConfig[key] = value
	}
	encoded, err := json.Marshal(driverConfig)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	var cancel context.CancelFunc
	if deadline, ok := t.Deadline(); ok {
		ctx, cancel = context.WithDeadline(ctx, deadline.Add(-40*time.Second))
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	command := exec.CommandContext(ctx, "node", filepath.Join(h.root, "agent-host/eval/real-gen-driver.mjs"), configPath)
	command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
	command.WaitDelay = 20 * time.Second
	var log bytes.Buffer
	command.Stdout = &log
	command.Stderr = &log
	return command, cancel, out, &log
}

func (h *e2eGenerationHarness) runDriver(t *testing.T, extra map[string]any, expectSuccess bool) []byte {
	t.Helper()
	command, cancel, out, log := h.prepareDriver(t, extra)
	defer cancel()
	runErr := command.Run()
	// 驱动自己会脱敏；测试侧再兜一层，避免失败信息把密钥带进终端。
	printable := redactSecret(log.String(), h.upstreamKey)
	if expectSuccess && runErr != nil {
		if raw, readErr := os.ReadFile(filepath.Join(out, "report.json")); readErr == nil {
			t.Fatalf("real generation driver failed: %v; 结果缺口: %s\n%s", runErr, generationReportGapSummary(raw), printable)
		}
		t.Fatalf("real generation driver failed: %v\n%s", runErr, printable)
	}
	if !expectSuccess && runErr == nil {
		t.Fatalf("driver 预期失败但成功退出:\n%s", printable)
	}
	t.Logf("results in %s\n%s", out, printable)

	reportRaw, err := os.ReadFile(filepath.Join(out, "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	if h.upstreamKey != "" && strings.Contains(string(reportRaw), h.upstreamKey) {
		t.Fatal("报告里出现了上游密钥，必须脱敏")
	}
	return reportRaw
}
