package repository

import (
	"testing"
	"time"

	"qisitv/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newProviderReferenceRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:provider-references-"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.ChannelModel{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

// TestTaskProviderReferencesResolvesTheDispatchedProtocol pins which tasks still
// need the protocol they would dispatch with. Ordinary BYOK tasks leave
// tasks.provider empty and carry the protocol in input config.interfaceType, so a
// provider-only query would miss them; route tasks set provider to "managed".
func TestTaskProviderReferencesResolvesTheDispatchedProtocol(t *testing.T) {
	repo := newProviderReferenceRepo(t)
	now := time.Now().UTC()
	byokInput := `{"mode":"video","config":{"interfaceType":"video-generations-json","baseUrl":"https://relay.example","apiKey":"__enc__","model":"seedance-2.5"}}`
	tasks := []model.Task{
		// Real BYOK shape: no top-level provider, protocol in the input config.
		{ID: "byok-queued", UserID: "u", Status: model.TaskStatusQueued, InputJSON: byokInput, CreatedAt: now, UpdatedAt: now},
		{ID: "byok-running", UserID: "u", Status: model.TaskStatusRunning, InputJSON: byokInput, CreatedAt: now, UpdatedAt: now},
		// Route task: provider is "managed", the protocol is still in the input.
		{ID: "managed-running", UserID: "u", Provider: "managed", Status: model.TaskStatusRunning, InputJSON: `{"config":{"interfaceType":"xai-video"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "succeeded", UserID: "u", Provider: "managed", Status: model.TaskStatusSucceeded, ProviderRequestID: "up-1", InputJSON: byokInput, CreatedAt: now, UpdatedAt: now},
		// Failed before submission: nothing left to retrieve.
		{ID: "failed-unsent", UserID: "u", Status: model.TaskStatusFailed, InputJSON: `{"config":{"interfaceType":"unsent-protocol"}}`, CreatedAt: now, UpdatedAt: now},
		// Failed after submission: manual recovery queries the same protocol.
		{ID: "failed-upstream", UserID: "u", Status: model.TaskStatusFailed, ProviderRequestID: "up-2", InputJSON: `{"config":{"interfaceType":"recoverable-protocol"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "cancelled-open", UserID: "u", Status: model.TaskStatusCancelled, ProviderRequestID: "up-3", ProviderCancelStatus: model.ProviderCancelStatusRequested, InputJSON: `{"config":{"interfaceType":"cancelling-protocol"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "cancelled-done", UserID: "u", Status: model.TaskStatusCancelled, ProviderRequestID: "up-4", ProviderCancelStatus: model.ProviderCancelStatusConfirmed, InputJSON: `{"config":{"interfaceType":"cancelled-protocol"}}`, CreatedAt: now, UpdatedAt: now},
		{ID: "text-replay", UserID: "u", Status: model.TaskStatusTextReplay, Provider: "text-protocol", CreatedAt: now, UpdatedAt: now},
		// Legacy row: protocol only in the top-level provider, no usable input.
		{ID: "legacy", UserID: "u", Provider: "legacy-protocol", Status: model.TaskStatusQueued, InputJSON: "", CreatedAt: now, UpdatedAt: now},
		// Same protocol in both places counts once.
		{ID: "both", UserID: "u", Provider: "newapi", Status: model.TaskStatusQueued, InputJSON: `{"config":{"interfaceType":"newapi"}}`, CreatedAt: now, UpdatedAt: now},
		// Corrupt input cannot be resolved; the task no longer executes.
		{ID: "corrupt", UserID: "u", Status: model.TaskStatusQueued, InputJSON: `{"config":`, CreatedAt: now, UpdatedAt: now},
	}
	for index := range tasks {
		if err := repo.Create(&tasks[index]); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := repo.TaskProviderReferences()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{
		// Three BYOK/route tasks share the JSON protocol; the succeeded task does
		// not count even though it carries the same input.
		"video-generations-json": 2,
		"xai-video":              1,
		"recoverable-protocol":   1,
		"cancelling-protocol":    1,
		"legacy-protocol":        1,
		"newapi":                 1,
		// Only the running route task carries the route marker; the succeeded one
		// is not counted. No manifest provider is named "managed", so it can never
		// retain a plugin by itself.
		"managed": 1,
	}
	if len(counts) != len(want) {
		t.Fatalf("task references = %#v want %#v", counts, want)
	}
	for id, total := range want {
		if counts[id] != total {
			t.Fatalf("task reference %q = %d want %d (all: %#v)", id, counts[id], total, counts)
		}
	}
	for _, absent := range []string{"finished-protocol", "unsent-protocol", "cancelled-protocol", "text-protocol"} {
		if counts[absent] != 0 {
			t.Fatalf("task that can no longer reach a provider was counted: %q in %#v", absent, counts)
		}
	}
}

// TestChannelModelProtocolReferencesIgnoresRemovedRows keeps the audit on the
// channel models that still exist.
func TestChannelModelProtocolReferencesIgnoresRemovedRows(t *testing.T) {
	repo := newProviderReferenceRepo(t)
	now := time.Now().UTC()
	rows := []model.ChannelModel{
		{ID: "m1", ChannelID: "c1", ModelKey: "a", Protocol: model.ChannelInterfaceNewAPIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m2", ChannelID: "c1", ModelKey: "b", Protocol: model.ChannelInterfaceNewAPIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m3", ChannelID: "c2", ModelKey: "c", Protocol: model.ChannelInterfaceXAIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m4", ChannelID: "c2", ModelKey: "d", Protocol: "", CreatedAt: now, UpdatedAt: now},
		{ID: "m5", ChannelID: "c3", ModelKey: "e", Protocol: model.ChannelInterfaceXAIVideo, CreatedAt: now, UpdatedAt: now, DeletedAt: gorm.DeletedAt{Time: now, Valid: true}},
	}
	for index := range rows {
		if err := repo.Create(&rows[index]); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := repo.ChannelModelProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts[string(model.ChannelInterfaceNewAPIVideo)] != 2 || counts[string(model.ChannelInterfaceXAIVideo)] != 1 || len(counts) != 2 {
		t.Fatalf("channel model references = %#v", counts)
	}
}

// TestTaskProtocolsReadsTheDispatchedProtocol covers the resolution rules without
// a database: BYOK rows carry the protocol only in the input config, route rows
// add "managed" at the top level, and a legacy row may carry it in provider.
func TestTaskProtocolsReadsTheDispatchedProtocol(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		input    string
		want     []string
	}{
		{"byok", "", `{"mode":"video","config":{"interfaceType":"video-generations-json"}}`, []string{"video-generations-json"}},
		{"route", "managed", `{"config":{"interfaceType":"xai-video"}}`, []string{"managed", "xai-video"}},
		{"legacy", "legacy-protocol", "", []string{"legacy-protocol"}},
		{"deduplicated", "newapi", `{"config":{"interfaceType":"newapi"}}`, []string{"newapi"}},
		{"corrupt input", "", `{"config":`, nil},
		{"empty", "  ", "  ", nil},
	}
	for _, tc := range cases {
		got := taskProtocols(tc.provider, tc.input)
		if len(got) != len(tc.want) {
			t.Fatalf("%s: protocols = %#v want %#v", tc.name, got, tc.want)
		}
		for index := range tc.want {
			if got[index] != tc.want[index] {
				t.Fatalf("%s: protocols = %#v want %#v", tc.name, got, tc.want)
			}
		}
	}
}

// TestInputProtocolIgnoresCredentials makes sure the audit reads the protocol and
// nothing else from a stored task input.
func TestInputProtocolIgnoresCredentials(t *testing.T) {
	raw := `{"config":{"interfaceType":"volcengine-jimeng-video","apiKey":"__enc__","secretKey":"__enc__","headers":[{"name":"X-Key","value":"__enc__"}]}}`
	if got := inputProtocol(raw); got != "volcengine-jimeng-video" {
		t.Fatalf("inputProtocol = %q", got)
	}
	if got := inputProtocol(`{"mode":"video"}`); got != "" {
		t.Fatalf("missing interfaceType = %q", got)
	}
}

// TestTaskProviderReferencesCountsFailedTaskRecoverableFromRequestLog covers a
// failed task whose upstream ID was never copied onto the task row. Manual
// recovery reads it back from the request log, so the protocol is still needed;
// the audit must count it without writing the ID back onto the task.
func TestTaskProviderReferencesCountsFailedTaskRecoverableFromRequestLog(t *testing.T) {
	repo := newProviderReferenceRepo(t)
	now := time.Now().UTC()
	tasks := []model.Task{
		{ID: "failed-log-only", UserID: "u", Status: model.TaskStatusFailed, InputJSON: `{"config":{"interfaceType":"log-recoverable"}}`, CreatedAt: now, UpdatedAt: now},
		// A request log without an upstream ID gives recovery nothing to query.
		{ID: "failed-log-empty", UserID: "u", Status: model.TaskStatusFailed, InputJSON: `{"config":{"interfaceType":"log-empty"}}`, CreatedAt: now, UpdatedAt: now},
		// A succeeded task with a logged upstream ID never polls again.
		{ID: "succeeded-logged", UserID: "u", Status: model.TaskStatusSucceeded, InputJSON: `{"config":{"interfaceType":"log-finished"}}`, CreatedAt: now, UpdatedAt: now},
	}
	for index := range tasks {
		if err := repo.Create(&tasks[index]); err != nil {
			t.Fatal(err)
		}
	}
	logs := []model.ApiCallLog{
		{ID: "l1", UserID: "u", TaskID: "failed-log-only", Capability: "video", ProviderRequestID: "", CreatedAt: now.Add(-2 * time.Minute)},
		{ID: "l2", UserID: "u", TaskID: "failed-log-only", Capability: "video", ProviderRequestID: "up-log", CreatedAt: now.Add(-time.Minute)},
		{ID: "l3", UserID: "u", TaskID: "failed-log-empty", Capability: "video", ProviderRequestID: "", CreatedAt: now},
		{ID: "l4", UserID: "u", TaskID: "succeeded-logged", Capability: "video", ProviderRequestID: "up-done", CreatedAt: now},
	}
	for index := range logs {
		if err := repo.db.Create(&logs[index]).Error; err != nil {
			t.Fatal(err)
		}
	}
	counts, err := repo.TaskProviderReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts["log-recoverable"] != 1 || len(counts) != 1 {
		t.Fatalf("task references = %#v, want only log-recoverable=1", counts)
	}
	stored, err := repo.Task("failed-log-only")
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProviderRequestID != "" {
		t.Fatalf("audit wrote the logged upstream ID back onto the task: %q", stored.ProviderRequestID)
	}
}
