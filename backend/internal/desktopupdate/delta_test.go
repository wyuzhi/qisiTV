package desktopupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBinaryPatchRoundTripAndBoundsSafety(t *testing.T) {
	rng := rand.New(rand.NewSource(20261031))
	oldData := make([]byte, 256*1024)
	rng.Read(oldData)

	// Simulate an executable update: insert 7 bytes (unaligned shift),
	// tweak a few relocation words in the middle, and append 120 bytes.
	var newBuf bytes.Buffer
	newBuf.Write(oldData[:4096])
	newBuf.Write([]byte("SHIFT7!"))
	mid := append([]byte(nil), oldData[4096:200*1024]...)
	for off := 1024; off+4 <= len(mid); off += 4096 {
		mid[off] += 4
	}
	newBuf.Write(mid)
	newBuf.Write(oldData[200*1024:])
	newBuf.WriteString(strings.Repeat("TAIL", 30))
	newData := newBuf.Bytes()

	patch, err := BuildBinaryPatch(oldData, newData)
	if err != nil {
		t.Fatalf("BuildBinaryPatch: %v", err)
	}
	if len(patch) >= len(newData)/10 {
		t.Fatalf("expected compact patch (<10%% of new size), got %d bytes for %d bytes", len(patch), len(newData))
	}
	rebuilt, err := ApplyBinaryPatch(oldData, patch)
	if err != nil {
		t.Fatalf("ApplyBinaryPatch: %v", err)
	}
	if !bytes.Equal(rebuilt, newData) {
		t.Fatal("rebuilt binary does not match newData")
	}

	// Reject malformed headers and out-of-bounds sizes.
	if _, err := ApplyBinaryPatch(oldData, []byte("short")); err == nil {
		t.Fatal("expected short patch to fail")
	}
	badHdr := append([]byte(nil), patch...)
	binary.LittleEndian.PutUint64(badHdr[8:16], maxZipEntry+1)
	if _, err := ApplyBinaryPatch(oldData, badHdr); err == nil {
		t.Fatal("expected oversized target size header to fail")
	}
	truncated := patch[:len(patch)-5]
	if _, err := ApplyBinaryPatch(oldData, truncated); err == nil {
		t.Fatal("expected truncated patch to fail")
	}
	trailing := append(append([]byte(nil), patch...), 0x00)
	if _, err := ApplyBinaryPatch(oldData, trailing); err == nil {
		t.Fatal("expected patch with trailing bytes to fail")
	}
}

func makeDeltaTestBundles(t *testing.T) (v1Zip, v2Zip, deltaZip string, v1AppDir string) {
	t.Helper()
	dir := t.TempDir()
	rng := rand.New(rand.NewSource(99))

	sharedNode := make([]byte, 128*1024)
	rng.Read(sharedNode)
	oldExe := make([]byte, 160*1024)
	rng.Read(oldExe)
	newExe := append([]byte("HEADER-SHIFT-3"), oldExe...)
	newExe[64*1024] ^= 0xff

	v1Files, v1Exec := DarwinZipFiles("OLD-V2.1.0")
	v1Files["qisiTV.app/Contents/MacOS/qisiTV"] = oldExe
	v1Files["qisiTV.app/Contents/Resources/agent-host/runtime/bin/node"] = sharedNode
	v1Files["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/index.js"] = []byte{}
	v1Zip = filepath.Join(dir, "qisiTV-v2.1.0-darwin-arm64.zip")
	if err := WriteZip(v1Zip, v1Files, v1Exec); err != nil {
		t.Fatal(err)
	}

	v2Files, v2Exec := DarwinZipFiles("NEW-V2.1.1")
	v2Files["qisiTV.app/Contents/MacOS/qisiTV"] = newExe
	v2Files["qisiTV.app/Contents/Resources/agent-host/runtime/bin/node"] = sharedNode
	v2Files["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/index.js"] = []byte{}
	v2Files["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/new-empty.js"] = []byte{}
	v2Files["qisiTV.app/Contents/Info.plist"] = []byte("<plist><string>v2.1.1</string></plist>")
	v2Zip = filepath.Join(dir, "qisiTV-v2.1.1-darwin-arm64.zip")
	if err := WriteZip(v2Zip, v2Files, v2Exec); err != nil {
		t.Fatal(err)
	}

	deltaZip = filepath.Join(dir, DeltaArtifactFileName("v2.1.1", "darwin-arm64", "v2.1.0"))
	if err := BuildDeltaZip("darwin-arm64", "v2.1.0", "v2.1.1", v1Zip, v2Zip, deltaZip); err != nil {
		t.Fatalf("BuildDeltaZip: %v", err)
	}

	installRoot := filepath.Join(dir, "installed")
	if err := extractSecureZip(v1Zip, installRoot, defaultExtractLimits()); err != nil {
		t.Fatal(err)
	}
	v1AppDir = filepath.Join(installRoot, "qisiTV.app")
	return v1Zip, v2Zip, deltaZip, v1AppDir
}

