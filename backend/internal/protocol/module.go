package protocol

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"strings"
)

// ExecutionModule 标记由插件 JS 执行的生成接口。
const ExecutionModule = "module"

// ModuleProvider 是用插件 JS 实现 submit/query（可选 models）的生成接口。插件代码在插件宿主
// 进程里自己发请求；任务号记录、轮询节奏、结果下载与恢复仍由宿主负责，所以它不构造
// HTTP 请求，Build*/Parse* 一律失败，误走声明式路径时不会发出任何请求。
type ModuleProvider struct {
	Info   Metadata
	Plugin string
	// Module 在清单里是包内相对路径，BindModuleProviders 之后是绝对路径。
	Module string
	// Revision 是安装包内容的指纹：同版本从文件夹重新安装后也会变，插件宿主据此换进程加载新代码。
	Revision string
	Auth     ManifestAuth
}

var errModuleProvider = errors.New("JS 生成接口由插件宿主执行，不构造 HTTP 请求")

func (m ModuleProvider) Metadata() Metadata { return m.Info }

func (m ModuleProvider) MediaAuth() ManifestAuth { return m.Auth }

func (m ModuleProvider) BuildCreate(context.Context, RequestContext) (RequestSpec, error) {
	return RequestSpec{}, errModuleProvider
}

func (m ModuleProvider) ParseCreate(context.Context, []byte) (CreateResult, error) {
	return CreateResult{}, errModuleProvider
}

func (m ModuleProvider) BuildPoll(context.Context, PollContext) (RequestSpec, error) {
	return RequestSpec{}, errModuleProvider
}

func (m ModuleProvider) ParsePoll(context.Context, PollContext, []byte) (PollResult, error) {
	return PollResult{}, errModuleProvider
}

func (m ModuleProvider) BuildCancel(context.Context, PollContext) (RequestSpec, error) {
	return RequestSpec{}, errModuleProvider
}

// BindModuleProviders 把 JS 生成接口的入口解析到插件包目录。.beeftv-plugin 归档没有
// 包目录、也不能带代码，其中的 JS 接口标为不可用。
func BindModuleProviders(adapters []Adapter, dir, revision string) []Adapter {
	for index, adapter := range adapters {
		module, ok := adapter.(ModuleProvider)
		if !ok {
			continue
		}
		if strings.TrimSpace(dir) == "" {
			info := module.Info
			info.Enabled = false
			info.UnavailableReason = "JS 生成接口只能来自 npm 插件包"
			adapters[index] = UnavailableAdapter{Info: info}
			continue
		}
		module.Module = filepath.Join(dir, filepath.FromSlash(module.Module))
		module.Revision = revision
		adapters[index] = module
	}
	return adapters
}

func validateModuleProvider(provider ManifestProvider) error {
	module := strings.TrimSpace(provider.Module)
	if path.IsAbs(module) || strings.Contains(module, `\`) || path.Clean(module) != strings.TrimPrefix(module, "./") || strings.HasPrefix(path.Clean(module), "../") {
		return fmt.Errorf("module must be a path inside the package")
	}
	if ext := path.Ext(module); ext != ".js" && ext != ".mjs" {
		return fmt.Errorf("module must be a .js or .mjs file")
	}
	if strings.TrimSpace(provider.Create.Method) != "" || strings.TrimSpace(provider.Create.Path) != "" || provider.Poll != nil || provider.Cancel != nil || provider.Result != nil || provider.Agent != nil {
		return fmt.Errorf("module providers cannot declare create, poll, cancel, result or agent operations")
	}
	for _, capability := range provider.Capabilities {
		if capability == CapabilityText {
			return fmt.Errorf("module providers support image, video and audio")
		}
	}
	return nil
}
