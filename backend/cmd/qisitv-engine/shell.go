package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"qisitv/backend/internal/bootstrap"
	"qisitv/backend/internal/desktopstorage"
	"qisitv/backend/internal/model"
)

type engineSettings struct {
	WorkspaceID      string `json:"workspaceId"`
	ProjectDirectory string `json:"projectDirectory,omitempty"`
}

type engineShell struct {
	runtime           *bootstrap.Runtime
	ctx               context.Context
	dataDir           string
	mu                sync.RWMutex
	chooseMu          sync.Mutex
	settings          engineSettings
	choose            func(context.Context) (string, error)
	referenceMu       sync.Mutex
	progressMu        sync.RWMutex
	referenceProgress model.TaskReferenceProgress
	stop              context.CancelFunc
	maintenance       atomic.Bool
}

func newEngineShell(ctx context.Context, runtime *bootstrap.Runtime, dataDir, explicitDirectory string) (*engineShell, error) {
	shell := &engineShell{runtime: runtime, ctx: ctx, dataDir: dataDir, choose: chooseProjectDirectory}
	data, err := os.ReadFile(filepath.Join(dataDir, "qisitv-engine.json"))
	if err == nil {
		if json.Unmarshal(data, &shell.settings) != nil || shell.settings.WorkspaceID == "" {
			return nil, errors.New("本机引擎配置损坏，请保留数据并联系支持")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if shell.settings.WorkspaceID == "" {
		shell.settings.WorkspaceID = uuid.NewString()
	}
	if explicitDirectory != "" {
		if shell.settings.ProjectDirectory != "" && filepath.Clean(explicitDirectory) != filepath.Clean(shell.settings.ProjectDirectory) {
			return nil, errors.New("已有项目目录不能直接覆盖，请使用新的隔离数据目录或项目迁移")
		}
		shell.settings.ProjectDirectory = explicitDirectory
	}
	if shell.settings.ProjectDirectory != "" {
		directory, err := checkedProjectDirectory(shell.settings.ProjectDirectory)
		if err != nil {
			return nil, err
		}
		shell.settings.ProjectDirectory = directory
		if err := runtime.SetupProjectFolders(directory, shell.settings.WorkspaceID); err != nil {
			return nil, err
		}
		go runtime.ProjectFolders().Run(ctx)
	}
	if err := shell.saveSettings(shell.settings); err != nil {
		return nil, err
	}
	return shell, nil
}

func checkedProjectDirectory(value string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", errors.New("请选择本机的绝对目录")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(value))
	if err != nil {
		return "", errors.New("项目目录不存在或无权访问")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("项目位置必须是文件夹")
	}
	if filepath.Dir(resolved) == resolved {
		return "", errors.New("请选择专门的项目文件夹，不要选择磁盘根目录")
	}
	return resolved, nil
}

func (s *engineShell) saveSettings(settings engineSettings) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(s.dataDir, ".qisitv-engine-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(s.dataDir, "qisitv-engine.json"))
}

func (s *engineShell) configured() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings.ProjectDirectory != "" && s.runtime.ProjectFolders() != nil
}
func (s *engineShell) directory() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings.ProjectDirectory
}

func shellJSON(w http.ResponseWriter, status int, data any, reason, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	code := status
	if status == 200 {
		code = 0
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "data": data, "reason": reason, "msg": message})
}

func shellBody(w http.ResponseWriter, r *http.Request, output any, limit int64) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("只允许一个 JSON 请求")
	}
	return nil
}

func (s *engineShell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/engine/shell")
	switch path {
	case "/maintenance/stop":
		s.stopForMaintenance(w, r)
	case "/storage":
		if r.Method != http.MethodGet {
			shellJSON(w, 405, nil, "method_not_allowed", "GET required")
			return
		}
		usage, err := desktopstorage.Inspect(s.dataDir)
		if err != nil {
			shellJSON(w, 400, nil, "storage_failed", err.Error())
			return
		}
		executable, err := os.Executable()
		if err != nil {
			shellJSON(w, 500, nil, "storage_failed", "无法确定本机引擎程序位置")
			return
		}
		shellJSON(w, 200, struct {
			desktopstorage.Usage
			EngineExecutable string `json:"engineExecutable"`
			RuntimeOS        string `json:"runtimeOS"`
		}{usage, executable, runtime.GOOS}, "", "")
	case "/depth", "/depth/download", "/depth/pause":
		if path == "/depth" && r.Method != http.MethodGet || path != "/depth" && r.Method != http.MethodPost {
			shellJSON(w, 405, nil, "method_not_allowed", "请求方式无效")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		components := s.runtime.DepthComponents()
		if path == "/depth/download" {
			state, err := components.StartComponentDownload(ctx)
			if err != nil {
				shellJSON(w, 400, nil, "component_failed", err.Error())
				return
			}
			shellJSON(w, 200, state, "", "")
			return
		}
		if path == "/depth/pause" {
			if err := components.PauseComponentDownload(ctx); err != nil {
				shellJSON(w, 400, nil, "component_failed", err.Error())
				return
			}
		}
		state, err := components.ComponentStatus(ctx, r.URL.Query().Get("refresh") == "true")
		if err != nil {
			shellJSON(w, 400, nil, "component_failed", err.Error())
			return
		}
		shellJSON(w, 200, state, "", "")
	case "/project-folders/choose":
		if r.Method != http.MethodPost {
			shellJSON(w, 405, nil, "method_not_allowed", "POST required")
			return
		}
		if !s.chooseMu.TryLock() {
			shellJSON(w, 409, nil, "chooser_busy", "请先完成已打开的文件夹选择窗口")
			return
		}
		defer s.chooseMu.Unlock()
		value, err := s.choose(r.Context())
		if err != nil {
			shellJSON(w, 400, nil, "chooser_failed", err.Error())
			return
		}
		shellJSON(w, 200, map[string]any{"path": value, "cancelled": value == ""}, "", "")
	case "/project-folders/configure":
		if r.Method != http.MethodPost {
			shellJSON(w, 405, nil, "method_not_allowed", "POST required")
			return
		}
		var input struct {
			Directory string `json:"path"`
			Confirmed bool   `json:"confirmed"`
		}
		if shellBody(w, r, &input, 8192) != nil || !input.Confirmed {
			shellJSON(w, 400, nil, "confirmation_required", "请在网页确认要使用的项目文件夹")
			return
		}
		if err := s.configure(input.Directory); err != nil {
			shellJSON(w, 409, nil, "folder_configuration_failed", err.Error())
			return
		}
		shellJSON(w, 200, map[string]any{"workspaceConfigured": true, "projectDirectory": s.directory()}, "", "")
	default:
		if path == "/reference-storage" || strings.HasPrefix(path, "/reference-storage/") {
			s.referenceStorage(w, r, path)
			return
		}
		if strings.HasPrefix(path, "/project-folders/") {
			s.projectFolders(w, r, path)
			return
		}
		shellJSON(w, 404, nil, "not_found", "本机操作不存在")
	}
}

func (s *engineShell) configure(value string) error {
	directory, err := checkedProjectDirectory(value)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.settings.ProjectDirectory != "" {
		if s.settings.ProjectDirectory == directory {
			return nil
		}
		return errors.New("已有项目根目录；更换位置需要迁移，请勿直接覆盖")
	}
	if err := s.runtime.SetupProjectFolders(directory, s.settings.WorkspaceID); err != nil {
		return err
	}
	next := s.settings
	next.ProjectDirectory = directory
	if err := s.saveSettings(next); err != nil {
		return err
	}
	s.settings = next
	go s.runtime.ProjectFolders().Run(s.ctx)
	return nil
}