func TestBuildAndValidateDeltaZipOperations(t *testing.T) {
	_, _, deltaZip, _ := makeDeltaTestBundles(t)
	manifest, err := ValidateDeltaArchive("darwin-arm64", "v2.1.0", "v2.1.1", deltaZip)
	if err != nil {
		t.Fatalf("ValidateDeltaArchive: %v", err)
	}
	ops := make(map[string]string, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		ops[entry.Path] = entry.Op
	}
	if ops["qisiTV.app/Contents/Resources/agent-host/runtime/bin/node"] != "copy" {
		t.Fatalf("expected unchanged node binary to use op=copy, got %q", ops["qisiTV.app/Contents/Resources/agent-host/runtime/bin/node"])
	}
	if ops["qisiTV.app/Contents/MacOS/qisiTV"] != "patch" {
		t.Fatalf("expected changed main binary to use op=patch, got %q", ops["qisiTV.app/Contents/MacOS/qisiTV"])
	}
	if ops["qisiTV.app/Contents/Info.plist"] != "replace" {
		t.Fatalf("expected changed small Info.plist to use op=replace, got %q", ops["qisiTV.app/Contents/Info.plist"])
	}
	if ops["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/index.js"] != "copy" {
		t.Fatalf("expected unchanged 0-byte file to use op=copy, got %q", ops["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/index.js"])
	}
	if ops["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/new-empty.js"] != "replace" {
		t.Fatalf("expected new 0-byte file to use op=replace, got %q", ops["qisiTV.app/Contents/Resources/agent-host/node_modules/node-domexception/.history/new-empty.js"])
	}
}

