package plugins

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
	"qisitv/backend/internal/protocol"
)

// ClientBundle resolves the installed manifest on every request so disabling or
// updating a package also updates the code served to a paired browser.
func (s *Service) ClientBundle(id string) ([]byte, error) {
	if s == nil || s.runtime == nil {
		return nil, packageError(503, "plugin_runtime_unavailable", "插件服务未就绪")
	}
	rt := s.runtime
	rt.mu.RLock()
	record, ok := rt.plugins[id]
	rt.mu.RUnlock()
	if !ok || record.Status != StatusEnabled || record.PackageDir == "" {
		return nil, packageError(404, "plugin_client_unavailable", "此插件没有已启用的网页入口")
	}
	var manifest protocol.Manifest
	if err := json.Unmarshal(record.Raw, &manifest); err != nil || manifest.Client == "" {
		return nil, packageError(404, "plugin_client_unavailable", "此插件没有网页入口")
	}
	entry := strings.TrimPrefix(manifest.Client, "./")
	private := append([]string{"extensions", "skills", "server", "backend"}, manifest.Contributes.Extensions...)
	private = append(private, manifest.Contributes.Skills...)
	for _, provider := range manifest.Contributes.Providers {
		if provider.Module != "" {
			private = append(private, provider.Module)
		}
	}
	info, err := os.Lstat(record.PackageDir)
	if err != nil || !info.IsDir() {
		return nil, packageError(404, "plugin_client_unavailable", "插件文件夹不可用")
	}
	pkg, err := os.OpenRoot(record.PackageDir)
	if err != nil {
		return nil, packageError(404, "plugin_client_unavailable", "插件文件夹不可用")
	}
	defer pkg.Close()
	clientDir := path.Dir(entry)
	// An entry at package root can be used as a single file. Dependencies must
	// be grouped with their entry in a dedicated client directory.
	if !fs.ValidPath(entry) || strings.ContainsAny(entry, "\\%?#:*") {
		return nil, packageError(400, "plugin_client_invalid", "插件网页入口路径无效")
	}
	source := &bundleSource{root: pkg, dir: clientDir, entry: entry, private: private}
	if _, _, err := s.ResolvePackageFile(id, entry); err != nil {
		return nil, err
	}
	return source.bundle()
}

type bundleSource struct {
	root             *os.Root
	dir, entry       string
	private          []string
	mu               sync.Mutex
	byteCount, files int
}

func (s *bundleSource) read(name string) (string, error) {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\%?#:*") ||
		(path.Ext(name) != ".js" && path.Ext(name) != ".mjs") ||
		(name != s.entry && (s.dir == "." || !strings.HasPrefix(name, s.dir+"/"))) {
		return "", errors.New("仅支持插件网页入口目录内的相对 JavaScript 模块")
	}
	for _, hidden := range s.private {
		hidden = strings.TrimPrefix(hidden, "./")
		if name == hidden || strings.HasPrefix(name, hidden+"/") {
			return "", errors.New("不能导入插件的服务端文件")
		}
	}
	// Keep the file descriptor rooted even if the package changes during a
	// read. Reject symlinks, including links to non-client files in this package.
	prefix := ""
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") || segment == "node_modules" {
			return "", errors.New("插件模块路径无效")
		}
		prefix = path.Join(prefix, segment)
		info, err := s.root.Lstat(prefix)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("插件网页模块不存在或包含软链接")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	const maxBytes = 8 << 20
	if s.files >= 256 || s.byteCount >= maxBytes {
		return "", errors.New("插件网页模块过多或过大")
	}
	file, err := s.root.Open(name)
	if err != nil {
		return "", errors.New("无法读取插件网页模块")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("无效的插件网页模块")
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(maxBytes-s.byteCount+1)))
	if err != nil || len(data) > maxBytes-s.byteCount {
		return "", errors.New("插件网页模块过大或读取失败")
	}
	s.files++
	s.byteCount += len(data)
	return string(data), nil
}

func (s *bundleSource) bundle() ([]byte, error) {
	const ns = "plugin-client"
	loader := api.Plugin{Name: ns, Setup: func(b api.PluginBuild) {
		b.OnResolve(api.OnResolveOptions{Filter: ".*"}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
			if a.Kind == api.ResolveEntryPoint {
				return api.OnResolveResult{Path: s.entry, Namespace: ns}, nil
			}
			if a.Namespace != ns || (a.Kind != api.ResolveJSImportStatement && a.Kind != api.ResolveJSDynamicImport) ||
				(!strings.HasPrefix(a.Path, "./") && !strings.HasPrefix(a.Path, "../")) {
				return api.OnResolveResult{}, errors.New("仅支持插件网页目录内的相对模块导入")
			}
			return api.OnResolveResult{Path: path.Join(path.Dir(a.Importer), a.Path), Namespace: ns}, nil
		})
		b.OnLoad(api.OnLoadOptions{Filter: ".*", Namespace: ns}, func(a api.OnLoadArgs) (api.OnLoadResult, error) {
			body, err := s.read(a.Path)
			return api.OnLoadResult{Contents: &body, Loader: api.LoaderJS}, err
		})
	}}
	result := api.Build(api.BuildOptions{
		EntryPoints: []string{"client"}, Plugins: []api.Plugin{loader}, Bundle: true,
		Platform: api.PlatformBrowser, Format: api.FormatESModule, Target: api.ES2022, TsconfigRaw: "{}",
		LogLevel: api.LogLevelSilent, LogOverride: map[string]api.LogLevel{
			"unsupported-dynamic-import": api.LogLevelError, "unsupported-require-call": api.LogLevelError,
			"indirect-require": api.LogLevelError, "empty-glob": api.LogLevelError,
		},
	})
	if len(result.Errors) > 0 || len(result.OutputFiles) != 1 {
		reason := "插件网页模块编译失败"
		if len(result.Errors) > 0 {
			reason += "：" + result.Errors[0].Text
		}
		return nil, packageError(http.StatusBadRequest, "plugin_client_invalid", reason)
	}
	return result.OutputFiles[0].Contents, nil
}
