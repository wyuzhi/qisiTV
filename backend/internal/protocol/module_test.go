package protocol

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func moduleManifest(provider map[string]any) []byte {
	base := map[string]any{"id": "comfy", "label": "ComfyUI", "module": "./provider.mjs", "capabilities": []string{"image"}, "scopes": []string{"canvas"}}
	for key, value := range provider {
		base[key] = value
	}
	raw, _ := json.Marshal(map[string]any{"apiVersion": "beeftv.plugin/v2", "id": "beeftv-plugin-comfyui", "name": "ComfyUI", "version": "1.2.0", "contributes": map[string]any{"providers": []any{base}}})
	return raw
}

func TestModuleProviderLoadsAndBindsToPackageDir(t *testing.T) {
	adapters, err := LoadInstalledProviders(moduleManifest(nil))
	if err != nil {
		t.Fatal(err)
	}
	module, ok := adapters[0].(ModuleProvider)
	if !ok || module.Plugin != "beeftv-plugin-comfyui" || module.Info.ID != "comfy" || module.Info.Execution != ExecutionModule || module.Info.Version != "1.2.0" {
		t.Fatalf("adapter = %#v", adapters[0])
	}
	if _, err := module.BuildCreate(t.Context(), RequestContext{}); err == nil {
		t.Fatal("module provider built an HTTP request")
	}
	dir := t.TempDir()
	bound := BindModuleProviders(adapters, dir)[0].(ModuleProvider)
	if bound.Module != filepath.Join(dir, "provider.mjs") {
		t.Fatalf("module = %q", bound.Module)
	}
}

func TestModuleProviderFromArchiveIsUnavailable(t *testing.T) {
	adapters, err := LoadInstalledProviders(moduleManifest(nil))
	if err != nil {
		t.Fatal(err)
	}
	info := BindModuleProviders(adapters, "")[0].Metadata()
	if info.Enabled || !strings.Contains(info.UnavailableReason, "npm") {
		t.Fatalf("metadata = %#v", info)
	}
}

func TestModuleProviderValidation(t *testing.T) {
	for name, provider := range map[string]map[string]any{
		"outside package": {"module": "../provider.mjs"},
		"absolute":        {"module": "/tmp/provider.mjs"},
		"not javascript":  {"module": "./provider.ts"},
		"text":            {"capabilities": []string{"text"}},
		"with create":     {"create": map[string]any{"method": "POST", "path": "/prompt"}},
		"with poll":       {"poll": map[string]any{"method": "GET", "path": "/history"}},
	} {
		if _, err := LoadInstalledProviders(moduleManifest(provider)); err == nil {
			t.Errorf("%s: manifest was accepted", name)
		}
	}
}
