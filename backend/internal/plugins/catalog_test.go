package plugins

import (
	"strings"
	"testing"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/protocol"
)

func TestProviderCatalogOverlaysOfficialRegistry(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	catalog := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false)
	var xai *ProviderCatalogItem
	var autoDL *ProviderCatalogItem
	for index := range catalog {
		switch catalog[index].ID {
		case "xai-video":
			xai = &catalog[index]
		case "autodl-comfyui":
			autoDL = &catalog[index]
		case "autodl-comfyui-plugin":
			t.Fatal("legacy AutoDL provider ID leaked into catalog")
		}
	}
	if xai == nil || xai.Create != "POST /v1/videos/generations" || strings.Contains(xai.Create, "__host__") {
		t.Fatalf("xAI catalog = %#v", xai)
	}
	if autoDL == nil || len(autoDL.Workflows) == 0 || autoDL.Enabled != true {
		t.Fatalf("AutoDL catalog = %#v", autoDL)
	}
}

func TestProviderCatalogHidesDisabledPlugins(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	if _, err := svc.SetEnabled("xai-video", false); err != nil {
		t.Fatal(err)
	}
	hidden := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false)
	for _, item := range hidden {
		if item.ID == "xai-video" {
			t.Fatalf("disabled plugin remained in catalog: %#v", item)
		}
	}
	visible := svc.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), true)
	found := false
	for _, item := range visible {
		if item.ID == "xai-video" {
			found = true
			if item.Enabled {
				t.Fatalf("disabled plugin reported enabled: %#v", item)
			}
		}
	}
	if !found {
		t.Fatal("includeUnavailable omitted disabled xAI plugin")
	}
}

func TestProviderCatalogUsesPerRuntimeRegistry(t *testing.T) {
	leftRuntime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rightRuntime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	left := New(leftRuntime, nil)
	right := New(rightRuntime, nil)
	if _, err := left.SetEnabled("xai-video", false); err != nil {
		t.Fatal(err)
	}
	if item := findProvider(left.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false), "xai-video"); item != nil {
		t.Fatalf("left runtime still exposed disabled plugin: %#v", item)
	}
	if item := findProvider(right.ProviderCatalog(string(protocol.SurfaceAdminSystemChannel), string(protocol.CapabilityVideo), false), "xai-video"); item == nil || !item.Enabled {
		t.Fatalf("right runtime lost independent xAI catalog: %#v", item)
	}
}

func TestForUserHidesSystemPluginsWhenFeatureDisabled(t *testing.T) {
	svc := New(RuntimeForTest(map[string]Record{
		"bundled":  {Source: "bundled", Metadata: protocol.Metadata{ID: "bundled", Name: "系统协议", Version: "1"}},
		"uploaded": {Source: OriginUploaded, Metadata: protocol.Metadata{ID: "uploaded", Name: "自定义协议", Version: "1"}},
		"app":      {Source: "bundled", Metadata: protocol.Metadata{ID: AIArtCritique, Name: "官方应用", Version: "1"}},
	}), nil)
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	visible := svc.ForUser(user, false)
	if len(visible) != 1 || visible[0].Manifest.ID != AIArtCritique {
		t.Fatalf("ForUser(user, hidden) = %#v", visible)
	}
	admin := svc.ForUser(&model.User{ID: "admin-1", Role: model.UserRoleAdmin}, false)
	if len(admin) != 3 {
		t.Fatalf("ForUser(admin) = %#v", admin)
	}
	all := svc.ForUser(user, true)
	if len(all) != 3 {
		t.Fatalf("ForUser(user, visible) = %#v", all)
	}
}

func TestProviderCatalogCustomPluginUsesManifestUntilRegistryOverlay(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	plugin, err := svc.Install(testPluginPackage(t, testManifest("catalog-custom-video", "1.0.0")), "catalog-custom-video.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled {
		t.Fatalf("custom plugin status = %#v", plugin)
	}
	catalog := svc.ProviderCatalog(string(protocol.SurfaceCanvas), string(protocol.CapabilityVideo), false)
	item := findProvider(catalog, "catalog-custom-video")
	if item == nil || item.Create != "POST /tasks" || !item.Enabled {
		t.Fatalf("custom catalog = %#v", item)
	}
	if adapter, ok := svc.Registry().Resolve("catalog-custom-video"); !ok {
		t.Fatal("custom plugin missing from runtime registry")
	} else if metadata := adapter.Metadata(); item.Create != metadata.Create {
		t.Fatalf("catalog create %q != registry %q", item.Create, metadata.Create)
	}
}