func TestEnvelopeDeltaSchemaValidation(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	parsedPub, err := ParsePublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	validSHA := strings.Repeat("a", 64)
	r2Full := "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64.zip"
	cnbDelta := "https://cheeser.link/qisitv/releases/v2.1.1/qisiTV-v2.1.1-darwin-arm64-from-v2.1.0.delta.zip"
	r2Delta := "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64-from-v2.1.0.delta.zip"

	// Schema 1 must reject deltas.
	v1WithDelta := Payload{
		Schema:  payloadSchema,
		Version: "v2.1.1",
		Commit:  strings.Repeat("b", 40),
		Notes:   "notes",
		Platforms: map[string]PlatformArtifact{
			"darwin-arm64": {
				URL:    r2Full,
				SHA256: validSHA,
				Size:   1000,
				Deltas: map[string]DeltaArtifact{
					"v2.1.0": {URLs: []string{r2Delta}, SHA256: validSHA, Size: 100},
				},
			},
		},
	}
	rawV1, _ := SignEnvelope(priv, v1WithDelta)
	if _, _, err := verifyEnvelope(rawV1, parsedPub); err == nil {
		t.Fatal("expected schema 1 envelope with deltas to be rejected")
	}

	// Schema 2 accepts valid deltas and rejects fromVersion >= version.
	v2Valid := Payload{
		Schema:  payloadSchemaV2,
		Version: "v2.1.1",
		Commit:  strings.Repeat("b", 40),
		Notes:   "notes",
		Platforms: map[string]PlatformArtifact{
			"darwin-arm64": {
				URLs:   []string{r2Full},
				SHA256: validSHA,
				Size:   1000,
				Deltas: map[string]DeltaArtifact{
					"v2.1.0": {URLs: []string{cnbDelta, r2Delta}, SHA256: validSHA, Size: 100},
				},
			},
		},
	}
	rawV2, _ := SignEnvelope(priv, v2Valid)
	verified, _, err := verifyEnvelope(rawV2, parsedPub)
	if err != nil {
		t.Fatalf("expected valid schema 2 with deltas to pass: %v", err)
	}
	if len(verified.Platforms["darwin-arm64"].Deltas["v2.1.0"].URLs) != 2 {
		t.Fatal("expected delta URLs to be preserved")
	}

	v2BadFrom := v2Valid
	v2BadFrom.Platforms = map[string]PlatformArtifact{
		"darwin-arm64": {
			URLs:   []string{r2Full},
			SHA256: validSHA,
			Size:   1000,
			Deltas: map[string]DeltaArtifact{
				"v2.1.1": {URLs: []string{r2Delta}, SHA256: validSHA, Size: 100},
			},
		},
	}
	rawBadFrom, _ := SignEnvelope(priv, v2BadFrom)
	if _, _, err := verifyEnvelope(rawBadFrom, parsedPub); err == nil {
		t.Fatal("expected delta with fromVersion == version to fail")
	}
}

