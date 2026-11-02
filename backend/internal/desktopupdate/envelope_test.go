package desktopupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestVerifyEnvelopeRejectsInvalidSignatureAndTamper(t *testing.T) {
	pubB64, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	key, err := ParsePublicKey(pubB64)
	if err != nil {
		t.Fatal(err)
	}
	payload := testPayload("v1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "notes")
	raw, err := SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, key); err != nil {
		t.Fatal(err)
	}

	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	payloadBytes, _ := base64.StdEncoding.DecodeString(env.Payload)
	payloadBytes[0] ^= 0xff
	env.Payload = base64.StdEncoding.EncodeToString(payloadBytes)
	tampered, _ := json.Marshal(env)
	if _, _, err := verifyEnvelope(tampered, key); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tamper = %v", err)
	}

	env.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	env.Payload = base64.StdEncoding.EncodeToString(mustMarshal(t, payload))
	badSig, _ := json.Marshal(env)
	if _, _, err := verifyEnvelope(badSig, key); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("bad signature = %v", err)
	}
}

func TestVerifyEnvelopeRejectsUnstableVersionAndShortCommit(t *testing.T) {
	_, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	payload := testPayload("1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	raw, err := SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected unstable version to fail")
	}
	payload = testPayload("v1.6.0-beta.1", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	raw, err = SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected prerelease to fail")
	}
	payload = testPayload("v1.6.0", "darwin-arm64", "https://example.com/a.zip", strings.Repeat("ab", 32), 12, "")
	payload.Commit = "abc123"
	raw, err = SignEnvelope(priv, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(raw, pub); err == nil {
		t.Fatal("expected short commit to fail")
	}
}

func TestUpdateStateJSONContract(t *testing.T) {
	data, err := json.Marshal(UpdateState{Status: StatusIdle, CurrentVersion: "v1.5.1"})
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	want := []string{"status", "currentVersion", "latestVersion", "releaseNotes", "downloadedBytes", "totalBytes", "bytesPerSecond", "reconnecting", "error"}
	if len(raw) != len(want) {
		t.Fatalf("fields = %v", raw)
	}
	for _, key := range want {
		if _, ok := raw[key]; !ok {
			t.Fatalf("missing %s in %s", key, data)
		}
	}
}

func TestVerifyEnvelopeV2MultiSourceAndStrictDomainValidation(t *testing.T) {
	pubB64, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	key, err := ParsePublicKey(pubB64)
	if err != nil {
		t.Fatal(err)
	}
	cnbURL := "https://cheeser.link/qisitv/releases/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
	r2URL := "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
	valid := Payload{
		Schema:  payloadSchemaV2,
		Version: "v2.1.0",
		Commit:  strings.Repeat("a", 40),
		Notes:   "支持国内源与 R2 自动回退",
		Platforms: map[string]PlatformArtifact{
			"darwin-arm64": {
				URLs:   []string{cnbURL, r2URL},
				SHA256: strings.Repeat("ab", 32),
				Size:   154446706,
			},
		},
	}
	raw, err := SignEnvelope(priv, valid)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := verifyEnvelope(raw, key)
	if err != nil {
		t.Fatalf("verify valid v2 envelope: %v", err)
	}
	art := got.Platforms["darwin-arm64"]
	if len(art.URLs) != 2 || art.URLs[0] != cnbURL || art.URLs[1] != r2URL || art.URL != cnbURL {
		t.Fatalf("unexpected v2 artifact: %+v", art)
	}

	invalidCases := []struct {
		name   string
		mutate func(*Payload)
	}{
		{
			name: "unknown domain in v2 urls",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URLs:   []string{"https://evil.example.com/qisitv/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip", r2URL},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "untrusted path on cheeser.link",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URLs:   []string{"https://cheeser.link/other-org/desktop/-/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "url with query string",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URLs:   []string{r2URL + "?token=1"},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "duplicate urls in v2",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URLs:   []string{r2URL, r2URL},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "empty urls in v2",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "legacy url field set in v2",
			mutate: func(p *Payload) {
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URL:    r2URL,
					URLs:   []string{r2URL},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
		{
			name: "v1 schema with urls field",
			mutate: func(p *Payload) {
				p.Schema = payloadSchema
				p.Platforms["darwin-arm64"] = PlatformArtifact{
					URL:    r2URL,
					URLs:   []string{r2URL},
					SHA256: strings.Repeat("ab", 32),
					Size:   123,
				}
			},
		},
	}
	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			candidate := valid
			candidate.Platforms = map[string]PlatformArtifact{
				"darwin-arm64": valid.Platforms["darwin-arm64"],
			}
			tc.mutate(&candidate)
			signed, err := SignEnvelope(priv, candidate)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := verifyEnvelope(signed, key); err == nil {
				t.Fatalf("expected %s to fail verification", tc.name)
			}
		})
	}

	unknownFieldPayload := []byte(`{"schema":2,"version":"v2.1.0","commit":"` + strings.Repeat("a", 40) + `","notes":"n","extra":1,"platforms":{"darwin-arm64":{"urls":["` + r2URL + `"],"sha256":"` + strings.Repeat("ab", 32) + `","size":100}}}`)
	signedUnknown, err := SignEnvelopeBytes(priv, unknownFieldPayload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEnvelope(signedUnknown, key); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("unknown field in v2 payload = %v, want ErrInvalidSignature", err)
	}
}

