package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/protocol"
)

// runPlugin is the offline developer surface for interface plugins: it uses the
// same validator and request builder as the app, never sends a request and
// never needs a key.
func runPlugin(args []string) error {
	if len(args) == 0 {
		return &cliError{code: exitUsage, reason: "invalid_plugin_command", msg: pluginUsage}
	}
	switch args[0] {
	case "validate":
		return runPluginValidate(args[1:])
	case "try":
		return runPluginTry(args[1:])
	default:
		return &cliError{code: exitUsage, reason: "invalid_plugin_command", msg: pluginUsage}
	}
}

const pluginUsage = `用法：
  qisitv plugin validate <插件目录|manifest.json|.qisitv-plugin>
  qisitv plugin try <插件目录|manifest.json|.qisitv-plugin> --interface <接口 ID> [--model m] [--prompt p] [--base-url u] [--options '{"key":1}']`

func runPluginValidate(args []string) error {
	if len(args) != 1 {
		return &cliError{code: exitUsage, reason: "plugin_path_required", msg: pluginUsage}
	}
	manifest, adapters, err := loadPluginForDev(args[0])
	if err != nil {
		return err
	}
	type item struct {
		ID         string   `json:"id"`
		Label      string   `json:"label"`
		Kinds      []string `json:"capabilities"`
		Create     string   `json:"create,omitempty"`
		Poll       string   `json:"poll,omitempty"`
		OldIDs     []string `json:"legacyAliases,omitempty"`
		PresetsLen int      `json:"presets,omitempty"`
	}
	result := struct {
		OK         bool   `json:"ok"`
		ID         string `json:"id"`
		Version    string `json:"version"`
		Interfaces []item `json:"interfaces"`
	}{OK: true, ID: manifest.Metadata.ID, Version: manifest.Metadata.Version}
	for index, adapter := range adapters {
		metadata := adapter.Metadata()
		entry := item{ID: metadata.ID, Label: metadata.Name, Create: metadata.Create, Poll: metadata.Poll}
		for _, capability := range metadata.Categories {
			entry.Kinds = append(entry.Kinds, string(capability))
		}
		if index < len(manifest.Contributes.Providers) {
			provider := manifest.Contributes.Providers[index]
			entry.Label, entry.OldIDs, entry.PresetsLen = provider.Label, provider.LegacyAliases, len(provider.Presets)
		}
		result.Interfaces = append(result.Interfaces, entry)
	}
	return emitJSON(result)
}

