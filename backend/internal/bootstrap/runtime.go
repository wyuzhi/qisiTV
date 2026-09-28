package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"qisitv/backend/internal/app"
	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/database"
	canvasHandler "qisitv/backend/internal/handler"
	"qisitv/backend/internal/localapp"
	localproject "qisitv/backend/internal/project"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"
	httptransport "qisitv/backend/internal/transport/http"
	"qisitv/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Runtime struct {
	cfg         Config
	db          *gorm.DB
	service     *app.Service
	localApp    *localapp.App
	handler     http.Handler
	status      *systemStatus
	launchToken string
	listener    net.Listener
	httpServer  *http.Server
	serveErr    chan error
	started     atomic.Bool
	closed      atomic.Bool
	closeOnce   sync.Once
	background  sync.WaitGroup
	closeErr    error
}

func Open(_ context.Context, raw Config) (*Runtime, error) {
	cfg := raw.withDefaults()
	if cfg.Profile != ProfileServer && cfg.Profile != ProfileDesktop {
		return nil, fmt.Errorf("不支持的运行模式：%s", cfg.Profile)
	}
	if strings.TrimSpace(cfg.DataDir) == "" {
		return nil, errors.New("后端数据目录不能为空")
	}
	if cfg.Profile == ProfileDesktop && !strings.HasPrefix(cfg.ListenAddr, "127.0.0.1:") {
		return nil, errors.New("桌面运行时只能监听 127.0.0.1")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	db, err := database.Open(database.Config{Driver: cfg.DatabaseDriver, DSN: cfg.DatabaseURL, DataDir: cfg.DataDir})
	if err != nil {
		return nil, err
	}
	cleanupDB := func() {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
	}
	if err := database.ConfigurePool(db); err != nil {
		cleanupDB()
		return nil, err
	}
	if cfg.AutoMigrate {
		err = database.MigrateLocalSchema(db)
	} else {
		err = database.RequireLocalSchema(db)
	}
	if err != nil {
		cleanupDB()
		return nil, err
	}

	svc := app.NewLocal(repository.New(db), cfg.DataDir)
	svc.UseLikeAIOnly()
	cleanupService := func() {
		_ = svc.Close()
		cleanupDB()
	}
	if err := initializeService(svc); err != nil {
		cleanupService()
		return nil, err
	}
	providerConfig, configErr := workspace.NewLikeAIProviderConfig(cfg.DataDir)
	if configErr != nil {
		cleanupService()
		return nil, configErr
	}
	localKernel := app.NewLocalKernel(svc)
	assetService := localasset.New(localKernel, cfg.DataDir)
	projectService := localproject.New(localKernel)
	taskService := localtask.New(localKernel)
	localRoot, err := localapp.New(localapp.Options{
		Workspace: localKernel, Projects: projectService, Assets: assetService, Tasks: taskService,
		Generation: taskService, ProviderConfig: providerConfig, Agent: localKernel, Lifecycle: taskService,
	})
	if err != nil {
		cleanupService()
		return nil, err
	}

	owner, ownerErr := svc.LocalWorkspaceOwner()
	if ownerErr != nil {
		cleanupService()
		return nil, ownerErr
	}
	scope := workspace.Context{ID: owner.ID, DataDir: cfg.DataDir}

	router := gin.New()
	router.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		return fmt.Sprintf("%s - [%s] \"%s %s\" %d %s %s\n", param.ClientIP, param.TimeStamp.Format(time.RFC3339), param.Method, param.Path, param.StatusCode, param.Latency, param.ErrorMessage)
	}), gin.Recovery())
	router.Use(canvasHandler.RequestCorrelationMiddleware())
	for _, middleware := range cfg.RouterMiddleware {
		router.Use(middleware)
	}
	if cfg.Profile == ProfileDesktop {
		router.Use(desktopCORSMiddleware())
	}
	router.Use(canvasHandler.WorkspaceMiddleware(scope))
	api := router.Group("/api")
	status := newSystemStatus(db, svc, true)
	registerSystemStatusRoutes(api, status)
	canvasHandler.RegisterDesktopCanvasAPIWithDependencies(api, svc, canvasHandler.RuntimeDependencies{
		RequestCoordinator: localKernel,
		ProviderConfig:     localRoot.ProviderConfig,
		Assets:             localRoot.Assets,
		Projects:           localRoot.Projects,
		Tasks:              localRoot.Tasks,
		Generation:         localRoot.Generation,
	})
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "msg": "请求不存在"})
	})

	rootHandler := http.Handler(router)
	launchToken := ""
	if cfg.Profile == ProfileDesktop {
		launchToken = strings.TrimSpace(cfg.LaunchToken)
		if launchToken == "" {
			launchToken, err = httptransport.NewLaunchToken()
			if err != nil {
				cleanupService()
				return nil, err
			}
		}
		rootHandler = httptransport.RequireLaunchToken(launchToken)(rootHandler)
	}
	return &Runtime{
		cfg:         cfg,
		db:          db,
		service:     svc,
		localApp:    localRoot,
		handler:     rootHandler,
		status:      status,
		launchToken: launchToken,
		serveErr:    make(chan error, 1),
	}, nil
}