func TestLegacySchema1EnvelopeReadableByV206StrictParser(t *testing.T) {
	pubB64, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	key, err := ParsePublicKey(pubB64)
	if err != nil {
		t.Fatal(err)
	}
	r2URL := "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-windows-amd64.zip"
	v1Payload := testPayload("v2.1.0", "windows-amd64", r2URL, strings.Repeat("cd", 32), 280362215, "兼容 v2.0.6 旧客户端")
	raw, err := SignEnvelope(priv, v1Payload)
	if err != nil {
		t.Fatal(err)
	}

	// Exact v2.0.6 wire structs and strict decoder contract.
	type v206PlatformArtifact struct {
		URL    string `json:"url"`
		SHA256 string `json:"sha256"`
		Size   int64  `json:"size"`
	}
	type v206Payload struct {
		Schema    int                             `json:"schema"`
		Version   string                          `json:"version"`
		Commit    string                          `json:"commit"`
		Notes     string                          `json:"notes"`
		Platforms map[string]v206PlatformArtifact `json:"platforms"`
	}
	var env Envelope
	if err := decodeJSONStrict(raw, &env); err != nil {
		t.Fatalf("v2.0.6 envelope decode failed: %v", err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil || !ed25519.Verify(key, payloadBytes, sig) {
		t.Fatal("v2.0.6 signature verification failed")
	}
	var legacy v206Payload
	if err := decodeJSONStrict(payloadBytes, &legacy); err != nil {
		t.Fatalf("v2.0.6 strict payload decode failed on v1 manifest: %v (json=%s)", err, payloadBytes)
	}
	if legacy.Schema != 1 || legacy.Platforms["windows-amd64"].URL != r2URL {
		t.Fatalf("unexpected v2.0.6 decoded payload: %+v", legacy)
	}
}

func TestSourceOrderingByMainlandChinaLocaleAndTimezone(t *testing.T) {
	cnbURL := "https://cheeser.link/qisitv/releases/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
	r2URL := "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
	input := []string{r2URL, cnbURL}

	cases := []struct {
		name       string
		locale     string
		timezone   string
		wantFirst  string
		wantSecond string
	}{
		{"zh-CN locale with UTC timezone", "zh-CN", "UTC", cnbURL, r2URL},
		{"zh_CN.UTF-8 locale with America/New_York", "zh_CN.UTF-8", "America/New_York", cnbURL, r2URL},
		{"zh-Hans-CN locale", "zh-Hans-CN", "Europe/London", cnbURL, r2URL},
		{"en-US locale with Asia/Shanghai timezone", "en-US", "Asia/Shanghai", cnbURL, r2URL},
		{"en-US locale with China Standard Time", "en-US", "China Standard Time", cnbURL, r2URL},
		{"en-US locale with macOS localtime symlink path", "en-US", "/var/db/timezone/zoneinfo/Asia/Shanghai", cnbURL, r2URL},
		{"en-US locale with UTC timezone", "en-US", "UTC", r2URL, cnbURL},
		{"ja-JP locale with Asia/Tokyo timezone", "ja-JP", "Asia/Tokyo", r2URL, cnbURL},
		{"zh-TW locale with Asia/Taipei timezone", "zh-TW", "Asia/Taipei", r2URL, cnbURL},
		{"zh-HK locale with Asia/Hong_Kong timezone", "zh-HK", "Asia/Hong_Kong", r2URL, cnbURL},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			preferCN := preferDomesticSource(tc.locale, tc.timezone)
			ordered := orderArtifactURLs(input, preferCN)
			if len(ordered) != 2 || ordered[0] != tc.wantFirst || ordered[1] != tc.wantSecond {
				t.Fatalf("orderArtifactURLs(%q, %q) = %v, want [%s, %s]", tc.locale, tc.timezone, ordered, tc.wantFirst, tc.wantSecond)
			}
		})
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