func runPluginTry(args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return &cliError{code: exitUsage, reason: "plugin_path_required", msg: pluginUsage}
	}
	path := args[0]
	flags := flag.NewFlagSet("plugin try", flag.ContinueOnError)
	interfaceID := flags.String("interface", "", "接口 ID（manifest 里 providers[].id）")
	model := flags.String("model", "test-model", "模型 ID")
	prompt := flags.String("prompt", "一句话的测试内容", "提示词")
	baseURL := flags.String("base-url", "", "服务地址，留空用接口的默认地址")
	options := flags.String("options", "", "放进这个接口命名空间的 providerOptions，JSON 对象")
	if err := flags.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	if flags.NArg() != 0 {
		return &cliError{code: exitUsage, reason: "unexpected_argument", msg: pluginUsage}
	}
	manifest, adapters, err := loadPluginForDev(path)
	if err != nil {
		return err
	}
	var adapter protocol.Adapter
	var provider protocol.ManifestProvider
	for index, candidate := range adapters {
		if *interfaceID == "" && len(adapters) == 1 || candidate.Metadata().ID == strings.TrimSpace(*interfaceID) {
			adapter = candidate
			if index < len(manifest.Contributes.Providers) {
				provider = manifest.Contributes.Providers[index]
			}
			break
		}
	}
	if adapter == nil {
		return &cliError{code: exitBadRequest, reason: "plugin_interface_not_found", msg: "这个插件里没有该接口；有多个接口时用 --interface 指定"}
	}
	if strings.TrimSpace(provider.Module) != "" {
		return &cliError{code: exitBadRequest, reason: "plugin_module_interface", msg: "这个接口由插件 JS 实现，不能离线试跑；请装进 BeefTV 后用「生成测试」"}
	}
	capability := protocol.CapabilityText
	if categories := adapter.Metadata().Categories; len(categories) > 0 {
		capability = categories[0]
	}
	request := protocol.GenerationRequest{Capability: capability, Model: *model, Prompt: *prompt}
	if strings.TrimSpace(*options) != "" {
		var values map[string]any
		if err := json.Unmarshal([]byte(*options), &values); err != nil {
			return &cliError{code: exitBadRequest, reason: "plugin_options_invalid", msg: "--options 需要一个 JSON 对象"}
		}
		request.ProviderOptions = map[string]map[string]any{adapter.Metadata().ID: values}
	}
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{BaseURL: *baseURL, Request: request})
	if err != nil {
		return &cliError{code: exitBadRequest, reason: "plugin_request_invalid", msg: "构造请求失败：" + err.Error()}
	}
	base := strings.TrimSpace(*baseURL)
	if base == "" {
		base = provider.BaseURL
	}
	target := spec.Path
	if base != "" {
		if resolved, err := generation.ProtocolRequestURL(base, spec); err == nil {
			target = resolved
		}
	}
	return emitJSON(map[string]any{
		"interface":   adapter.Metadata().ID,
		"method":      spec.Method,
		"url":         target,
		"contentType": spec.ContentType,
		"headers":     spec.Headers,
		"query":       spec.Query,
		"body":        spec.Body,
		"auth":        describeDevAuth(spec.Auth, provider.Auth),
		"note":        "只构造请求，没有发出，也没有用到密钥。",
	})
}

// loadPluginForDev accepts a plugin folder (package.json with a beeftv field,
// or manifest.json), a bare manifest.json, or a packed .beeftv-plugin, and runs
// the same validation the app runs when installing it.
func loadPluginForDev(path string) (protocol.Manifest, []protocol.Adapter, error) {
	info, err := os.Stat(path)
	if err != nil {
		return protocol.Manifest{}, nil, &cliError{code: exitNotFound, reason: "plugin_path_unavailable", msg: "找不到这个路径：" + path}
	}
	var raw []byte
	var parseErr error
	switch {
	case info.IsDir():
		if _, statErr := os.Stat(filepath.Join(path, "package.json")); statErr == nil {
			pkg, err := protocol.ParsePluginPackageDir(path)
			raw, parseErr = pkg.ManifestRaw, err
		} else {
			raw, parseErr = os.ReadFile(filepath.Join(path, "manifest.json"))
		}
	case protocol.IsPluginPackageName(path):
		data, err := os.ReadFile(path)
		if err != nil {
			parseErr = err
			break
		}
		pkg, err := protocol.ParsePluginPackage(data)
		raw, parseErr = pkg.ManifestRaw, err
	default:
		raw, parseErr = os.ReadFile(path)
	}
	if parseErr != nil {
		return protocol.Manifest{}, nil, &cliError{code: exitBadRequest, reason: "plugin_invalid", msg: "插件校验失败：" + parseErr.Error()}
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return protocol.Manifest{}, nil, &cliError{code: exitBadRequest, reason: "plugin_invalid", msg: "manifest 不是合法的 JSON：" + err.Error()}
	}
	adapters, err := protocol.LoadInstalledProviders(raw)
	if err != nil {
		return protocol.Manifest{}, nil, &cliError{code: exitBadRequest, reason: "plugin_invalid", msg: "插件校验失败：" + err.Error()}
	}
	return manifest, adapters, nil
}

func describeDevAuth(spec, provider protocol.ManifestAuth) string {
	auth := spec
	if strings.TrimSpace(auth.Type) == "" {
		auth = provider
	}
	if strings.TrimSpace(auth.Type) == "" {
		return "未声明"
	}
	return fmt.Sprintf("%s（读取配置字段 %s）", auth.Type, auth.Field)
}
