package operations

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/canvas/capability"
)

type configureProbe struct {
	proposeProbe
	writes int
}

func (p *configureProbe) UpdateUserCanvasNodeFields(_ string, _ string, nodeID string, patch map[string]any, expected int64) (canvas.UserDataSummary, error) {
	var doc map[string]any
	json.Unmarshal(p.doc, &doc)
	node := findDocNode(doc, nodeID)
	descriptor, _ := capability.BuiltinRegistry().Resolve(node["type"].(string))
	if err := descriptor.ApplyPatch(node, patch); err != nil {
		return canvas.UserDataSummary{}, err
	}
	doc["revision"] = expected + 1
	p.doc, _ = json.Marshal(doc)
	p.writes++
	return canvas.UserDataSummary{Revision: expected + 1}, nil
}
func configureFixture(t *testing.T, kind string) *configureProbe {
	p := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": kind, "title": "keep",
		"metadata": map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"}}})}}
	return p
}
func TestConfigurePreservesExistingMediaAndValidatesModelSelection(t *testing.T) {
	for kind, patch := range map[string]map[string]any{
		"image": {"model": "chosen", "size": "16:9", "quality": "high", "count": 2, "transparentBackground": "false"},
		"video": {"model": "chosen", "size": "16:9", "seconds": "10", "vquality": "720p", "generateAudio": "true", "watermark": "false"},
		"audio": {"model": "chosen", "audioVoice": "narrator", "audioFormat": "wav", "audioSpeed": "1.25", "audioPitch": "-2", "audioVolume": "0", "audioInstructions": "warm"},
	} {
		t.Run(kind, func(t *testing.T) {
			p := configureFixture(t, kind)
			p.resolve = func(gotKind, selected string) (AssistantGenerationModel, error) {
				if gotKind != kind || selected != "chosen" {
					t.Fatal("wrong model lookup")
				}
				return AssistantGenerationModel{Display: "available", ModelKey: "channel::chosen"}, nil
			}
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": kind, "expectedRevision": 4, "patch": patch})
			result, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
			if err != nil {
				t.Fatal(err)
			}
			metadata := result.(map[string]any)["node"].(map[string]any)["metadata"].(map[string]any)
			for key, value := range map[string]any{"prompt": "submitted", "composerContent": "draft", "taskId": "existing", "status": "success", "custom": "keep"} {
				if metadata[key] != value {
					t.Fatalf("overwrote %s", key)
				}
			}
			if metadata["model"] != "channel::chosen" || p.writes != 1 {
				t.Fatal("model not canonical")
			}
		})
	}
	p := configureFixture(t, "image")
	raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"prompt": "next draft prompt"}})
	result, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
	if err != nil {
		t.Fatal(err)
	}
	metadata := result.(map[string]any)["node"].(map[string]any)["metadata"].(map[string]any)
	if metadata["composerContent"] != "next draft prompt" || metadata["prompt"] != "submitted" {
		t.Fatalf("configure prompt should update composerContent and preserve historical prompt: %#v", metadata)
	}
}
func TestConfigureRejectsForeignKindUnknownFieldsAndMalformedValues(t *testing.T) {
	for _, target := range []struct{ nodeID, kind string }{{"n", "audio"}, {"missing", "video"}} {
		p := configureFixture(t, "video")
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": target.nodeID, "kind": target.kind, "expectedRevision": 4, "patch": map[string]any{"model": "chosen"}})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil || p.writes != 0 {
			t.Fatal("missing or mismatched target accepted")
		}
	}
	for _, patch := range []map[string]any{{"taskId": "new"}, {"content": "overwrite"}, {"audioSpeed": "1"}, {"seconds": "NaN"}, {"seconds": "0"}, {"generateAudio": true}, {"watermark": "yes"}, {"model": nil}, {"quality": "wrongkind"}, {"count": 9}} {
		p := configureFixture(t, "video")
		before := append(json.RawMessage{}, p.doc...)
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "video", "expectedRevision": 4, "patch": patch})
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw); err == nil {
			t.Fatalf("accepted %+v", patch)
		}
		if p.writes != 0 || !reflect.DeepEqual(before, p.doc) {
			t.Fatal("invalid patch changed canvas")
		}
	}
	for _, choice := range []AssistantGenerationModel{{KindMismatch: true}, {}} {
		p := configureFixture(t, "image")
		p.resolve = func(string, string) (AssistantGenerationModel, error) { return choice, nil }
		if _, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, json.RawMessage(`{"canvasId":"c1","nodeId":"n","kind":"image","expectedRevision":4,"patch":{"model":"unavailable"}}`)); err == nil || p.writes != 0 {
			t.Fatal("unavailable or wrong-kind model accepted")
		}
	}
}