func initializeService(svc *app.Service) error {
	if err := svc.ValidateRuntime(); err != nil {
		return err
	}
	initializers := []func() error{
		svc.EnsureDefaultPromptTemplates,
		svc.EnsureBuiltinProjectWorkflowTemplate,
		svc.EnsureBuiltinSkills,
		svc.EnsureSkillPackages,
	}
	for _, initialize := range initializers {
		if err := initialize(); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) Handler() http.Handler { return r.handler }

func (r *Runtime) Start() error {
	if r == nil || r.closed.Load() {
		return errors.New("运行时已关闭")
	}
	if !r.started.CompareAndSwap(false, true) {
		return nil
	}
	listener, err := net.Listen("tcp", r.cfg.ListenAddr)
	if err != nil {
		r.started.Store(false)
		return err
	}
	r.listener = listener
	r.httpServer = &http.Server{Handler: r.handler, ReadHeaderTimeout: 10 * time.Second}
	if r.localApp != nil {
		r.localApp.Start()
	} else {
		r.service.StartWorker()
	}
	r.background.Add(1)
	go func() {
		defer r.background.Done()
		r.service.BackfillPlaybackTranscodes()
	}()
	r.status.markStarted()
	go func() {
		err := r.httpServer.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			r.serveErr <- fmt.Errorf("HTTP 服务异常退出：%w", err)
		}
		close(r.serveErr)
	}()
	return nil
}

func (r *Runtime) Ready() bool {
	return r != nil && r.started.Load() && !r.closed.Load() && r.status.snapshot(context.Background()).Ready
}

func (r *Runtime) BaseURL() string {
	if r == nil || r.listener == nil {
		return ""
	}
	return "http://" + r.listener.Addr().String() + "/api"
}

func (r *Runtime) LaunchToken() string {
	if r == nil {
		return ""
	}
	return r.launchToken
}

func (r *Runtime) Errors() <-chan error {
	if r == nil {
		closed := make(chan error)
		close(closed)
		return closed
	}
	return r.serveErr
}

func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		r.status.beginDrain()
		var failures []error
		if r.httpServer != nil {
			httpCtx, cancel := context.WithTimeout(ctx, min(30*time.Second, r.cfg.ShutdownTimeout))
			if err := r.httpServer.Shutdown(httpCtx); err != nil {
				_ = r.httpServer.Close()
				failures = append(failures, fmt.Errorf("关闭 HTTP 服务：%w", err))
			}
			cancel()
		}
		workerCtx, cancel := context.WithTimeout(ctx, r.cfg.ShutdownTimeout)
		var workerErr error
		if r.localApp != nil {
			workerErr = r.localApp.Stop(workerCtx)
		} else {
			workerErr = r.service.StopWorker(workerCtx)
		}
		if workerErr != nil {
			failures = append(failures, fmt.Errorf("等待后台任务退出：%w", workerErr))
		}
		cancel()
		backgroundDone := make(chan struct{})
		go func() {
			r.background.Wait()
			close(backgroundDone)
		}()
		select {
		case <-backgroundDone:
		case <-ctx.Done():
			failures = append(failures, fmt.Errorf("等待初始化任务退出：%w", ctx.Err()))
		}
		var serviceErr error
		if r.localApp != nil {
			serviceErr = r.localApp.Close()
		} else {
			serviceErr = r.service.Close()
		}
		if serviceErr != nil {
			failures = append(failures, serviceErr)
		}
		if sqlDB, err := r.db.DB(); err == nil {
			if err := sqlDB.Close(); err != nil {
				failures = append(failures, err)
			}
		}
		r.closeErr = errors.Join(failures...)
	})
	return r.closeErr
}

func desktopCORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
		}
		c.Header("Access-Control-Allow-Headers", "Accept, Content-Type, X-Desktop-Token, X-Canvas-Trace-ID, X-Idempotency-Key, X-Canvas-Scene, X-Canvas-Upstream-URL, X-Canvas-Upstream-Format, X-Canvas-Upstream-Base-URL")
		c.Header("Access-Control-Expose-Headers", "X-Request-ID, X-Canvas-Trace-ID, X-Diagnostic-Bundle-ID, X-Diagnostic-Schema-Version")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
