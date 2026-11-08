package handler

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

func e2eModelConfig(baseURL string) []byte {
	config := map[string]any{
		"assistantModel":   "gen::" + textModelName(),
		"mediaReviewModel": "gen::wand-vega-vl-1.0-flash",
		"textModel":        "gen::" + textModelName(),
		"imageModel":       "gen::seedream-5-0-260128",
		"videoModel":       "gen::seedance-2.0-fast",
		"channels": []any{map[string]any{
			"id": "gen", "enabled": true, "apiFormat": "openai", "baseUrl": baseURL, "apiKey": "via-e2e-proxy",
			"models":       []string{textModelName(), "seedream-5-0-260128", "seedance-2.0-fast", "gemini-3.8-flash"},
			"modelAliases": map[string]string{"wand-vega-vl-1.0-flash": "gemini-3.8-flash"},
			"modelProfiles": []any{
				map[string]any{"model": textModelName(), "capability": "text", "protocol": "chat-completion"},
				map[string]any{"model": "seedream-5-0-260128", "capability": "image", "protocol": "openai-image"},
				map[string]any{"model": "seedance-2.0-fast", "capability": "video", "protocol": videoProtocol()},
				map[string]any{"model": "gemini-3.8-flash", "capability": "text", "protocol": "chat-completion"},
			},
		}},
	}
	encoded, _ := json.Marshal(config)
	return encoded
}

// 视频协议可切换，用来比较不同渠道协议下参数是否送达；默认与第一次真实运行一致。
func videoProtocol() string {
	if protocol := strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_VIDEO_PROTOCOL")); protocol != "" {
		return protocol
	}
	return "openai-videos"
}

func textModelName() string {
	if model := strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_MODEL")); model != "" {
		return model
	}
	return "deepseek-v4.1-flash"
}

func envInt(name string, fallback int) int {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			return value
		}
	}
	return fallback
}

func e2eValidateConfirmDelay(fake bool) error {
	if fake {
		return nil
	}
	if strings.TrimSpace(os.Getenv("BEEFTV_REAL_GEN_TEST_CONFIRM_DELAY_MS")) != "" {
		return fmt.Errorf("BEEFTV_REAL_GEN_TEST_CONFIRM_DELAY_MS 只在假模式生效，真实模式拒绝启动")
	}
	return nil
}

func redactSecret(value, secret string) string {
	if len(secret) < 8 {
		return value
	}
	return strings.ReplaceAll(value, secret, "[REDACTED]")
}

func buildE2EProtocolPackages(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, id := range []string{"openai-images", "openai-videos", "seedance-videos-compatible", "volcengine-ark-seedream"} {
		manifest, err := os.ReadFile(filepath.Join(root, "plugin-packages", id, "manifest.json"))
		if err != nil {
			t.Fatal(err)
		}
		var archive bytes.Buffer
		writer := zip.NewWriter(&archive)
		entry, err := writer.Create("manifest.json")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(manifest); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, id+".beeftv-plugin"), archive.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func generateFakeGenerationMedia(t *testing.T) ([]byte, []byte) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Fatalf("假生成模式需要 ffmpeg 生成合法 PNG/MP4: %v", err)
	}
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "frame.png")
	mp4Path := filepath.Join(dir, "clip.mp4")
	run := func(args ...string) {
		command := exec.Command("ffmpeg", args...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg %v: %v\n%s", args, err, output)
		}
	}
	run("-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=576x1024:d=1", "-frames:v", "1", pngPath)
	run("-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=576x1024:d=5:r=10", "-t", "5",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path)
	png, err := os.ReadFile(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	mp4, err := os.ReadFile(mp4Path)
	if err != nil {
		t.Fatal(err)
	}
	return png, mp4
}

// e2eConfirmationGate 把额度读取、方案校验、预留和真实确认放在同一把锁里，
// 防止并发确认各自读到旧额度后一起放行。
type e2eConfirmationGate struct {
	mu              sync.Mutex
	maxTasks        int
	maxVideoSeconds int
	used            int
	shutdown        bool
	delay           time.Duration
	locked          func()
	unlocked        func()
	scan            func() (int, error)
	approve         func(operations.GenerationOrder) (any, error)
}