type prepareProbe struct {
	*configureProbe
	prepared bool
}

func (p *prepareProbe) PrepareUserCanvasStoryboard(_ string, _ string, _ string, _ canvas.StoryboardPreparation, expected int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) {
	p.prepared = true
	return canvas.UserDataSummary{Revision: expected + 1}, canvas.StoryboardPreparationResult{}, nil
}

// 火山官方的 size 规则按型号族区分档位，并用总像素与宽高比限制自定义尺寸。
// 预检在 configure、prepare（分镜准备）和 propose（整片制作）三个真实入口都要
// 用同一份规则，既不能误拦 4.0 的 1600x600，也不能放过 4.5 的 1500x1500 与 1K。
func TestSeedreamSizePrecheckCoversConfigurePrepareAndPropose(t *testing.T) {
	for _, item := range []struct {
		model, size string
		ok          bool
		// wantCopy 是画布上会原样显示的那句话，用来钉住用户能直接照做的说法。
		wantCopy string
	}{
		{"doubao-seedream-4-0-250828", "1600x600", true, ""},
		{"seedream-4-5-251128", "5504x3040", true, ""},
		{"doubao-seedream-5-0-pro-260628", "1.5K", true, ""},
		{"doubao-seedream-5-0-260128", "16:9", true, ""},
		{"seedream-4-5-251128", "1500x1500", false, "Seedream 4.5 的图片至少要 2560x1440（369 万像素），1500x1500 只有 225 万像素"},
		{"seedream-4-5-251128", "1K", false, "Seedream 4.5 没有 1K 档位，请改选 2K、4K，或直接填宽x高像素（例如 2560x1440）"},
		{"dola-seedream-5-0-pro-260628", "4K", false, "Seedream 5.0 Pro 没有 4K 档位，请改选 1K、1.5K、2K，或直接填宽x高像素（例如 1280x720）"},
		{"doubao-seedream-5-0-pro-260628", "4K", false, "Seedream 5.0 Pro 没有 4K 档位，请改选 1K、1.5K、2K，或直接填宽x高像素（例如 1280x720）"},
	} {
		modelKey := "beefapi::" + item.model
		resolve := func(string, string) (AssistantGenerationModel, error) {
			return AssistantGenerationModel{Display: item.model, ModelKey: modelKey, Revision: 1}, nil
		}
		expect := func(stage string, err error) {
			t.Helper()
			if item.ok {
				if err != nil {
					t.Fatalf("%s rejected %s for %s: %v", stage, item.size, item.model, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("%s accepted %s for %s", stage, item.size, item.model)
			}
			if reason := AsError(err).Reason; reason != "invalid_parameter" {
				t.Fatalf("%s reason for %s = %q, want invalid_parameter", stage, item.size, reason)
			}
			message := AsError(err).Message
			if !strings.Contains(message, "Seedream") || strings.Contains(message, "总像素") {
				t.Fatalf("%s message for %s = %q, want user-facing Seedream copy", stage, item.size, message)
			}
			if item.wantCopy != "" && !strings.Contains(message, item.wantCopy) {
				t.Fatalf("%s message for %s = %q, want %q", stage, item.size, message, item.wantCopy)
			}
		}

		configure := configureFixture(t, "image")
		configure.resolve = resolve
		raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"model": item.model, "size": item.size}})
		_, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: configure}, raw)
		expect("configure", err)

		// 只改 size 时 patch 里没有 model，用节点当前模型照样要校验。
		sizeOnly := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": "image", "title": "n", "metadata": map[string]any{"model": modelKey}}})}}
		sizeOnly.resolve = resolve
		raw, _ = json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": map[string]any{"size": item.size}})
		_, err = opCanvasNodeConfigure(&Context{UserID: "owner", Domain: sizeOnly}, raw)
		expect("configure size-only", err)

		prepare := &prepareProbe{configureProbe: configureFixture(t, "image")}
		prepare.resolve = resolve
		raw, _ = json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "expectedRevision": 4, "image": map[string]any{"model": item.model, "size": item.size}})
		_, err = opStoryboardPrepare(&Context{UserID: "owner", Domain: prepare}, raw)
		expect("prepare", err)
		if prepare.prepared != item.ok {
			t.Fatalf("prepare reached storyboard creation = %v for %s %s, want %v", prepare.prepared, item.model, item.size, item.ok)
		}

		propose := &proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": "image", "title": "n", "metadata": map[string]any{"model": modelKey, "prompt": "p", "size": item.size}}})}
		propose.resolve = resolve
		raw, _ = json.Marshal(map[string]any{"canvasId": "c1", "nodeIds": []string{"n"}, "kind": "image", "productionNodeIds": []string{"n"}})
		_, err = opCanvasGenerationPropose(&Context{UserID: "owner", Domain: propose}, raw)
		expect("propose", err)
	}
}