func TestEngineIncrementalUpdateAndFallbacks(t *testing.T) {
	_, v2Zip, deltaZip, v1AppDir := makeDeltaTestBundles(t)
	fullBytes, err := os.ReadFile(v2Zip)
	if err != nil {
		t.Fatal(err)
	}
	fullSum := sha256.Sum256(fullBytes)
	deltaBytes, err := os.ReadFile(deltaZip)
	if err != nil {
		t.Fatal(err)
	}
	deltaSum := sha256.Sum256(deltaBytes)

	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("happy-path-delta-without-touching-full-zip", func(t *testing.T) {
		dir := t.TempDir()
		appPath := filepath.Join(dir, "qisiTV.app")
		if err := copyTree(v1AppDir, appPath); err != nil {
			t.Fatal(err)
		}
		fullRequested := false
		deltaRequested := false
		server := newDeltaTestServer(t, priv, fullBytes, hex.EncodeToString(fullSum[:]), deltaBytes, hex.EncodeToString(deltaSum[:]),
			func() { deltaRequested = true },
			func() { fullRequested = true },
			false,
		)
		engine := newDeltaTestEngine(t, pub, server, appPath)

		state, err := engine.CheckForUpdate(context.Background())
		if err != nil {
			t.Fatalf("CheckForUpdate: %v", err)
		}
		if state.TotalBytes != int64(len(deltaBytes)) {
			t.Fatalf("expected CheckForUpdate TotalBytes=%d (delta), got %d", len(deltaBytes), state.TotalBytes)
		}
		state, err = engine.DownloadUpdate(context.Background())
		if err != nil {
			t.Fatalf("DownloadUpdate: %v", err)
		}
		if !deltaRequested || fullRequested {
			t.Fatalf("expected only delta requested (delta=%v, full=%v)", deltaRequested, fullRequested)
		}
		if state.DownloadedBytes != int64(len(deltaBytes)) {
			t.Fatalf("expected DownloadedBytes=%d, got %d", len(deltaBytes), state.DownloadedBytes)
		}
		if err := engine.InstallUpdate(context.Background()); err != nil {
			t.Fatalf("InstallUpdate: %v", err)
		}
		plist, err := os.ReadFile(filepath.Join(appPath, "Contents", "Info.plist"))
		if err != nil || !strings.Contains(string(plist), "v2.1.1") {
			t.Fatalf("expected upgraded Info.plist, got %q (%v)", string(plist), err)
		}
	})

	t.Run("fallback-to-full-zip-when-local-file-modified-before-download", func(t *testing.T) {
		dir := t.TempDir()
		appPath := filepath.Join(dir, "qisiTV.app")
		if err := copyTree(v1AppDir, appPath); err != nil {
			t.Fatal(err)
		}
		// Corrupt the local node binary before DownloadUpdate.
		if err := os.WriteFile(filepath.Join(appPath, "Contents", "Resources", "agent-host", "runtime", "bin", "node"), []byte("corrupted"), 0o755); err != nil {
			t.Fatal(err)
		}
		fullRequested := false
		deltaRequested := false
		server := newDeltaTestServer(t, priv, fullBytes, hex.EncodeToString(fullSum[:]), deltaBytes, hex.EncodeToString(deltaSum[:]),
			func() { deltaRequested = true },
			func() { fullRequested = true },
			false,
		)
		engine := newDeltaTestEngine(t, pub, server, appPath)

		if _, err := engine.CheckForUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		state, err := engine.DownloadUpdate(context.Background())
		if err != nil {
			t.Fatalf("DownloadUpdate should fall back to full zip, got error: %v", err)
		}
		if !deltaRequested || !fullRequested {
			t.Fatalf("expected delta attempt followed by full zip fallback (delta=%v, full=%v)", deltaRequested, fullRequested)
		}
		if state.TotalBytes != int64(len(fullBytes)) {
			t.Fatalf("expected fallback TotalBytes=%d, got %d", len(fullBytes), state.TotalBytes)
		}
		if err := engine.InstallUpdate(context.Background()); err != nil {
			t.Fatalf("InstallUpdate after fallback: %v", err)
		}
		plist, err := os.ReadFile(filepath.Join(appPath, "Contents", "Info.plist"))
		if err != nil || !strings.Contains(string(plist), "v2.1.1") {
			t.Fatalf("expected upgraded Info.plist after fallback, got %q", string(plist))
		}
	})

	t.Run("fallback-to-full-zip-when-delta-download-fails", func(t *testing.T) {
		dir := t.TempDir()
		appPath := filepath.Join(dir, "qisiTV.app")
		if err := copyTree(v1AppDir, appPath); err != nil {
			t.Fatal(err)
		}
		fullRequested := false
		server := newDeltaTestServer(t, priv, fullBytes, hex.EncodeToString(fullSum[:]), deltaBytes, hex.EncodeToString(deltaSum[:]),
			nil,
			func() { fullRequested = true },
			true, // fail delta HTTP with 404
		)
		engine := newDeltaTestEngine(t, pub, server, appPath)
		if _, err := engine.CheckForUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := engine.DownloadUpdate(context.Background()); err != nil {
			t.Fatalf("DownloadUpdate should fall back to full zip on 404: %v", err)
		}
		if !fullRequested {
			t.Fatal("expected full zip fallback to be requested")
		}
		if err := engine.InstallUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("fallback-to-full-zip-when-local-file-mutated-between-download-and-install", func(t *testing.T) {
		dir := t.TempDir()
		appPath := filepath.Join(dir, "qisiTV.app")
		if err := copyTree(v1AppDir, appPath); err != nil {
			t.Fatal(err)
		}
		fullRequested := false
		server := newDeltaTestServer(t, priv, fullBytes, hex.EncodeToString(fullSum[:]), deltaBytes, hex.EncodeToString(deltaSum[:]),
			nil,
			func() { fullRequested = true },
			false,
		)
		engine := newDeltaTestEngine(t, pub, server, appPath)
		if _, err := engine.CheckForUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := engine.DownloadUpdate(context.Background()); err != nil {
			t.Fatal(err)
		}
		if fullRequested {
			t.Fatal("full zip should not have been requested during DownloadUpdate")
		}
		// Mutate local binary after DownloadUpdate succeeded!
		if err := os.WriteFile(filepath.Join(appPath, "Contents", "MacOS", "qisiTV"), []byte("tampered-after-download"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := engine.InstallUpdate(context.Background()); err != nil {
			t.Fatalf("InstallUpdate should fall back to full archive when local file mutated after download: %v", err)
		}
		if !fullRequested {
			t.Fatal("expected InstallUpdate to fall back to downloading full zip")
		}
		plist, err := os.ReadFile(filepath.Join(appPath, "Contents", "Info.plist"))
		if err != nil || !strings.Contains(string(plist), "v2.1.1") {
			t.Fatalf("expected upgraded Info.plist, got %q", string(plist))
		}
	})
}

func newDeltaTestServer(
	t *testing.T,
	priv []byte,
	fullBytes []byte,
	fullSum string,
	deltaBytes []byte,
	deltaSum string,
	onDelta func(),
	onFull func(),
	failDelta bool,
) *httptest.Server {
	t.Helper()
	const (
		fullURL  = "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64.zip"
		deltaURL = "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64-from-v2.1.0.delta.zip"
	)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/wyuzhi/qisiTV/releases/download/desktop-update-v2.json":
			payload := Payload{
				Schema:  payloadSchemaV2,
				Version: "v2.1.1",
				Commit:  strings.Repeat("c", 40),
				Notes:   "v2.1.1 增量更新测试",
				Platforms: map[string]PlatformArtifact{
					"darwin-arm64": {
						URLs:   []string{fullURL},
						SHA256: fullSum,
						Size:   int64(len(fullBytes)),
						Deltas: map[string]DeltaArtifact{
							"v2.1.0": {
								URLs:   []string{deltaURL},
								SHA256: deltaSum,
								Size:   int64(len(deltaBytes)),
							},
						},
					},
				},
			}
			body, err := SignEnvelope(priv, payload)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
		case "/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64-from-v2.1.0.delta.zip":
			if onDelta != nil {
				onDelta()
			}
			if failDelta {
				http.NotFound(w, r)
				return
			}
			serveRange(w, r, deltaBytes)
		case "/wyuzhi/qisiTV/releases/download/v2.1.1/qisiTV-v2.1.1-darwin-arm64.zip":
			if onFull != nil {
				onFull()
			}
			serveRange(w, r, fullBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newDeltaTestEngine(t *testing.T, pub string, server *httptest.Server, appPath string) *Engine {
	t.Helper()
	serverHost := strings.TrimPrefix(server.URL, "https://")
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "example.com"
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, serverHost)
	}
	httpClient := &http.Client{
		Transport:     transport,
		CheckRedirect: httpsRedirects,
	}
	return NewWithOptions(Options{
		CurrentVersion: "v2.1.0",
		DataDir:        t.TempDir(),
		StagingRoot:    t.TempDir(),
		FeedURL:        "https://github.com/wyuzhi/qisiTV/releases/download/desktop-update-v2.json",
		PublicKey:      pub,
		Platform:       "darwin-arm64",
		Locale:         "en-US",
		Timezone:       "UTC",
		Client:         httpClient,
		Locate: func() (Target, error) {
			return Target{
				Platform:   "darwin-arm64",
				Kind:       "app",
				Path:       appPath,
				Executable: filepath.Join(appPath, "Contents", "MacOS", "qisiTV"),
				PluginDir:  filepath.Join(appPath, "Contents", "Resources", "plugin-packages"),
			}, nil
		},
		Helper: func(req HelperRequest) error {
			if err := SwapInstall(req); err != nil {
				return err
			}
			return os.WriteFile(req.PreparedPath, []byte("ok\n"), 0o600)
		},
		Quit: func() error { return nil },
	})
}

func TestWindowsEngineIncrementalUpdateAndFallback(t *testing.T) {
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	rng := rand.New(rand.NewSource(99))
	baseExe := make([]byte, 192*1024)
	_, _ = rng.Read(baseExe)
	copy(baseExe[:3], []byte("MZ-"))
	newExe := append([]byte(nil), baseExe...)
	copy(newExe[32768:], []byte("windows-v2.1.1-patched-segment"))

	v1Files, v1Exec := WindowsZipFiles("WIN-SHARED")
	v1Files[windowsExeName] = baseExe
	v2Files, v2Exec := WindowsZipFiles("WIN-SHARED")
	v2Files[windowsExeName] = newExe
	v2Files[pluginDirName+"/official.qisitv-plugin"] = []byte("official-v2.1.1")

	fromZip := filepath.Join(work, "qisiTV-v2.1.0-windows-amd64.zip")
	toZip := filepath.Join(work, "qisiTV-v2.1.1-windows-amd64.zip")
	deltaZip := filepath.Join(work, "qisiTV-v2.1.1-windows-amd64-from-v2.1.0.delta.zip")
	if err := WriteZip(fromZip, v1Files, v1Exec); err != nil {
		t.Fatal(err)
	}
	if err := WriteZip(toZip, v2Files, v2Exec); err != nil {
		t.Fatal(err)
	}
	if err := BuildDeltaZip("windows-amd64", "v2.1.0", "v2.1.1", fromZip, toZip, deltaZip); err != nil {
		t.Fatalf("BuildDeltaZip windows-amd64: %v", err)
	}
	manifest, err := ValidateDeltaArchive("windows-amd64", "v2.1.0", "v2.1.1", deltaZip)
	if err != nil {
		t.Fatalf("ValidateDeltaArchive windows-amd64: %v", err)
	}
	patched := 0
	for _, entry := range manifest.Entries {
		if entry.Op == "patch" {
			patched++
		}
	}
	if patched != 1 {
		t.Fatalf("expected 1 patched file (qisiTV.exe), got %d", patched)
	}
	v1Dir := filepath.Join(work, "v1")
	if err := extractSecureZip(fromZip, v1Dir, defaultExtractLimits()); err != nil {
		t.Fatal(err)
	}

	fullBytes, _ := os.ReadFile(toZip)
	fullSum := sha256.Sum256(fullBytes)
	deltaBytes, _ := os.ReadFile(deltaZip)
	deltaSum := sha256.Sum256(deltaBytes)

	const (
		fullURL  = "https://cheeser.link/qisitv/releases/v2.1.1/qisiTV-v2.1.1-windows-amd64.zip"
		deltaURL = "https://cheeser.link/qisitv/releases/v2.1.1/qisiTV-v2.1.1-windows-amd64-from-v2.1.0.delta.zip"
	)

	makeServer := func(onDelta, onFull func()) *httptest.Server {
		s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/wyuzhi/qisiTV/releases/download/desktop-update-v2.json":
				payload := Payload{
					Schema:  payloadSchemaV2,
					Version: "v2.1.1",
					Commit:  strings.Repeat("d", 40),
					Notes:   "Windows 增量更新测试",
					Platforms: map[string]PlatformArtifact{
						"windows-amd64": {
							URLs:   []string{fullURL},
							SHA256: hex.EncodeToString(fullSum[:]),
							Size:   int64(len(fullBytes)),
							Deltas: map[string]DeltaArtifact{
								"v2.1.0": {
									URLs:   []string{deltaURL},
									SHA256: hex.EncodeToString(deltaSum[:]),
									Size:   int64(len(deltaBytes)),
								},
							},
						},
					},
				}
				body, _ := SignEnvelope(priv, payload)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(body)
			case "/qisitv/releases/v2.1.1/qisiTV-v2.1.1-windows-amd64-from-v2.1.0.delta.zip":
				if onDelta != nil {
					onDelta()
				}
				serveRange(w, r, deltaBytes)
			case "/qisitv/releases/v2.1.1/qisiTV-v2.1.1-windows-amd64.zip":
				if onFull != nil {
					onFull()
				}
				serveRange(w, r, fullBytes)
			default:
				http.NotFound(w, r)
			}
		}))
		t.Cleanup(s.Close)
		return s
	}

	makeEngine := func(server *httptest.Server, installDir string) *Engine {
		serverHost := strings.TrimPrefix(server.URL, "https://")
		transport := server.Client().Transport.(*http.Transport).Clone()
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		transport.TLSClientConfig.ServerName = "example.com"
		transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, serverHost)
		}
		exePath := filepath.Join(installDir, windowsExeName)
		return NewWithOptions(Options{
			CurrentVersion: "v2.1.0",
			DataDir:        t.TempDir(),
			StagingRoot:    t.TempDir(),
			FeedURL:        "https://github.com/wyuzhi/qisiTV/releases/download/desktop-update-v2.json",
			PublicKey:      pub,
			Platform:       "windows-amd64",
			Locale:         "zh-CN",
			Timezone:       "Asia/Shanghai",
			Client:         &http.Client{Transport: transport, CheckRedirect: httpsRedirects},
			Locate: func() (Target, error) {
				return Target{
					Platform:   "windows-amd64",
					Kind:       "exe",
					Path:       exePath,
					Executable: exePath,
					PluginDir:  filepath.Join(installDir, pluginDirName),
				}, nil
			},
			Helper: func(req HelperRequest) error {
				if err := SwapInstall(req); err != nil {
					return err
				}
				return os.WriteFile(req.PreparedPath, []byte("ok\n"), 0o600)
			},
			Quit: func() error { return nil },
		})
	}

	// 1. Happy path on Windows layout: delta only, binary patch on qisiTV.exe
	installDir := filepath.Join(t.TempDir(), "qisiTV")
	if err := copyTree(v1Dir, installDir); err != nil {
		t.Fatal(err)
	}
	var deltaHit, fullHit bool
	engine := makeEngine(makeServer(func() { deltaHit = true }, func() { fullHit = true }), installDir)
	if _, err := engine.CheckForUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DownloadUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !deltaHit || fullHit {
		t.Fatalf("expected deltaHit=true fullHit=false, got delta=%v full=%v", deltaHit, fullHit)
	}
	if err := engine.InstallUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	upgradedExe, err := os.ReadFile(filepath.Join(installDir, windowsExeName))
	if err != nil || !bytes.Equal(upgradedExe, newExe) {
		t.Fatalf("qisiTV.exe binary patch mismatch after Windows incremental upgrade")
	}

	// 2. Fallback path on Windows layout: corrupt qisiTV.exe -> automatic fallback to full zip
	installDir2 := filepath.Join(t.TempDir(), "qisiTV-corrupt")
	if err := copyTree(v1Dir, installDir2); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir2, windowsExeName), []byte("MZ-corrupted"), 0o755); err != nil {
		t.Fatal(err)
	}
	deltaHit, fullHit = false, false
	engine2 := makeEngine(makeServer(func() { deltaHit = true }, func() { fullHit = true }), installDir2)
	if _, err := engine2.CheckForUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := engine2.DownloadUpdate(context.Background()); err != nil {
		t.Fatalf("expected fallback to full zip on corrupted Windows exe: %v", err)
	}
	if !deltaHit || !fullHit {
		t.Fatalf("expected both delta attempt and full fallback, got delta=%v full=%v", deltaHit, fullHit)
	}
	if err := engine2.InstallUpdate(context.Background()); err != nil {
		t.Fatal(err)
	}
	upgradedExe2, err := os.ReadFile(filepath.Join(installDir2, windowsExeName))
	if err != nil || !bytes.Equal(upgradedExe2, newExe) {
		t.Fatalf("qisiTV.exe mismatch after Windows full-zip fallback")
	}
}
