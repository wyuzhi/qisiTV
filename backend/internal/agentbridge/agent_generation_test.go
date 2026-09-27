package agentbridge_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"qisitv/backend/internal/agentbridge"
	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/workspace"
)

// No real model or credential is used: the complete app queue, protocol plugin,
// resource persistence and automatic canvas writeback talk only to this fixture.
func TestAgentGenerationThroughRealWorkspaceAndLikeAIFixture(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	const fakeSecret = "agentbridge-fixture-not-a-real-key"
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 96, 48))); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	creates, polls, uploads := map[string]int{}, map[string]int{}, 0
	var fake *httptest.Server
	fake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/task-api/") && r.Header.Get("X-API-Key") != fakeSecret {
			t.Error("provider did not receive configured fixture credential")
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/task-api/task/create_task":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			prompt, _ := body["prompt"].(string)
			mu.Lock()
			creates[prompt]++
			mu.Unlock()
			if prompt == "video-with-first-frame" || prompt == "video-no-references" {
				if prompt == "video-with-first-frame" && (body["first_image_url"] != "https://fixture-media.invalid/uploaded.png" || body["api_name"] != "doubao_seedance_2_5") {
					t.Errorf("frame/model mapping %#v", body)
				}
				if prompt == "video-no-references" && (body["first_image_url"] != nil || body["last_image_url"] != nil || body["image_urls"] != nil) {
					t.Errorf("explicit empty references were not respected: %#v", body)
				}
				kwargs, _ := body["kwargs"].(map[string]any)
				if kwargs["off_peak"] != true {
					t.Errorf("configured model defaultOptions lost: %#v", body)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"task_id": prompt, "status": "completed", "result": map[string]any{"videos": []string{fake.URL + "/output.mp4"}}}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"task_id": prompt}})
		case strings.HasPrefix(r.URL.Path, "/task-api/task/query_task/"):
			id := strings.TrimPrefix(r.URL.Path, "/task-api/task/query_task/")
			mu.Lock()
			polls[id]++
			mu.Unlock()
			if id == "expected-failure" {
				_, _ = io.WriteString(w, `{"code":200,"data":{"status":"failed","message":"fixture rejected the generation"}}`)
				return
			}
			if id == "cancel-me" {
				_, _ = io.WriteString(w, `{"code":200,"data":{"status":"running"}}`)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"status": "completed", "result": map[string]any{"images": []string{fake.URL + "/output.png"}}}})
		case r.URL.Path == "/task-api/files":
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			data, _ := io.ReadAll(file)
			file.Close()
			if !bytes.Equal(data, pngBytes.Bytes()) {
				t.Error("reference upload bytes changed")
			}
			mu.Lock()
			uploads++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"url": "https://fixture-media.invalid/uploaded.png"})
		case r.URL.Path == "/output.png":
			if r.Header.Get("X-API-Key") != "" {
				t.Error("credential leaked to result URL")
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes.Bytes())
		case r.URL.Path == "/output.mp4":
			if r.Header.Get("X-API-Key") != "" {
				t.Error("credential leaked to result URL")
			}
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 2, 0, 'i', 's', 'o', 'm', 'i', 's', 'o', '2'})
		default:
			t.Errorf("unexpected fixture request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()
	dataDir := t.TempDir()
	store, err := workspace.NewProviderConfig(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "fixture-likeai", "baseUrl": fake.URL + "/task-api", "apiKey": fakeSecret, "enabled": true, "models": []string{"fixture_image", "doubao_seedance_2_5"}, "modelProfiles": []any{map[string]any{"model": "fixture_image", "protocol": "likeai-image", "capability": "image"}, map[string]any{"model": "doubao_seedance_2_5", "protocol": "likeai-video", "capability": "video", "defaultOptions": map[string]any{"kwargs": map[string]any{"off_peak": true}}}}}}})
	if err = store.SaveLocalModelConfig(config); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
	defer cancel()
	runtime, err := bootstrap.Open(ctx, bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: dataDir, ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Start(); err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	client, err := agentbridge.New(runtime.BaseURL(), runtime.LaunchToken())
	if err != nil {
		t.Fatal(err)
	}
	call := func(tool string, args map[string]any) map[string]any {
		t.Helper()
		result, err := client.Call(ctx, tool, args)
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), fakeSecret) {
			t.Fatalf("%s leaked fixture secret", tool)
		}
		return result
	}
	waitUntil := func(label string, check func() bool) {
		t.Helper()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			if check() {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("timed out waiting for %s", label)
			case <-ticker.C:
			}
		}
	}
	call("canvas_create", map[string]any{"canvasId": "generation-canvas", "title": "No-browser integration"})
	call("canvas_create", map[string]any{"canvasId": "other-canvas", "title": "Scope guard"})
	if current := call("canvas_current", nil); current["interaction"] != nil {
		t.Fatal("test must run without a browser")
	}
	catalog := call("model_list", nil)
	if len(catalog["models"].([]any)) != 2 {
		t.Fatalf("unexpected model catalog %#v", catalog)
	}
	request := func(prompt, kind, model string) map[string]any {
		return map[string]any{"canvasId": "generation-canvas", "type": kind, "model": model, "channelId": "fixture-likeai", "prompt": prompt, "idempotencyKey": prompt, "consent": map[string]any{"approved": true, "scope": "Fixture-only test: one mock output, no real charge"}}
	}
	imageRequest := request("image-success", "image", "fixture_image")
	submission := call("task_submit", imageRequest)
	task := submission["task"].(map[string]any)
	taskID, nodeID := task["id"].(string), submission["nodeId"].(string)
	if _, exists := task["inputJson"]; exists {
		t.Fatal("task_submit exposed protected input")
	}
	again := call("task_submit", imageRequest)
	if again["task"].(map[string]any)["id"] != taskID {
		t.Fatal("idempotency key created a second task")
	}
	changed := request("image-success", "image", "fixture_image")
	changed["prompt"] = "changed-paid-request"
	if _, err = client.Call(ctx, "task_submit", changed); err == nil {
		t.Fatal("accepted changed request under same payment identity")
	}
	terminal := map[string]any{}
	waitUntil("image task completion", func() bool {
		terminal = call("task_get", map[string]any{"taskId": taskID})
		return terminal["status"] == "succeeded" || terminal["status"] == "failed"
	})
	if terminal["status"] != "succeeded" {
		t.Fatalf("image task failed %#v", terminal)
	}
	var canvasDoc map[string]any
	var imageMeta map[string]any
	waitUntil("automatic image writeback without browser", func() bool {
		canvasDoc = call("canvas_get", map[string]any{"canvasId": "generation-canvas"})["project"].(map[string]any)
		for _, raw := range canvasDoc["nodes"].([]any) {
			node := raw.(map[string]any)
			if node["id"] == nodeID {
				imageMeta = node["metadata"].(map[string]any)
				return imageMeta["taskStatus"] == "succeeded" && imageMeta["assetId"] != ""
			}
		}
		return false
	})
	before, _ := json.Marshal(canvasDoc)
	applied := call("task_apply_result", map[string]any{"canvasId": "generation-canvas", "taskId": taskID})
	if applied["alreadyApplied"] != true {
		t.Fatal("automatic completion not recorded")
	}
	after, _ := json.Marshal(call("canvas_get", map[string]any{"canvasId": "generation-canvas"})["project"])
	if !bytes.Equal(before, after) {
		t.Fatal("repeat apply mutated canvas or duplicated output")
	}
	for _, bad := range []map[string]any{{"canvasId": "other-canvas", "taskId": taskID}, {"canvasId": "generation-canvas", "taskId": taskID, "nodeId": "foreign-target"}} {
		if _, err = client.Call(ctx, "task_apply_result", bad); err == nil {
			t.Fatal("accepted cross-canvas or cross-node apply")
		}
	}
	resourceKey := imageMeta["storageKey"].(string)
	if !strings.HasPrefix(resourceKey, "resource:") {
		t.Fatal("output not persisted locally")
	}
	getLocal := func(path string) []byte {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, runtime.BaseURL()+path, nil)
		req.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("local GET %s status %d", path, res.StatusCode)
		}
		return data
	}
	if data := getLocal("/resources/" + strings.TrimPrefix(resourceKey, "resource:") + "/file"); !bytes.Equal(data, pngBytes.Bytes()) {
		t.Fatal("local resource bytes differ")
	}
	assetData := getLocal("/assets/" + imageMeta["assetId"].(string))
	if !bytes.Contains(assetData, []byte(resourceKey)) {
		t.Fatal("asset does not bind generated resource")
	}

	// Reuse a manually connected reference and its first-frame role, with no
	// referenceNodeIds in the generation request.
	call("canvas_add_node", map[string]any{"canvasId": "generation-canvas", "node": map[string]any{"id": "video-target", "type": "video", "title": "Video"}})
	call("canvas_set_reference", map[string]any{"canvasId": "generation-canvas", "sourceNodeId": nodeID, "targetNodeId": "video-target", "role": "first-frame"})
	videoRequest := request("video-with-first-frame", "video", "doubao_seedance_2_5")
	videoRequest["nodeId"] = "video-target"
	videoSubmission := call("task_submit", videoRequest)
	videoID := videoSubmission["task"].(map[string]any)["id"].(string)
	waitUntil("video generation", func() bool {
		terminal = call("task_get", map[string]any{"taskId": videoID})
		return terminal["status"] == "succeeded" || terminal["status"] == "failed"
	})
	if terminal["status"] != "succeeded" {
		t.Fatalf("video failed %#v", terminal)
	}
	waitUntil("video writeback", func() bool {
		doc := call("canvas_get", map[string]any{"canvasId": "generation-canvas"})["project"].(map[string]any)
		for _, raw := range doc["nodes"].([]any) {
			node := raw.(map[string]any)
			if node["id"] == "video-target" {
				meta := node["metadata"].(map[string]any)
				return meta["taskStatus"] == "succeeded" && meta["assetId"] != ""
			}
		}
		return false
	})
	call("canvas_add_node", map[string]any{"canvasId": "generation-canvas", "node": map[string]any{"id": "video-no-ref-target", "type": "video"}})
	call("canvas_set_reference", map[string]any{"canvasId": "generation-canvas", "sourceNodeId": nodeID, "targetNodeId": "video-no-ref-target", "role": "first-frame"})
	noReferences := request("video-no-references", "video", "doubao_seedance_2_5")
	noReferences["nodeId"] = "video-no-ref-target"
	noReferences["input"] = map[string]any{"referenceNodeIds": []any{}}
	noRefsTask := call("task_submit", noReferences)["task"].(map[string]any)["id"].(string)
	waitUntil("explicit no-reference video", func() bool {
		terminal = call("task_get", map[string]any{"taskId": noRefsTask})
		return terminal["status"] == "succeeded" || terminal["status"] == "failed"
	})
	if terminal["status"] != "succeeded" {
		t.Fatalf("no-reference video failed %#v", terminal)
	}

	failure := call("task_submit", request("expected-failure", "image", "fixture_image"))
	failureID := failure["task"].(map[string]any)["id"].(string)
	waitUntil("failed generation", func() bool {
		terminal = call("task_get", map[string]any{"taskId": failureID})
		return terminal["status"] == "failed"
	})
	if _, err = client.Call(ctx, "task_cancel", map[string]any{"taskId": failureID}); err == nil {
		t.Fatal("cancelling failed task reported success")
	}
	cancelling := call("task_submit", request("cancel-me", "image", "fixture_image"))
	cancelID := cancelling["task"].(map[string]any)["id"].(string)
	waitUntil("upstream submission before cancellation", func() bool { mu.Lock(); defer mu.Unlock(); return creates["cancel-me"] > 0 })
	call("task_cancel", map[string]any{"taskId": cancelID})
	waitUntil("cancelled task", func() bool { return call("task_get", map[string]any{"taskId": cancelID})["status"] == "cancelled" })
	mu.Lock()
	defer mu.Unlock()
	if creates["image-success"] != 1 || creates["video-with-first-frame"] != 1 || creates["video-no-references"] != 1 || creates["expected-failure"] != 1 || creates["cancel-me"] != 1 || polls["image-success"] == 0 || uploads != 1 {
		t.Fatalf("unexpected paid-create/upload count create=%v poll=%v uploads=%d", creates, polls, uploads)
	}
	t.Logf("verified %d fixture creates, image poll, reference upload, local Asset/Resource writeback, no-browser completion, idempotency, cancellation and scope rejection", len(creates))
}

