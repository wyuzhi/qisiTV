package app

import (
	"context"
	"encoding/json"
	"qisitv/backend/internal/model"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/modelcatalog"
)

func TestManagedVideoUsesSavedAccountCapabilityInsteadOfRequest(t *testing.T) {
	svc, _, _, _ := creationTestService(t)
	port := appConfigPort{service: svc}
	validate := func(input *generation.Input) error {
		resolved, err := port.Resolve(input.Config)
		if err != nil {
			return err
		}
		input.Config = resolved
		return port.ApplyCapabilities(context.Background(), input)
	}
	const name = "seedance-2.5"
	server := modelcatalog.DefaultModelCapabilityConfigForModel("openai-videos", "unseen-video")
	server.Video.References = modelcatalog.VideoReferenceConfig{MaxImages: 12}
	server.Video.Duration = modelcatalog.VideoDurationConfig{Selection: "range", Min: 1, Max: 3, Step: 1, Default: 1}
	server.Video.GenerateAudio = modelcatalog.VideoBooleanConfig{Supported: false, Default: false}
	server.Video.Operations = []string{"text_to_video", "image_to_video"}
	write := func(version string, capability any) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "beefapi", "baseUrl": "https://beeftv.app", "models": []string{name}, "modelProfiles": []any{map[string]any{"model": name, "capability": "video", "protocol": "openai-videos", "capabilityConfig": capability, "videoCapabilitiesVersion": version}}}}})
		if err := svc.SaveLocalModelConfig(body); err != nil {
			t.Fatal(err)
		}
	}
	write("server-v2", server)
	forged := "forged-request-version"
	input := generation.Input{Mode: "video", Config: generation.Config{CredentialRef: managedBeefAPIRef, Model: name, InterfaceType: "newapi", BaseURL: "https://beeftv.app", VideoSeconds: "1", VideoCapabilitiesVersion: &forged, CapabilityConfig: modelcatalog.DefaultModelCapabilityConfigForModel("newapi", name)}, ReferenceImages: []generation.Media{{Bytes: 100 << 20, Width: 64, Height: 64}}}
	if err := validate(&input); err != nil {
		t.Fatal(err)
	}
	if *input.Config.VideoCapabilitiesVersion != "server-v2" || input.VideoCapability.References.MaxImageBytes != 0 || input.VideoCapability.References.MinImageWidth != 0 || input.VideoCapability.GenerateAudio.Supported {
		t.Fatal("request or local defaults replaced the current account's declaration")
	}
	for _, version := range []string{"", " "} {
		write(version, server)
		input.Config.VideoCapabilitiesVersion = &forged
		input.Config.CapabilityConfig = server
		if err := validate(&input); err != nil {
			t.Fatalf("missing current-account declaration blocked execution: %v", err)
		}
		if input.Config.VideoCapabilitiesVersion != nil {
			t.Fatalf("forged request version retained: %v", *input.Config.VideoCapabilitiesVersion)
		}
	}
	write("invalid", map[string]any{"version": 1, "video": map[string]any{}})
	if err := validate(&input); err != nil {
		t.Fatalf("invalid current-account declaration blocked execution: %v", err)
	}
	if input.Config.VideoCapabilitiesVersion != nil {
		t.Fatalf("invalid declaration retained version: %v", *input.Config.VideoCapabilitiesVersion)
	}
	write("server-v3", server)
	if err := validate(&input); err != nil {
		t.Fatalf("refresh did not restore the model: %v", err)
	}
}

func TestManagedVideoCreateTaskUsesCurrentAccountCatalog(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		name, version, seconds string
		wantVersion            string
	}{
		{"legal server duration", "server-v1", "1", "server-v1"},
		{"forged request version cannot replace account declaration", "server-v1", "9", "server-v1"},
		{"missing directory strips forged declaration without blocking", "", "1", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db, _, _ := creationTestService(t)
			const modelName = "seedance-2.5"
			capability := modelcatalog.DefaultModelCapabilityConfigForModel("openai-videos", "unknown-video")
			capability.Video.Duration = modelcatalog.VideoDurationConfig{Selection: "range", Min: 1, Max: 3, Step: 1, Default: 1}
			capability.Video.References = modelcatalog.VideoReferenceConfig{MaxImages: 12}
			body, _ := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "beefapi", "baseUrl": upstream.URL, "apiKey": "synthetic-test-key", "models": []string{modelName}, "modelProfiles": []any{map[string]any{"model": modelName, "capability": "video", "protocol": "openai-videos", "capabilityConfig": capability, "videoCapabilitiesVersion": tc.version}}}}})
			if err := svc.SaveLocalModelConfig(body); err != nil {
				t.Fatal(err)
			}
			forged := modelcatalog.DefaultModelCapabilityConfigForModel("newapi", modelName)
			forged.Video.Duration = modelcatalog.VideoDurationConfig{Selection: "range", Min: 1, Max: 30, Step: 1, Default: 9}
			request := CreateTaskRequest{Type: "canvas_video", Prompt: "local admission fixture", Model: modelName, Operation: "text_to_video", Input: map[string]any{"mode": "video", "prompt": "local admission fixture", "config": map[string]any{"channelId": "beefapi", "credentialRef": managedBeefAPIRef, "model": modelName, "interfaceType": "newapi", "videoSeconds": tc.seconds, "videoCapabilitiesVersion": "forged-request-version", "capabilityConfig": forged}}}
			task, err := svc.CreateTask("user", request)
			if err != nil || task == nil {
				t.Fatalf("task rejected: %v", err)
			}
			var saved generation.Input
			var stored model.Task
			if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(stored.InputJSON), &saved); err != nil {
				t.Fatal(err)
			}
			if tc.wantVersion == "" {
				if saved.Config.VideoCapabilitiesVersion != nil || saved.Config.CapabilityConfig != nil {
					t.Fatalf("forged declaration persisted when account catalog has no declaration: %+v", saved.Config)
				}
			} else if saved.Config.VideoCapabilitiesVersion == nil || strings.TrimSpace(*saved.Config.VideoCapabilitiesVersion) != tc.wantVersion || saved.Config.CapabilityConfig == nil || saved.Config.CapabilityConfig.Video == nil || saved.Config.CapabilityConfig.Video.Duration.Max != 3 {
				t.Fatal("task stored another declaration")
			}
			if upstreamCalls.Load() != 0 {
				t.Fatal("admission contacted an upstream generation endpoint")
			}
		})
	}
}
