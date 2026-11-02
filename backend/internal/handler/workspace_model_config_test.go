package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

func TestWorkspaceModelConfigReturnsPreferredMediaServicesAndPersistenceMetadata(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	data := modelConfigResponseData(t, recorder)
	if data["health"] != string(workspace.ConfigHealthDefault) || data["revision"] != float64(0) || data["source"] != "builtin+local" {
		t.Fatalf("missing persistence metadata: %#v", data)
	}
	config, _ := data["config"].(map[string]any)
	channels, _ := config["channels"].([]any)
	if len(channels) != 2 || channels[0].(map[string]any)["id"] != "qisi-api" || channels[1].(map[string]any)["id"] != "likeai" {
		t.Fatalf("preferred independent media services missing: %#v", channels)
	}
	if models, _ := channels[0].(map[string]any)["models"].([]any); len(models) != 0 {
		t.Fatalf("model catalog must remain dynamic: %#v", models)
	}
}

func TestWorkspaceModelConfigGETRedactsBeefAPIKey(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "local-secret-key")
	if first.Code != http.StatusOK {
		t.Fatalf("put status = %d body=%s", first.Code, first.Body.String())
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if bytes.Contains(recorder.Body.Bytes(), []byte("local-secret-key")) {
		t.Fatalf("model-config leaked api key: %s", recorder.Body.String())
	}
	stale := putModelConfig(t, router, 1, "ui-overwrite")
	if stale.Code != http.StatusOK {
		t.Fatalf("second put status = %d body=%s", stale.Code, stale.Body.String())
	}
}

func TestWorkspaceModelConfigRejectsStaleRevisionWithoutLeakingSecrets(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)
	first := putModelConfig(t, router, 0, "first-secret")
	if first.Code != http.StatusOK {
		t.Fatalf("first put status = %d body=%s", first.Code, first.Body.String())
	}
	if revision := modelConfigResponseData(t, first)["revision"]; revision != float64(1) {
		t.Fatalf("committed revision = %#v", revision)
	}

	stale := putModelConfig(t, router, 0, "must-not-leak")
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale put status = %d body=%s", stale.Code, stale.Body.String())
	}
	if bytes.Contains(stale.Body.Bytes(), []byte("must-not-leak")) || bytes.Contains(stale.Body.Bytes(), []byte("first-secret")) {
		t.Fatalf("error response leaked a secret: %s", stale.Body.String())
	}
}

func newModelConfigTestRouter(t *testing.T) (*gin.Engine, *workspace.ProviderConfig) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	store, err := workspace.NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	service := app.NewLocal(nil, dir)
	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dir}))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{ProviderConfig: store}))
	RegisterWorkspaceRoutes(router.Group("/api"), service)
	return router, store
}

func putModelConfig(t *testing.T, router *gin.Engine, expectedRevision int64, apiKey string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"expectedRevision": expectedRevision,
		"config":           map[string]any{"channels": []any{map[string]any{"id": "beefapi", "apiKey": apiKey, "enabled": true}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	return recorder
}

func modelConfigResponseData(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func TestWorkspaceModelConfigCapabilityNormalizesDrafts(t *testing.T) {
	router, _ := newModelConfigTestRouter(t)

	cases := []struct {
		name       string
		payload    map[string]any
		wantStatus int
		check      func(t *testing.T, data map[string]any)
	}{
		{
			name: "unsaved custom Seedance 2.5 draft returns tightened video capability and taskTypeConstraints",
			payload: map[string]any{
				"type":          "video",
				"interfaceType": "newapi-channel-2",
				"model":         "bytedance/dreamina-seedance-2-5-flash",
				"baseUrl":       "https://beefapi.com/v1",
				"capabilityConfig": map[string]any{
					"version": 1,
					"video": map[string]any{
						"operations":        []string{"text_to_video", "reference_to_video"},
						"defaultOperation":  "text_to_video",
						"duration":          map[string]any{"selection": "range", "min": 1, "max": 15, "step": 1, "default": 2},
						"ratios":            []string{"16:9"},
						"defaultRatio":      "16:9",
						"resolutions":       []string{"480p", "720p"},
						"defaultResolution": "720p",
						"references": map[string]any{
							"maxImages":               30,
							"maxVideos":               10,
							"maxAudios":               10,
							"minVideoDurationSeconds": 1,
							"maxVideoDurationSeconds": 15,
							"minAudioDurationSeconds": 1,
							"maxAudioDurationSeconds": 15,
						},
					},
				},
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, data map[string]any) {
				video, ok := data["video"].(map[string]any)
				if !ok {
					t.Fatalf("missing video capability: %#v", data)
				}
				if video["taskTypeConstraints"] != true {
					t.Fatalf("taskTypeConstraints = %#v, want true", video["taskTypeConstraints"])
				}
				duration, _ := video["duration"].(map[string]any)
				if duration["min"] != float64(4) || duration["default"] != float64(4) {
					t.Fatalf("duration not tightened to 4s floor: %#v", duration)
				}
				refs, _ := video["references"].(map[string]any)
				if refs["minAudioDurationSeconds"] != float64(2) || refs["minVideoDurationSeconds"] != float64(1) {
					t.Fatalf("reference audio/video floors not tightened: %#v", refs)
				}
				if refs["minVideoPixels"] != float64(407696) {
					t.Fatalf("minVideoPixels = %#v, want 407696", refs["minVideoPixels"])
				}
			},
		},
		{
			name: "openai-response text draft returns thinking=true",
			payload: map[string]any{
				"category": "text",
				"protocol": "openai-response",
				"model":    "gpt-5.4",
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, data map[string]any) {
				text, ok := data["text"].(map[string]any)
				if !ok || text["thinking"] != true {
					t.Fatalf("text capability = %#v, want thinking=true", data["text"])
				}
			},
		},
		{
			name: "invalid capability category returns 400",
			payload: map[string]any{
				"category": "invalid-capability",
				"protocol": "openai",
				"model":    "gpt-4o",
			},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/workspace/model-config/capability", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, req)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.wantStatus, recorder.Body.String())
			}
			if tc.check != nil {
				tc.check(t, modelConfigResponseData(t, recorder))
			}
		})
	}
}
