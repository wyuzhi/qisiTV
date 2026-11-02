package generation

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"qisitv/backend/internal/protocol"
)

func TestApplyProtocolAuthJWTHS256SignsAccessAndSecretKey(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://api-beijing.klingai.com/v1/videos/text2video", nil)
	if err != nil {
		t.Fatal(err)
	}
	err = ApplyProtocolAuth(req, Config{
		BaseURL:   "https://api-beijing.klingai.com",
		APIKey:    "kling-ak-123",
		SecretKey: "kling-sk-456",
	}, protocol.ManifestAuth{
		Type:        "jwt-hs256",
		Field:       "apiKey",
		SecretField: "secretKey",
	})
	if err != nil {
		t.Fatalf("ApplyProtocolAuth(jwt-hs256) error = %v", err)
	}
	authHeader := req.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		t.Fatalf("Authorization = %q, want Bearer token", authHeader)
	}
	parts := strings.Split(strings.TrimPrefix(authHeader, "Bearer "), ".")
	if len(parts) != 3 {
		t.Fatalf("JWT parts = %d, want 3", len(parts))
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode JWT payload: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		t.Fatalf("unmarshal JWT payload: %v", err)
	}
	if payload["iss"] != "kling-ak-123" {
		t.Fatalf("JWT iss = %v, want kling-ak-123", payload["iss"])
	}
}

func TestApplyProtocolAuthJWTHS256FallsBackToBearerWhenSecretKeyEmpty(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://api-beijing.klingai.com/v1/videos/text2video", nil)
	if err != nil {
		t.Fatal(err)
	}
	err = ApplyProtocolAuth(req, Config{
		BaseURL: "https://api-beijing.klingai.com",
		APIKey:  "pre-signed-jwt-token",
	}, protocol.ManifestAuth{
		Type:        "jwt-hs256",
		Field:       "apiKey",
		SecretField: "secretKey",
	})
	if err != nil {
		t.Fatalf("ApplyProtocolAuth(jwt-hs256 fallback) error = %v", err)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer pre-signed-jwt-token" {
		t.Fatalf("Authorization = %q, want Bearer pre-signed-jwt-token", got)
	}
}