func (g *e2eConfirmationGate) confirm(order operations.GenerationOrder) map[string]any {
	g.mu.Lock()
	if g.locked != nil {
		g.locked()
	}
	defer func() {
		if g.unlocked != nil {
			g.unlocked()
		}
	}()
	defer g.mu.Unlock()
	decision := map[string]any{"proposalId": order.ProposalID, "kind": order.Kind, "nodeIds": order.NodeIDs,
		"planNodeIds": e2ePlannedTaskIDs(order), "planTaskCount": len(e2ePlannedTaskIDs(order)),
		"approved": false, "taskIds": []string{}}
	if g.shutdown {
		decision["reason"] = "shutdown"
		return decision
	}
	if g.scan != nil {
		existing, err := g.scan()
		if err != nil {
			decision["reason"] = "quota_scan_failed: " + err.Error()
			return decision
		}
		if existing > g.used {
			g.used = existing
		}
	}
	if reason := e2eSkipGenerationOrder(order, g.used, g.maxTasks, g.maxVideoSeconds); reason != "" {
		decision["reason"] = reason
		return decision
	}
	// 测试钩子：在锁内延迟，模拟确认正在创建任务；/__shutdown 必须等它结束。
	if g.delay > 0 {
		time.Sleep(g.delay)
	}
	result, err := g.approve(order)
	if err != nil {
		decision["reason"] = "approve_failed: " + err.Error()
		return decision
	}
	decision["approved"] = true
	decision["result"] = result
	if encoded, encodeErr := json.Marshal(result); encodeErr == nil {
		var receipt struct {
			TaskIDs []string `json:"taskIds"`
		}
		if json.Unmarshal(encoded, &receipt) == nil && len(receipt.TaskIDs) > 0 {
			decision["taskIds"] = receipt.TaskIDs
		}
	}
	g.used += len(e2ePlannedTaskIDs(order))
	return decision
}

// beginShutdown 与 confirm 共用同一把锁：拿到锁时，之前所有确认（含任务创建）都已结束；
// 之后新的 confirm 一律返回 shutdown。
func (g *e2eConfirmationGate) beginShutdown() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.shutdown = true
}

func (g *e2eConfirmationGate) shuttingDown() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.shutdown
}

func (g *e2eConfirmationGate) currentUsed() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.used
}

