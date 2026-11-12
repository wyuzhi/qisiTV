package operations

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"qisitv/backend/internal/canvas/capability"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/pricing"
)

func TestConfigureAdvertisesExecutableMediaDraftFields(t *testing.T) {
	registry := &Registry{}
	registerCanvasNodeConfigureOps(registry)
	descriptor, _ := registry.Descriptor("canvas.node.configure")
	var schema jsonschema.Schema
	if err := json.Unmarshal(descriptor.Params, &schema); err != nil {
		t.Fatal(err)
	}
	patch := schema.Properties["patch"]
	for _, kind := range []string{"image", "video", "audio"} {
		media, _ := capability.BuiltinRegistry().Resolve(kind)
		for name := range media.PatchFields {
			if name == "title" || name == "content" {
				continue
			}
			if patch.Properties[name] == nil {
				t.Errorf("%s draft field %q is executable but missing from tool discovery", kind, name)
			}
		}
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "video", "expectedRevision": 4,
		"operationId": "configure-video", "patch": map[string]any{"size": "16:9", "vquality": "480p", "seconds": "5"}}
	if err := resolved.Validate(request); err != nil {
		t.Fatalf("advertised schema rejected supported video controls: %v", err)
	}
	request["patch"] = map[string]any{"unrecognizedControl": "480p"}
	if err := resolved.Validate(request); err == nil {
		t.Error("advertised schema accepted an unknown draft control")
	}
}

type configuredVideoQuoteProbe struct {
	*configureProbe
	catalog *modelcatalog.CatalogResponse
	order   GenerationOrder
}

func (p *configuredVideoQuoteProbe) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return p.catalog, nil
}

func (p *configuredVideoQuoteProbe) RecordGenerationOrder(_ string, order GenerationOrder) error {
	p.order = order
	return nil
}

func (p *configuredVideoQuoteProbe) LookupGenerationOrder(string, string) (*GenerationOrder, error) {
	return &p.order, nil
}

func TestConfiguredVideoProposalFreezesResolutionAndEstimate(t *testing.T) {
	const modelKey = "beefapi::video-fixture"
	p := &configuredVideoQuoteProbe{configureProbe: &configureProbe{proposeProbe: proposeProbe{
		doc: proposeCanvas(t, []map[string]any{{"id": "n", "type": "video", "title": "Video", "metadata": map[string]any{"composerContent": "A rotating film icon"}}}),
		resolve: func(string, string) (AssistantGenerationModel, error) {
			return AssistantGenerationModel{ModelKey: modelKey, Display: "Video fixture", Revision: 7}, nil
		},
	}}}
	catalog := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, []modelcatalog.PublicChannelCatalog{{ID: "beefapi", Models: []modelcatalog.PublicChannelModel{{
		ID: "video-fixture", ModelKey: "video-fixture", Capability: "video", Available: true,
		CapabilityConfig: map[string]any{"video": map[string]any{"defaultResolution": "768p", "duration": map[string]any{"selection": "range", "min": 1, "max": 15, "step": 1, "default": 5}}},
		VideoPricing: map[string]any{"currency": "CNY", "mode": "seconds", "rates": map[string]any{
			"480p": map[string]any{"output": 0.1525815, "reference_video": 0},
			"768p": map[string]any{"output": 0.2441304, "reference_video": 0},
		}},
	}}}})
	p.catalog = &catalog
	registry := &Registry{}
	registerCanvasNodeConfigureOps(registry)
	configure, _ := registry.Descriptor("canvas.node.configure")
	var schema jsonschema.Schema
	if err := json.Unmarshal(configure.Params, &schema); err != nil {
		t.Fatal(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"canvasId": "c1", "nodeId": "n", "kind": "video", "expectedRevision": 4, "operationId": "configure-video",
		"patch": map[string]any{"model": modelKey, "size": "16:9", "vquality": "480p", "seconds": "5"}}
	if err := resolved.Validate(request); err != nil {
		t.Fatal(err)
	}
	delete(request, "operationId")
	raw, _ := json.Marshal(request)
	ctx := &Context{UserID: "owner", Domain: p}
	if _, err := registry.ops["canvas.node.configure"].Handler(ctx, raw); err != nil {
		t.Fatal(err)
	}
	result, err := opCanvasGenerationPropose(ctx, json.RawMessage(`{"canvasId":"c1","nodeIds":["n"],"kind":"video"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	targets := payload["targets"].([]map[string]any)
	if len(targets) != 1 || len(p.order.Targets) != 1 {
		t.Fatalf("proposal targets were not recorded: view=%v order=%+v", targets, p.order)
	}
	parameters := targets[0]["parameters"].(map[string]string)
	for name, want := range map[string]string{"size": "16:9", "vquality": "480p", "seconds": "5"} {
		if parameters[name] != want || p.order.Targets[0].Parameters[name] != want {
			t.Fatalf("proposal did not freeze configured %s=%s: %v", name, want, parameters)
		}
	}
	estimate := payload["estimate"].(pricing.Summary)
	if estimate.Amount != 0.7629 || estimate.Unknown != 0 || estimate.Approx {
		t.Fatalf("proposal did not use the configured resolution: %+v", estimate)
	}
	if p.order.CanvasRevision != 5 {
		t.Fatalf("proposal froze revision %d, want 5", p.order.CanvasRevision)
	}
	if _, err := opCanvasNodeConfigure(ctx, json.RawMessage(`{"canvasId":"c1","nodeId":"n","kind":"video","expectedRevision":5,"patch":{"vquality":"768p"}}`)); err != nil {
		t.Fatal(err)
	}
	if p.order.Targets[0].Parameters["vquality"] != "480p" {
		t.Fatal("editing the draft changed the previously frozen generation order")
	}
}
