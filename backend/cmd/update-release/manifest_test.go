package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testCommit = "0123456789abcdef0123456789abcdef01234567"

func TestSignVerifyRoundTripAndTamper(t *testing.T) {
	t.Setenv("QISITV_UPDATER_DOWNLOAD_BASE", "https://updates.example.com/qisitv")
	dir := t.TempDir()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(dir, "private")
	if err := writeKeyFile(privatePath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	darwinZip := packageNamed(t, dir, platformDarwinARM64, "v1.6.0")
	windowsZip := packageNamed(t, dir, platformWindowsAMD64, "v1.6.0")
	amdZip := packageNamed(t, dir, platformDarwinAMD64, "v1.6.0")
	notesPath := filepath.Join(dir, "CHANGELOG.md")
	if err := os.WriteFile(notesPath, []byte("## v1.6.0\n\n- Keep projects and settings.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	envelopePath := filepath.Join(dir, "desktop-update.json")
	var stdout bytes.Buffer
	args := []string{
		"sign",
		"--version", "v1.6.0",
		"--commit", testCommit,
		"--changelog", notesPath,
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", envelopePath,
		"--require-platforms", "darwin-arm64,darwin-amd64,windows-amd64",
		"--asset", "darwin-arm64=" + darwinZip,
		"--asset", "darwin-amd64=" + amdZip,
		"--asset", "windows-amd64=" + windowsZip,
	}
	if err := run(args, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "platforms=3") {
		t.Fatalf("expected 3 platforms, got %q", stdout.String())
	}

	var verifyOut bytes.Buffer
	if err := run([]string{"verify", "--envelope", envelopePath, "--public-key-text", encodeKey(public)}, &verifyOut, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(verifyOut.String(), "version=v1.6.0") {
		t.Fatalf("verify stdout %q", verifyOut.String())
	}

	raw, err := os.ReadFile(envelopePath)
	if err != nil {
		t.Fatal(err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var body payload
	if err := json.Unmarshal(payloadBytes, &body); err != nil {
		t.Fatal(err)
	}
	if body.Schema != 1 || body.Version != "v1.6.0" || body.Commit != testCommit {
		t.Fatalf("unexpected payload %#v", body)
	}
	if body.Notes != "- Keep projects and settings." {
		t.Fatalf("notes %q", body.Notes)
	}
	asset := body.Platforms[platformDarwinARM64]
	if asset.URL != "https://updates.example.com/qisitv/v1.6.0/qisiTV-v1.6.0-darwin-arm64.zip" {
		t.Fatalf("url %q", asset.URL)
	}
	if asset.Size <= 0 || len(asset.SHA256) != 64 {
		t.Fatalf("asset metadata %#v", asset)
	}

	tamperedPayload := append([]byte{}, payloadBytes...)
	tamperedPayload[len(tamperedPayload)-2] ^= 0x01
	tamperedEnv := envelope{Payload: base64.StdEncoding.EncodeToString(tamperedPayload), Signature: env.Signature}
	tamperedPath := filepath.Join(dir, "tampered-payload.json")
	writeJSON(t, tamperedPath, tamperedEnv)
	if err := run([]string{"verify", "--envelope", tamperedPath, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("tampered payload should fail verification")
	}

	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 0x01
	tamperedSig := envelope{Payload: env.Payload, Signature: base64.StdEncoding.EncodeToString(sig)}
	sigPath := filepath.Join(dir, "tampered-sig.json")
	writeJSON(t, sigPath, tamperedSig)
	if err := run([]string{"verify", "--envelope", sigPath, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("tampered signature should fail verification")
	}

	_, otherPrivate, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	wrongPublic := otherPrivate.Public().(ed25519.PublicKey)
	if err := run([]string{"verify", "--envelope", envelopePath, "--public-key-text", encodeKey(wrongPublic)}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("wrong public key should fail verification")
	}
}

func TestSignRejectsInvalidInputs(t *testing.T) {
	t.Setenv("QISITV_UPDATER_DOWNLOAD_BASE", "https://updates.example.com/qisitv")
	dir := t.TempDir()
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(dir, "private")
	if err := writeKeyFile(privatePath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	zipPath := packageNamed(t, dir, platformDarwinARM64, "v1.6.0")
	out := filepath.Join(dir, "desktop-update.json")
	base := []string{"sign", "--private-key", privatePath, "--output", out, "--notes", "notes", "--asset", "darwin-arm64=" + zipPath}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"prerelease", append([]string{"sign", "--version", "v1.6.0-rc.1", "--commit", testCommit}, base[1:]...), "stable"},
		{"short commit", append([]string{"sign", "--version", "v1.6.0", "--commit", "abc123"}, base[1:]...), "full"},
		{"missing notes", []string{"sign", "--version", "v1.6.0", "--commit", testCommit, "--private-key", privatePath, "--output", out, "--asset", "darwin-arm64=" + zipPath}, "notes"},
		{"wrong name", []string{"sign", "--version", "v1.7.0", "--commit", testCommit, "--notes", "n", "--private-key", privatePath, "--output", out, "--asset", "darwin-arm64=" + zipPath}, "must be named"},
		{"missing required platform", []string{"sign", "--version", "v1.6.0", "--commit", testCommit, "--notes", "n", "--private-key", privatePath, "--output", out, "--require-platforms", "windows-amd64", "--asset", "darwin-arm64=" + zipPath}, "requires platform"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := run(tc.args, ioDiscard{}, ioDiscard{})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.want)) {
				t.Fatalf("expected error containing %q, got %v", tc.want, err)
			}
		})
	}

	_, other, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	err = run([]string{
		"sign", "--version", "v1.6.0", "--commit", testCommit, "--notes", "n",
		"--private-key", privatePath, "--expect-public-key", encodeKey(other.Public().(ed25519.PublicKey)),
		"--output", out, "--asset", "darwin-arm64=" + zipPath,
	}, ioDiscard{}, ioDiscard{})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected public mismatch, got %v", err)
	}
}

func TestPrintLdflags(t *testing.T) {
	public := encodeKey(bytes.Repeat([]byte{1}, ed25519.PublicKeySize))
	var stdout bytes.Buffer
	if err := run([]string{"print-ldflags", "--public-key", public, "--feed-url", "https://updates.example.com/qisitv/desktop-update.json"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(stdout.String())
	if !strings.Contains(got, "qisitv/backend/internal/desktopupdate.FeedURL=https://updates.example.com/qisitv/desktop-update.json") {
		t.Fatalf("missing feed ldflag: %s", got)
	}
	if !strings.Contains(got, "qisitv/backend/internal/desktopupdate.PublicKey="+public) {
		t.Fatalf("missing public key ldflag: %s", got)
	}
	t.Setenv(publicKeyEnv, public)
	t.Setenv("BEEFTV_UPDATER_FEED_URL", "https://example.com/desktop-update.json")
	stdout.Reset()
	if err := run([]string{"print-ldflags"}, &stdout, ioDiscard{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "FeedURL=https://example.com/desktop-update.json") {
		t.Fatalf("expected env feed URL, got %s", stdout.String())
	}
	t.Setenv(publicKeyEnv, "")
	if err := run([]string{"print-ldflags"}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected missing public key to fail")
	}
}

func TestSignSchema2AndFromEnvelopeWithDomesticMirror(t *testing.T) {
	t.Setenv("QISITV_UPDATER_DOWNLOAD_BASE", "https://github.com/wyuzhi/qisiTV/releases/download")
	dir := t.TempDir()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privatePath := filepath.Join(dir, "private")
	if err := writeKeyFile(privatePath, encodeKey(private), 0o600); err != nil {
		t.Fatal(err)
	}
	darwinZip := packageNamed(t, dir, platformDarwinARM64, "v2.1.0")
	windowsZip := packageNamed(t, dir, platformWindowsAMD64, "v2.1.0")
	v1Path := filepath.Join(dir, "desktop-update.json")
	if err := run([]string{
		"sign",
		"--version", "v2.1.0",
		"--commit", testCommit,
		"--notes", "v2.1.0 release notes",
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", v1Path,
		"--require-platforms", "darwin-arm64,windows-amd64",
		"--asset", "darwin-arm64=" + darwinZip,
		"--asset", "windows-amd64=" + windowsZip,
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("sign v1: %v", err)
	}

	// Schema-2 R2-only (before domestic mirror verification completes)
	v2R2Path := filepath.Join(dir, "desktop-update-v2-r2.json")
	if err := run([]string{
		"sign",
		"--schema", "2",
		"--from-envelope", v1Path,
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", v2R2Path,
		"--require-platforms", "darwin-arm64,windows-amd64",
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("sign v2 r2-only: %v", err)
	}
	r2Body, err := verifyEnvelopeFile(v2R2Path, public)
	if err != nil {
		t.Fatalf("verify v2 r2-only: %v", err)
	}
	if r2Body.Schema != 2 || len(r2Body.Platforms[platformDarwinARM64].URLs) != 1 || r2Body.Platforms[platformDarwinARM64].URL != "" {
		t.Fatalf("unexpected v2 r2-only payload: %#v", r2Body)
	}

	// Schema-2 with verified domestic CNB mirror + R2 fallback
	v2DomesticPath := filepath.Join(dir, "desktop-update-v2.json")
	if err := run([]string{
		"sign",
		"--schema", "2",
		"--from-envelope", v1Path,
		"--domestic-download-base", "https://cheeser.link/qisitv/releases",
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", v2DomesticPath,
		"--require-platforms", "darwin-arm64,windows-amd64",
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("sign v2 domestic+r2: %v", err)
	}
	if err := run([]string{"verify", "--envelope", v2DomesticPath, "--public-key-text", encodeKey(public)}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("verify CLI v2 domestic+r2: %v", err)
	}
	domBody, err := verifyEnvelopeFile(v2DomesticPath, public)
	if err != nil {
		t.Fatal(err)
	}
	wantURLs := []string{
		"https://cheeser.link/qisitv/releases/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip",
		"https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip",
	}
	gotURLs := domBody.Platforms[platformDarwinARM64].URLs
	if len(gotURLs) != 2 || gotURLs[0] != wantURLs[0] || gotURLs[1] != wantURLs[1] {
		t.Fatalf("got URLs %v, want %v", gotURLs, wantURLs)
	}

	// Reject unknown domain in schema 2
	if err := run([]string{
		"sign",
		"--schema", "2",
		"--from-envelope", v1Path,
		"--domestic-download-base", "https://evil.example.com/qisitv",
		"--private-key", privatePath,
		"--output", filepath.Join(dir, "bad.json"),
	}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected untrusted domestic domain to fail")
	}

	// Reject --domestic-download-base on schema 1
	if err := run([]string{
		"sign",
		"--schema", "1",
		"--version", "v2.1.0",
		"--commit", testCommit,
		"--notes", "n",
		"--domestic-download-base", "https://cheeser.link/qisitv/releases",
		"--private-key", privatePath,
		"--output", filepath.Join(dir, "bad-v1.json"),
		"--asset", "darwin-arm64=" + darwinZip,
	}, ioDiscard{}, ioDiscard{}); err == nil {
		t.Fatal("expected --domestic-download-base with --schema 1 to fail")
	}

	// Build delta from v2.0.6 -> v2.1.0, verify-delta, and sign schema-2 with --delta
	prevZip := packageNamed(t, dir, platformDarwinARM64, "v2.0.6")
	deltaPath := filepath.Join(dir, deltaArtifactFileName("v2.1.0", platformDarwinARM64, "v2.0.6"))
	if err := run([]string{
		"build-delta",
		"--platform", platformDarwinARM64,
		"--from-version", "v2.0.6",
		"--to-version", "v2.1.0",
		"--from-zip", prevZip,
		"--to-zip", darwinZip,
		"--output", deltaPath,
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("build-delta: %v", err)
	}
	if err := run([]string{
		"verify-delta",
		"--platform", platformDarwinARM64,
		"--from-version", "v2.0.6",
		"--to-version", "v2.1.0",
		"--input", deltaPath,
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("verify-delta: %v", err)
	}

	v2DeltaR2Path := filepath.Join(dir, "desktop-update-v2-delta-r2.json")
	if err := run([]string{
		"sign",
		"--schema", "2",
		"--version", "v2.1.0",
		"--from-envelope", v1Path,
		"--delta", platformDarwinARM64 + "=v2.0.6=" + deltaPath,
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", v2DeltaR2Path,
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("sign schema 2 with --delta: %v", err)
	}

	v2DeltaDomPath := filepath.Join(dir, "desktop-update-v2-delta-dom.json")
	if err := run([]string{
		"sign",
		"--schema", "2",
		"--version", "v2.1.0",
		"--from-envelope", v2DeltaR2Path,
		"--domestic-download-base", "https://cheeser.link/qisitv/releases",
		"--private-key", privatePath,
		"--expect-public-key", encodeKey(public),
		"--output", v2DeltaDomPath,
	}, ioDiscard{}, ioDiscard{}); err != nil {
		t.Fatalf("sign schema 2 preserving delta with domestic base: %v", err)
	}
	deltaDomBody, err := verifyEnvelopeFile(v2DeltaDomPath, public)
	if err != nil {
		t.Fatal(err)
	}
	gotDeltaURLs := deltaDomBody.Platforms[platformDarwinARM64].Deltas["v2.0.6"].URLs
	wantDeltaURLs := []string{
		"https://cheeser.link/qisitv/releases/v2.1.0/qisiTV-v2.1.0-darwin-arm64-from-v2.0.6.delta.zip",
		"https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64-from-v2.0.6.delta.zip",
	}
	if len(gotDeltaURLs) != 2 || gotDeltaURLs[0] != wantDeltaURLs[0] || gotDeltaURLs[1] != wantDeltaURLs[1] {
		t.Fatalf("got delta URLs %v, want %v", gotDeltaURLs, wantDeltaURLs)
	}
}

func packageNamed(t *testing.T, dir, platform, version string) string {
	t.Helper()
	// Signing validates the archive independently of the build host. Set Unix
	// modes in the fixture itself so the macOS contract is also tested on Windows.
	out := filepath.Join(dir, artifactFileName(version, platform))
	if platform == platformDarwinARM64 || platform == platformDarwinAMD64 {
		file, err := os.Create(out)
		if err != nil {
			t.Fatal(err)
		}
		writer := zip.NewWriter(file)
		for name, body := range map[string]string{
			"qisiTV.app/Contents/MacOS/qisiTV":                                                                   "binary-" + version,
			"qisiTV.app/Contents/MacOS/cli/qisitv":                                                               "cli",
			"qisiTV.app/Contents/Info.plist":                                                                     "<plist>" + version + "</plist>",
			"qisiTV.app/Contents/Resources/plugin-packages/core.qisitv-plugin":                                   "plugin",
			"qisiTV.app/Contents/Resources/agent-host/server.mjs":                                                "host",
			"qisiTV.app/Contents/Resources/agent-host/session-identity.mjs":                                      "identity",
			"qisiTV.app/Contents/Resources/agent-host/canvas-turn.mjs":                                           "turn",
			"qisiTV.app/Contents/Resources/agent-host/request-budget.mjs":                                        "budget",
			"qisiTV.app/Contents/Resources/agent-host/package.json":                                              "{}",
			"qisiTV.app/Contents/Resources/agent-host/runtime/bin/node":                                          "node",
			"qisiTV.app/Contents/Resources/agent-host/node_modules/@earendil-works/pi-coding-agent/package.json": "{}",
		} {
			header := &zip.FileHeader{Name: name, Method: zip.Deflate}
			header.SetMode(0o755)
			entry, err := writer.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte(body)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	input := filepath.Join(dir, platform+"-src")
	if err := os.MkdirAll(input, 0o755); err != nil {
		t.Fatal(err)
	}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		writeFakeDarwinApp(t, filepath.Join(input, "qisiTV.app"))
	case platformWindowsAMD64:
		writeFakeWindowsBin(t, input)
	}
	if err := packageBundle(platform, input, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := marshalCanonical(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
