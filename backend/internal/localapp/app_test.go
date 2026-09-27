package localapp

import (
	"context"
	"mime/multipart"
	"reflect"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

type fakePorts struct{}

func (fakePorts) WorkspaceOwner(string) (*model.User, error)        { return &model.User{}, nil }
func (fakePorts) ListProjects(string) ([]app.ProjectSummary, error) { return nil, nil }
func (fakePorts) Resources(string, int) ([]model.Resource, error)   { return nil, nil }
func (fakePorts) UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error) {
	return nil, nil
}

func TestLocalCompositionRootDoesNotRetainLegacyService(t *testing.T) {
	if _, ok := reflect.TypeOf(App{}).FieldByName("legacy"); ok {
		t.Fatal("local composition root retains the legacy application service")
	}
}
func (fakePorts) TasksWithOptions(string, localtask.ListOptions) ([]localtask.Summary, error) {
	return nil, nil
}
func (fakePorts) CreateTask(string, localtask.CreateRequest) (*model.Task, error) { return nil, nil }
func (fakePorts) ReadLocalModelConfig() ([]byte, error)                           { return nil, nil }
func (fakePorts) SaveLocalModelConfig([]byte) error                               { return nil }
func (fakePorts) CloudAgentRun(string, string) (*app.CloudAgentRun, error)        { return nil, nil }
func (fakePorts) StartWorker()                                                    {}
func (fakePorts) StopWorker(context.Context) error                                { return nil }
func (fakePorts) Close() error                                                    { return nil }

func TestNewRequiresEveryLocalPort(t *testing.T) {
	ports := fakePorts{}
	valid := Options{
		Workspace: ports, Projects: ports, Assets: ports, Tasks: ports,
		Generation: ports, ProviderConfig: ports, Agent: ports, Lifecycle: ports,
	}
	app, err := New(valid)
	if err != nil || app == nil {
		t.Fatalf("New(valid) = (%v, %v), want app", app, err)
	}

	tests := []struct {
		name string
		omit func(*Options)
	}{
		{"workspace", func(o *Options) { o.Workspace = nil }},
		{"projects", func(o *Options) { o.Projects = nil }},
		{"assets", func(o *Options) { o.Assets = nil }},
		{"tasks", func(o *Options) { o.Tasks = nil }},
		{"generation", func(o *Options) { o.Generation = nil }},
		{"provider config", func(o *Options) { o.ProviderConfig = nil }},
		{"agent", func(o *Options) { o.Agent = nil }},
		{"lifecycle", func(o *Options) { o.Lifecycle = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := valid
			test.omit(&options)
			if _, err := New(options); err == nil {
				t.Fatal("New succeeded with a missing mandatory local port")
			}
		})
	}
}
