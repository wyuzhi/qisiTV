package protocol

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func imageStreamAdapter() manifestAdapter {
	return manifestAdapter{manifest: Manifest{Response: ManifestResponse{
		DetectImageMIME: true,
		Stream:          &ManifestImageStream{TypePath: "type", ItemEvents: []string{"image"}, ErrorEvents: []string{"error"}, IndexPath: "index", Images: map[string]any{"$ref": "response.image"}, MessagePaths: []string{"message"}},
	}}}
}

func TestImageStreamPreservesValidItemsAndOrdering(t *testing.T) {
	for _, invalidIndex := range []string{`-1`, `0.5`, `"invalid"`, `null`} {
		t.Run(invalidIndex, func(t *testing.T) {
			body := fmt.Sprintf(`data: {"type":"image","index":%s,"image":{"url":"https://example.test/invalid"}}

data: {"type":"image","index":0,"image":{}}

data: {"type":"image","index":1,"image":{"url":"https://example.test/second"}}

data: {"type":"image","index":0,"image":{"dataUrl":"data:image/png;base64,aW52YWxpZA=="}}

data: {"type":"image","index":0,"image":{"url":"https://example.test/first"}}

data: {"type":"image","index":0,"image":{"url":"https://example.test/duplicate"}}

data: invalid JSON

data: {"type":"error","message":"one image failed"}

data: [DONE]

data: {"type":"image","index":2,"image":{"url":"https://example.test/after-done"}}

`, invalidIndex)
			got, err := imageStreamAdapter().ParseCreateResponse(context.Background(), []byte(body), "text/event-stream; charset=utf-8")
			if err != nil {
				t.Fatal(err)
			}
			if got.Result == nil || len(got.Result.Images) != 2 || got.Result.Images[0].URL != "https://example.test/first" || got.Result.Images[1].URL != "https://example.test/second" {
				t.Fatalf("images = %#v", got.Result)
			}
		})
	}
}

func TestImageStreamRequiresDeclarationAndValidResult(t *testing.T) {
	ctx := context.Background()
	if _, err := (manifestAdapter{}).ParseCreateResponse(ctx, []byte("data: {}\n\n"), "text/event-stream"); err == nil || !strings.Contains(err.Error(), "does not declare") {
		t.Fatalf("err = %v", err)
	}
	for _, body := range []string{
		"data: {\"type\":\"error\",\"message\":\"failed\"}\n\n",
		"data: {\"type\":\"image\",\"index\":-1,\"image\":{\"url\":\"https://example.test/invalid\"}}\n\n",
		"data: {\"type\":\"image\",\"index\":0,\"image\":{\"dataUrl\":\"data:image/png;base64,aW52YWxpZA==\"}}\n\n",
	} {
		if _, err := imageStreamAdapter().ParseCreateResponse(ctx, []byte(body), "text/event-stream"); err == nil {
			t.Fatalf("accepted %q", body)
		}
	}
}

func TestDeclaredImageStreamSurvivesWrongGatewayContentType(t *testing.T) {
	body := []byte("data: {\"type\":\"image\",\"index\":0,\"image\":{\"url\":\"https://example.test/first\"}}\n\ndata: [DONE]\n\n")
	result, err := imageStreamAdapter().ParseCreateResponse(context.Background(), body, "application/json")
	if err != nil || result.Result == nil || len(result.Result.Images) != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if _, err := (manifestAdapter{}).ParseCreateResponse(context.Background(), body, "application/json"); err == nil {
		t.Fatal("undeclared SSE body accepted")
	}
}

func TestProviderVariablesRemainRequestScopedAcrossReadOperations(t *testing.T) {
	op := &ManifestOperation{Method: "POST", Path: "/tasks/{{taskId}}", Body: map[string]any{"model": map[string]any{"$ref": "vars.selected"}}}
	adapter := manifestAdapter{manifest: Manifest{Variables: []ManifestVariable{{Name: "selected", Value: map[string]any{"$ref": "request.model"}}}, Poll: op, Cancel: op, ResultOperation: op}}
	for _, model := range []string{"first", "second"} {
		ctx := PollContext{Model: model, TaskID: "original"}
		for _, build := range []func(context.Context, PollContext) (RequestSpec, error){adapter.BuildPoll, adapter.BuildCancel, adapter.BuildResult} {
			spec, err := build(context.Background(), ctx)
			if err != nil || spec.Body.(map[string]any)["model"] != model {
				t.Fatalf("spec=%+v err=%v", spec, err)
			}
		}
	}
	if err := validateManifestVariables(adapter.manifest.Variables, map[string]any{"$ref": "vars.misspelled"}); err == nil {
		t.Fatal("undeclared request variable accepted")
	}
}

func TestProviderVariablesAreOrderedAndRequestScoped(t *testing.T) {
	bindings := []ManifestVariable{{Name: "prompt", Value: map[string]any{"$ref": "request.prompt"}}, {Name: "copy", Value: map[string]any{"$ref": "vars.prompt"}}}
	if err := validateManifestVariables(bindings); err != nil {
		t.Fatal(err)
	}
	for _, prompt := range []string{"first", "second"} {
		values, err := manifestRequestVariables(bindings, GenerationRequest{Prompt: prompt})
		if err != nil || values["copy"] != prompt {
			t.Fatalf("values = %#v, err = %v", values, err)
		}
	}
	for _, bad := range [][]ManifestVariable{
		{{Name: "same", Value: 1}, {Name: "same", Value: 2}},
		{{Name: "first", Value: map[string]any{"$ref": "vars.later"}}, {Name: "later", Value: 1}},
		{{Name: "self", Value: map[string]any{"$ref": "vars.self"}}},
		{{Name: "with.dot", Value: 1}},
	} {
		if err := validateManifestVariables(bad); err == nil {
			t.Fatalf("accepted %#v", bad)
		}
	}
}

func TestProviderExtensionsRequireNewHostContract(t *testing.T) {
	for _, version := range []string{"beeftv.plugin/v2", "beeftv.plugin/v3", "qisitv.plugin/v2", "qisitv.plugin/v3"} {
		body := []byte(fmt.Sprintf(`{"apiVersion":%q,"id":"stream-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"stream-fixture","label":"Fixture","capabilities":["image"],"scopes":["canvas"],"variables":[{"name":"promptCopy","value":{"$ref":"request.prompt"}}],"create":{"method":"POST","path":"/images/generations","defaultPathPrefix":"/api/v3","body":{"prompt":{"$ref":"vars.promptCopy"}}},"response":{"stream":{"typePath":"type","itemEvents":["done"],"images":{"$ref":"response.images"}},"detectImageMime":true}}]}}`, version))
		adapter, err := LoadManifest(body)
		if strings.HasSuffix(version, "/v2") {
			if err == nil {
				t.Fatal("new syntax was accepted as an old host contract")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, prompt := range []string{"first", "second"} {
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Prompt: prompt}})
			if err != nil || spec.Body.(map[string]any)["prompt"] != prompt {
				t.Fatalf("spec=%+v err=%v", spec, err)
			}
		}
	}
}