func TestSetReferenceRejectsInvalidRolesAndReusesConnection(t *testing.T) {
	runtime, err := bootstrap.Open(context.Background(), bootstrap.Config{Profile: bootstrap.ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.Start(); err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	client, _ := agentbridge.New(runtime.BaseURL(), runtime.LaunchToken())
	ctx := context.Background()
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		result, err := client.Call(ctx, name, args)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	call("canvas_create", map[string]any{"canvasId": "references", "title": "Reference test"})
	for _, kind := range []string{"image", "video", "audio"} {
		call("canvas_add_node", map[string]any{"canvasId": "references", "node": map[string]any{"id": kind, "type": kind}})
	}
	request := map[string]any{"canvasId": "references", "sourceNodeId": "image", "targetNodeId": "video", "role": "first-frame"}
	call("canvas_set_reference", request)
	call("canvas_set_reference", map[string]any{"canvasId": "references", "sourceNodeId": "image", "targetNodeId": "video", "role": "reference"})
	doc := call("canvas_get", map[string]any{"canvasId": "references"})["project"].(map[string]any)
	if len(doc["connections"].([]any)) != 1 {
		t.Fatal("duplicated reference edge")
	}
	if _, err = client.Call(ctx, "canvas_set_reference", map[string]any{"canvasId": "references", "sourceNodeId": "audio", "targetNodeId": "video", "role": "first-frame"}); err == nil {
		t.Fatal("audio accepted as first frame")
	}
}