func e2ePlannedTaskIDs(order operations.GenerationOrder) []string {
	ids := make([]string, 0, len(order.Targets))
	seen := map[string]bool{}
	for _, target := range order.Targets {
		id := strings.TrimSpace(target.NodeID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		for _, raw := range order.NodeIDs {
			id := strings.TrimSpace(raw)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

func e2eSkipGenerationOrder(order operations.GenerationOrder, used, maxTasks, maxVideoSeconds int) string {
	targets := order.Targets
	if len(targets) == 0 {
		for _, id := range order.NodeIDs {
			targets = append(targets, operations.GenerationTarget{NodeID: id, Kind: order.Kind})
		}
	}
	if len(targets) == 0 {
		return "proposal_targets_missing"
	}
	for _, target := range targets {
		if strings.TrimSpace(target.NodeID) == "" {
			return "proposal_target_missing"
		}
		switch target.Kind {
		case "image":
		case "video":
			raw := strings.TrimSpace(target.Parameters["seconds"])
			seconds, err := strconv.ParseFloat(raw, 64)
			if raw == "" || err != nil {
				return "video_seconds_unknown"
			}
			if seconds > float64(maxVideoSeconds) {
				return fmt.Sprintf("video_seconds_limit: %.1fs > %ds", seconds, maxVideoSeconds)
			}
		default:
			return "unsupported_generation_kind: " + target.Kind
		}
	}
	planned := e2ePlannedTaskIDs(order)
	if len(order.ProductionNodeIDs) > len(planned) {
		return "plan_targets_incomplete"
	}
	if len(planned) == 0 {
		return "proposal_nodes_missing"
	}
	if used+len(planned) > maxTasks {
		return fmt.Sprintf("task_limit: %d + %d > %d", used, len(planned), maxTasks)
	}
	return ""
}

func e2eUsedGenerationTasks(summaries []app.TaskSummary) int {
	used := 0
	for _, summary := range summaries {
		switch summary.Type {
		case "canvas_image", "canvas_video", "canvas_audio":
			used++
		}
	}
	return used
}

func registerE2EGenerationEndpoints(mux *http.ServeMux, env *assistantTestEnv, userID, canvasID string, maxTasks, maxVideoSeconds int) {
	writeJSON := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(value)
	}
	failCanvas := func(w http.ResponseWriter, requested string) bool {
		if strings.TrimSpace(requested) != canvasID {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("测试入口只接受注册时的测试画布"))
			return true
		}
		return false
	}
	var confirmInFlight atomic.Bool
	var confirmLocked atomic.Bool
	gate := &e2eConfirmationGate{
		maxTasks: maxTasks, maxVideoSeconds: maxVideoSeconds,
		delay:  time.Duration(envInt("BEEFTV_REAL_GEN_TEST_CONFIRM_DELAY_MS", 0)) * time.Millisecond,
		locked: func() { confirmLocked.Store(true) }, unlocked: func() { confirmLocked.Store(false) },
		scan: func() (int, error) {
			summaries, err := env.service.TasksWithOptions(userID, app.TaskListOptions{Limit: 200, ProjectID: canvasID})
			if err != nil {
				return 0, err
			}
			return e2eUsedGenerationTasks(summaries), nil
		},
		approve: func(order operations.GenerationOrder) (any, error) {
			return env.service.ApproveGenerationOrder(userID, order.ProposalID, "ui")
		},
	}

	mux.HandleFunc("/__begin", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ CanvasID, TurnID string }
		if json.NewDecoder(r.Body).Decode(&body) != nil || failCanvas(w, body.CanvasID) {
			return
		}
		revision, err := env.service.BeginAssistantTurn(userID, body.CanvasID, body.TurnID, app.AssistantTurnInput{})
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		writeJSON(w, map[string]any{"revision": revision})
	})

	// 对应界面点「确认方案」的真实服务方法；额度、类型和时长在这里兜底。
	mux.HandleFunc("/__confirm", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CanvasID string `json:"canvasId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || failCanvas(w, body.CanvasID) {
			return
		}
		if gate.shuttingDown() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("shutdown"))
			return
		}
		confirmInFlight.Store(true)
		defer confirmInFlight.Store(false)
		orders, err := env.service.ListGenerationOrders(userID, body.CanvasID)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		pending := make([]operations.GenerationOrder, 0, len(orders))
		for _, order := range orders {
			if order.Status == operations.GenerationOrderPending {
				pending = append(pending, order)
			}
		}
		decisions := make([]map[string]any, 0, len(pending))
		for _, order := range pending {
			decisions = append(decisions, gate.confirm(order))
		}
		writeJSON(w, map[string]any{"orders": pending, "decisions": decisions, "usedTasks": gate.currentUsed(),
			"maxTasks": maxTasks, "maxVideoSeconds": maxVideoSeconds})
	})

	// 只接受注册画布：停止新确认，并等当前确认（含任务创建）结束；返回后不会再创建新任务。
	mux.HandleFunc("/__shutdown", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CanvasID string `json:"canvasId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || failCanvas(w, body.CanvasID) {
			return
		}
		gate.beginShutdown()
		orders, err := env.service.ListGenerationOrders(userID, body.CanvasID)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		writeJSON(w, map[string]any{"shutdown": true, "orders": orders})
	})

	mux.HandleFunc("/__confirm-state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"inFlight": confirmInFlight.Load(), "locked": confirmLocked.Load()})
	})

	mux.HandleFunc("/__orders", func(w http.ResponseWriter, r *http.Request) {
		requested := r.URL.Query().Get("canvasId")
		if failCanvas(w, requested) {
			return
		}
		orders, err := env.service.ListGenerationOrders(userID, requested)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		pending := make([]operations.GenerationOrder, 0, len(orders))
		for _, order := range orders {
			if order.Status == operations.GenerationOrderPending {
				pending = append(pending, order)
			}
		}
		writeJSON(w, map[string]any{"orders": pending})
	})

	mux.HandleFunc("/__tasks", func(w http.ResponseWriter, r *http.Request) {
		requested := r.URL.Query().Get("canvasId")
		if failCanvas(w, requested) {
			return
		}
		summaries, err := env.service.TasksWithOptions(userID, app.TaskListOptions{Limit: 200, ProjectID: requested})
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		if raw := strings.TrimSpace(r.URL.Query().Get("ids")); raw != "" {
			wanted := map[string]bool{}
			for _, id := range strings.Split(raw, ",") {
				wanted[strings.TrimSpace(id)] = true
			}
			filtered := summaries[:0]
			for _, summary := range summaries {
				if wanted[summary.ID] {
					filtered = append(filtered, summary)
				}
			}
			summaries = filtered
		}
		writeJSON(w, map[string]any{"tasks": summaries})
	})

	mux.HandleFunc("/__canvas", func(w http.ResponseWriter, r *http.Request) {
		requested := r.URL.Query().Get("canvasId")
		if failCanvas(w, requested) {
			return
		}
		raw, err := env.service.UserCanvasProject(userID, requested)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	})

	mux.HandleFunc("/__artifact", func(w http.ResponseWriter, r *http.Request) {
		resource, reader, err := env.service.ResourceService().Open(userID, r.URL.Query().Get("id"))
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		defer reader.Close()
		if resource.MimeType != "" {
			w.Header().Set("Content-Type", resource.MimeType)
		}
		w.Header().Set("X-Beeftv-Resource-Id", resource.ID)
		w.Header().Set("X-Beeftv-Resource-Kind", resource.Kind)
		_, _ = io.Copy(w, reader)
	})

	mux.HandleFunc("/__cancel", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TaskID string `json:"taskId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.TaskID) == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// 测试用：模拟后端无法取消该任务，验证驱动会如实记录取消失败与仍可能运行的任务。
		if r.URL.Query().Get("fail") == "1" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("simulated cancel failure"))
			return
		}
		task, err := env.service.Task(userID, body.TaskID)
		if err != nil || task.ProjectID != canvasID {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("任务不存在或不属于测试画布"))
			return
		}
		canceled, err := env.service.CancelTask(r.Context(), userID, body.TaskID)
		if err != nil {
			writeJSON(w, map[string]any{"taskId": body.TaskID, "status": string(task.Status), "error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"taskId": canceled.ID, "status": string(canceled.Status)})
	})

	mux.HandleFunc("/__media-review", func(w http.ResponseWriter, r *http.Request) {
		body, err := env.service.ReadLocalModelConfig()
		if err != nil {
			writeJSON(w, map[string]any{"ok": false, "reason": "model_config_unreadable"})
			return
		}
		var snapshot modelcatalog.AssistantConfigSnapshot
		if json.Unmarshal(body, &snapshot) != nil {
			writeJSON(w, map[string]any{"ok": false, "reason": "model_config_invalid"})
			return
		}
		provider, reason := modelcatalog.ResolveMediaReviewProvider(snapshot, nil)
		writeJSON(w, map[string]any{"ok": reason == "", "model": provider.Model, "reason": reason})
	})
}

type e2eGenerationUpstream struct {
	fake          bool
	upstream      string
	key           string
	publicBase    string
	rewriteSource string
	png           []byte
	mp4           []byte
	videoSeq      atomic.Int64
	contentHits   atomic.Int64
	imageDelay    time.Duration
	client        *http.Client
}

func newE2EGenerationUpstream(fake bool, upstream, key string, png, mp4 []byte) *e2eGenerationUpstream {
	return &e2eGenerationUpstream{fake: fake, upstream: strings.TrimRight(upstream, "/"), key: key, png: png, mp4: mp4,
		client: &http.Client{Timeout: 10 * time.Minute, CheckRedirect: e2eUpstreamRedirectPolicy(upstream)}}
}

// e2eUpstreamRedirectPolicy 只在重定向目标的 scheme、hostname、port 与上游基址完全一致时
// 保留 Authorization；跳到子域名、其他域名、其他端口或协议时先删除再跟随。
func e2eUpstreamRedirectPolicy(base string) func(*http.Request, []*http.Request) error {
	baseURL, err := url.Parse(strings.TrimSpace(base))
	valid := err == nil && baseURL.Scheme != "" && baseURL.Hostname() != ""
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("stopped after 10 redirects")
		}
		if !valid || !sameE2EOrigin(req.URL, baseURL) {
			req.Header.Del("Authorization")
		}
		return nil
	}
}

func sameE2EOrigin(left, right *url.URL) bool {
	if left == nil || right == nil {
		return false
	}
	if !strings.EqualFold(left.Scheme, right.Scheme) || !strings.EqualFold(left.Hostname(), right.Hostname()) {
		return false
	}
	return e2eEffectivePort(left) == e2eEffectivePort(right)
}

func e2eEffectivePort(value *url.URL) string {
	if port := value.Port(); port != "" {
		return port
	}
	switch strings.ToLower(value.Scheme) {
	case "https":
		return "443"
	case "http":
		return "80"
	default:
		return ""
	}
}

func (p *e2eGenerationUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if p.fake {
		p.serveFake(w, r)
		return
	}
	p.forward(w, r)
}

func (p *e2eGenerationUpstream) forward(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/content") {
		p.contentHits.Add(1)
	}
	target := p.upstream + r.URL.Path
	if strings.HasSuffix(p.upstream, "/v1") && strings.HasPrefix(r.URL.Path, "/v1/") {
		target = p.upstream + strings.TrimPrefix(r.URL.Path, "/v1")
	}
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	request, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("bad upstream request"))
		return
	}
	for _, header := range []string{"Content-Type", "Accept"} {
		if value := r.Header.Get(header); value != "" {
			request.Header.Set(header, value)
		}
	}
	if p.key != "" {
		request.Header.Set("Authorization", "Bearer "+p.key)
	}
	response, err := p.client.Do(request)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream request failed"))
		return
	}
	defer response.Body.Close()
	contentType := response.Header.Get("Content-Type")
	generationJSON := (strings.HasPrefix(r.URL.Path, "/v1/images/") || strings.HasPrefix(r.URL.Path, "/v1/videos")) &&
		strings.Contains(strings.ToLower(contentType), "application/json")
	if generationJSON {
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 64<<20))
		if readErr != nil {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("upstream response unreadable"))
			return
		}
		p.writeJSONBytes(w, response.StatusCode, contentType, rewriteUpstreamResponseURLs(body, p.rewriteSource, p.publicBase))
		return
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func (p *e2eGenerationUpstream) serveFake(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	switch {
	case r.Method == http.MethodPost && (r.URL.Path == "/v1/images/generations" || r.URL.Path == "/v1/images/edits"):
		if p.imageDelay > 0 {
			time.Sleep(p.imageDelay)
		}
		encoded := base64.StdEncoding.EncodeToString(p.png)
		p.writeJSON(w, http.StatusOK, map[string]any{"data": []any{map[string]any{"b64_json": encoded}}})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
		id := fmt.Sprintf("e2e-video-%d", p.videoSeq.Add(1))
		p.writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "queued"})
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/videos/"):
		rest := strings.TrimPrefix(r.URL.Path, "/v1/videos/")
		if strings.HasSuffix(rest, "/content") {
			p.contentHits.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(p.mp4)
			return
		}
		id := strings.TrimSuffix(rest, "/")
		// 故意返回指向上游基址的绝对地址；真正的 BeefTV 必须经本地代理下载，才能用上真实密钥。
		contentURL := strings.TrimRight(p.rewriteSource, "/") + "/v1/videos/" + id + "/content"
		p.writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "completed",
			"url": contentURL, "video_url": contentURL, "metadata": map[string]any{"url": contentURL}})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
		p.writeJSON(w, http.StatusOK, map[string]any{
			"id": "e2e-review", "object": "chat.completion", "model": "gemini-3.8-flash",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "检查完成：画面未见明显问题。"}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 120, "completion_tokens": 16},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("fake upstream route not found"))
	}
}

func (p *e2eGenerationUpstream) writeJSON(w http.ResponseWriter, status int, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	p.writeJSONBytes(w, status, "application/json", rewriteUpstreamResponseURLs(encoded, p.rewriteSource, p.publicBase))
}

func (p *e2eGenerationUpstream) writeJSONBytes(w http.ResponseWriter, status int, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// rewriteUpstreamResponseURLs 只把指向上游基址（scheme+host）的绝对地址改写成本地代理地址，
// CDN 签名地址等其他域名保持不变；代理转发这些下载请求时会重新注入真实密钥。
func rewriteUpstreamResponseURLs(body []byte, source, public string) []byte {
	sourceURL, err := url.Parse(strings.TrimSpace(source))
	if err != nil || sourceURL.Scheme == "" || sourceURL.Host == "" {
		return body
	}
	publicURL, err := url.Parse(strings.TrimSpace(public))
	if err != nil || publicURL.Scheme == "" || publicURL.Host == "" {
		return body
	}
	var value any
	if json.Unmarshal(body, &value) != nil {
		return body
	}
	rewritten := rewriteUpstreamValue(value, sourceURL.Scheme, sourceURL.Host, strings.TrimRight(publicURL.String(), "/"))
	encoded, err := json.Marshal(rewritten)
	if err != nil {
		return body
	}
	return encoded
}

func rewriteUpstreamValue(value any, scheme, host, public string) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = rewriteUpstreamValue(item, scheme, host, public)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = rewriteUpstreamValue(item, scheme, host, public)
		}
		return typed
	case string:
		lower := strings.ToLower(typed)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			return typed
		}
		parsed, err := url.Parse(typed)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return typed
		}
		if !strings.EqualFold(parsed.Scheme, scheme) || !strings.EqualFold(parsed.Host, host) {
			return typed
		}
		rewritten := public + parsed.EscapedPath()
		if parsed.RawQuery != "" {
			rewritten += "?" + parsed.RawQuery
		}
		return rewritten
	default:
		return value
	}
}
