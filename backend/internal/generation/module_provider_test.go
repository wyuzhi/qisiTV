package generation

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/pluginhost"
	"infinite-canvas/backend/internal/protocol"
)

const testModuleProvider = `
let submits = 0;
export async function submit(request, ctx) {
  submits++;
  if (request.prompt === 'boom') throw new Error('connection reset');
  if (ctx.config.apiKey !== 'fixture') return { status: 'failed', message: 'missing key' };
  return { taskId: 'task-' + submits, status: 'processing' };
}
export async function query(taskId, request, ctx) {
  if (!['task-1', 'resumed-1'].includes(taskId)) throw new Error('unknown task ' + taskId);
  return { status: 'succeeded', result: { images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] } };
}
`

func moduleProviderRegistry(t *testing.T) *protocol.Registry {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "agent-host", "plugin-host.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pluginhost.UseCommandForTesting(node, script))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "provider.mjs"), []byte(testModuleProvider), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := `{"apiVersion":"beeftv.plugin/v2","id":"module-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"module-image","label":"Module Image","module":"./provider.mjs","capabilities":["image"],"scopes":["canvas"]}]}}`
	adapters, err := protocol.LoadInstalledProviders([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(protocol.BindModuleProviders(adapters, dir, "rev-1")...)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func runModuleFixture(t *testing.T, registry *protocol.Registry, prompt, resumed string) (map[string]any, *recordingReceipts, error) {
	receipts := &recordingReceipts{}
	runtime := taskRuntime(func(r *Runtime) {
		r.Receipts = receipts
		r.Call.ProviderRequestID = resumed
	})
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), runtime), registry)
	input := Input{Mode: "image", Prompt: prompt, Config: Config{InterfaceType: "module-image", Model: "any", BaseURL: "http://127.0.0.1:8188", APIKey: "fixture"}}
	result, err := Execute(ctx, input)
	return result, receipts, err
}

func TestModuleProviderSubmitsQueriesAndRecordsTheTask(t *testing.T) {
	registry := moduleProviderRegistry(t)
	result, receipts, err := runModuleFixture(t, registry, "draw", "")
	if err != nil {
		t.Fatal(err)
	}
	images, _ := result["images"].([]any)
	if len(images) != 1 || images[0].(map[string]any)["dataUrl"] != "data:image/png;base64,iVBORw0KGgo=" {
		t.Fatalf("result = %#v", result)
	}
	observations := receipts.snapshot()
	if len(observations) != 2 {
		t.Fatalf("observations = %d", len(observations))
	}
	created, polled := observations[0], observations[1]
	if created.Request.URL.String() != "plugin://module-fixture/tasks" || !strings.Contains(string(created.Body), `"task_id":"task-1"`) {
		t.Fatalf("create receipt = %s %s", created.Request.URL, created.Body)
	}
	if polled.Request.URL.Path != "/tasks/task-1" || ProviderRequestIDFromPath(polled.Request.URL.Path) != "task-1" {
		t.Fatalf("poll receipt = %s", polled.Request.URL)
	}
	// The call log is the receipt: a successful create with a provider ID marks the task accepted.
	var logged []model.ApiCallLog
	capture := func(entry model.ApiCallLog) error { logged = append(logged, entry); return nil }
	RecordProviderRequest(nil, capture, created.Request, created.StartedAt, created.StatusCode, created.Body, created.Err)
	if len(logged) != 1 || logged[0].RequestKind != "create" || logged[0].Status != model.ApiCallStatusSucceeded || logged[0].ProviderRequestID != "task-1" {
		t.Fatalf("call log = %#v", logged)
	}
}

func TestModuleProviderResumeOnlyQueries(t *testing.T) {
	registry := moduleProviderRegistry(t)
	// "boom" makes submit throw, so success proves the resumed task was never submitted again.
	result, receipts, err := runModuleFixture(t, registry, "boom", "resumed-1")
	if err != nil || result["mode"] != "image" {
		t.Fatalf("result = %#v err = %v", result, err)
	}
	for _, observation := range receipts.snapshot() {
		if observation.Request.Method != "GET" {
			t.Fatalf("resume sent %s %s", observation.Request.Method, observation.Request.URL)
		}
	}
}

func TestModuleProviderSubmitErrorIsUnknownNotRetried(t *testing.T) {
	registry := moduleProviderRegistry(t)
	_, receipts, err := runModuleFixture(t, registry, "boom", "")
	var unknown SubmissionUnknownError
	if !errors.As(err, &unknown) || !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("err = %v", err)
	}
	if len(receipts.snapshot()) != 1 {
		t.Fatalf("submit was called %d times", len(receipts.snapshot()))
	}
}