// 图层拆分和普通生图共用 size 字段，但官方规则不同。只改 size 时 patch 里没有
// seedreamMode，预检必须用节点现状判断这次是不是在拆图层，否则图层节点会放过官方
// 不支持的显式像素尺寸，普通生图的 auto 也说不清该按哪个场景解释。
func TestSeedreamSizePrecheckReadsNodeLayerModeWhenPatchOmitsIt(t *testing.T) {
	const modelKey = "beefapi::doubao-seedream-5-0-pro-260628"
	for _, item := range []struct {
		name      string
		nodeMode  string
		patch     map[string]any
		withModel bool
		ok        bool
		wantCopy  string
	}{
		{name: "图层节点只改尺寸为像素", nodeMode: "layers", patch: map[string]any{"size": "2048x2048"},
			wantCopy: "Seedream 5.0 Pro 的图层拆分不支持 2048x2048，请改选 1K、1.5K、2K 档位，或选「跟随原图」"},
		{name: "图层节点换模型并改像素", nodeMode: "layers", patch: map[string]any{"model": "doubao-seedream-5-0-pro-260628", "size": "2048x2048"}, withModel: true,
			wantCopy: "Seedream 5.0 Pro 的图层拆分不支持 2048x2048，请改选 1K、1.5K、2K 档位，或选「跟随原图」"},
		{name: "图层节点改跟随原图", nodeMode: "layers", patch: map[string]any{"size": "auto"}, ok: true},
		{name: "图层节点改档位", nodeMode: "layers", patch: map[string]any{"size": "1.5K"}, ok: true},
		{name: "普通生图节点用像素", nodeMode: "image", patch: map[string]any{"size": "2048x2048"}, ok: true},
		{name: "普通生图节点用 auto", nodeMode: "image", patch: map[string]any{"size": "auto"}, ok: true},
		{name: "普通生图节点像素过小", nodeMode: "image", patch: map[string]any{"size": "512x512"},
			wantCopy: "Seedream 5.0 Pro 的图片至少要 1280x720（92 万像素），512x512 只有 26 万像素"},
	} {
		t.Run(item.name, func(t *testing.T) {
			p := &configureProbe{proposeProbe: proposeProbe{doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": "image", "title": "n",
				"metadata": map[string]any{"model": modelKey, "seedreamMode": item.nodeMode, "size": "2K", "prompt": "p"}}})}}
			if item.withModel {
				p.resolve = func(string, string) (AssistantGenerationModel, error) {
					return AssistantGenerationModel{Display: "doubao-seedream-5-0-pro-260628", ModelKey: modelKey, Revision: 1}, nil
				}
			}
			raw, _ := json.Marshal(map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "image", "expectedRevision": 4, "patch": item.patch})
			_, err := opCanvasNodeConfigure(&Context{UserID: "owner", Domain: p}, raw)
			if item.ok {
				if err != nil {
					t.Fatalf("rejected %+v: %v", item.patch, err)
				}
				if p.writes != 1 {
					t.Fatalf("writes=%d, want 1", p.writes)
				}
				return
			}
			if err == nil {
				t.Fatalf("accepted %+v", item.patch)
			}
			if reason := AsError(err).Reason; reason != "invalid_parameter" {
				t.Fatalf("reason=%q, want invalid_parameter", reason)
			}
			if message := AsError(err).Message; message != item.wantCopy {
				t.Fatalf("message=%q, want %q", message, item.wantCopy)
			}
			if p.writes != 0 {
				t.Fatalf("writes=%d, want 0", p.writes)
			}
		})
	}
}