func TestProviderCatalogProjectsAuthType(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	raw := []byte(`{"apiVersion":"beeftv.plugin/v1","id":"catalog-auth-none","version":"1.0.0","name":"catalog-auth-none","author":"Test","documentation":"# catalog-auth-none","contributes":{"providers":[{"id":"catalog-auth-none","label":"catalog-auth-none","capabilities":["text"],"scopes":["canvas"],"auth":{"type":"none","field":"apiKey"},"create":{"method":"POST","path":"/api/chat","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`)
	if _, err := svc.Install(testPluginPackage(t, raw), "catalog-auth-none.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	item := findProvider(svc.ProviderCatalog(string(protocol.SurfaceCanvas), string(protocol.CapabilityText), false), "catalog-auth-none")
	if item == nil || item.AuthType != "none" {
		t.Fatalf("auth catalog = %#v", item)
	}
}

func findProvider(items []ProviderCatalogItem, id string) *ProviderCatalogItem {
	for index := range items {
		if items[index].ID == id {
			return &items[index]
		}
	}
	return nil
}

func TestOnlyShippedArchiveInterfacesAreMarkedBuiltIn(t *testing.T) {
	archive := ManagementFromView(View{Manifest: ManifestView{ID: "kling-video"}, Source: OriginOfficial})
	if !archive.BuiltInInterface {
		t.Fatalf("a shipped declarative archive is a built-in interface: %#v", archive)
	}
	uploaded := ManagementFromView(View{Manifest: ManifestView{ID: "my-interface"}, Source: OriginUploaded})
	if uploaded.BuiltInInterface {
		t.Fatal("an interface the user uploaded is their plugin, not a built-in one")
	}
	bundledApp := ManagementFromView(View{Manifest: ManifestView{ID: "beeftv-plugin-ll2", Client: "./client/index.js",
		Configuration: protocol.ManifestConfiguration{Fields: []protocol.ManifestField{{Name: "apiKey"}}},
		Contributes:   protocol.ManifestContributions{Providers: []protocol.ManifestProvider{{ID: "ll2-video"}}}},
		Source: OriginOfficial, PackageDir: "/app/plugin-packages/beeftv-plugin-ll2"})
	if bundledApp.BuiltInInterface {
		t.Fatal("a bundled app plugin with its own settings stays in the plugin center")
	}
}

func TestLookupWorkflowMatchesProviderCatalogContract(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, nil)
	raw := []byte(`{"apiVersion":"beeftv.plugin/v1","id":"wf-contract-plugin","version":"1.0.0","name":"wf-contract-plugin","author":"Test","documentation":"# wf","contributes":{"providers":[{"id":"wf-provider","legacyAliases":["wf-provider-legacy"],"label":"WF Provider","capabilities":["video"],"scopes":["user.custom-channel","canvas"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}],"workflows":[{"id":"exact_wf","label":"Exact","providerId":"wf-provider","capability":"video"},{"id":"orphan_wf","label":"Orphan","providerId":"","capability":"video"},{"id":"untyped_wf","label":"Untyped","providerId":"wf-provider","capability":""}]}}`)
	if _, err := svc.Install(testPluginPackage(t, raw), "wf-contract-plugin.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}

	if wf, ok := svc.LookupWorkflow("wf-provider", protocol.CapabilityVideo, "my-chan::exact_wf"); !ok || wf.ID != "exact_wf" {
		t.Fatalf("expected exact workflow match, got (%#v, %v)", wf, ok)
	}
	if wf, ok := svc.LookupWorkflow("wf-provider-legacy", protocol.CapabilityVideo, "exact_wf"); !ok || wf.ID != "exact_wf" {
		t.Fatalf("expected legacy alias workflow match, got (%#v, %v)", wf, ok)
	}
	if _, ok := svc.LookupWorkflow("wf-provider", protocol.CapabilityVideo, "EXACT_WF"); ok {
		t.Fatal("LookupWorkflow matched uppercase model ID that frontend catalog cannot select")
	}
	if _, ok := svc.LookupWorkflow("wf-provider", protocol.CapabilityVideo, "orphan_wf"); ok {
		t.Fatal("LookupWorkflow matched empty-providerId workflow that ProviderCatalog never exposes")
	}
	if _, ok := svc.LookupWorkflow("wf-provider", protocol.CapabilityVideo, "untyped_wf"); ok {
		t.Fatal("LookupWorkflow matched empty-capability workflow")
	}
	if _, ok := svc.LookupWorkflow("wf-provider", "", "exact_wf"); ok {
		t.Fatal("LookupWorkflow matched empty requested capability")
	}
	item := findProvider(svc.ProviderCatalog(string(protocol.SurfaceCanvas), string(protocol.CapabilityVideo), false), "wf-provider")
	if item == nil || len(item.Workflows) != 1 || item.Workflows[0].ID != "exact_wf" {
		t.Fatalf("ProviderCatalog workflows = %#v, want only exact_wf", item)
	}
}
