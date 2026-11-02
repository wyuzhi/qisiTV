package desktopupdate

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type multiSourceFixture struct {
	engine       *Engine
	zip          []byte
	sum          string
	root         string
	dataDir      string
	mu           sync.Mutex
	cnbRanges    []string
	assetRanges  []string
	r2Ranges     []string
	requestOrder []string
}

type multiSourceConfig struct {
	locale              string
	timezone            string
	idleTimeout         time.Duration
	minSpeedBytesPerSec int64
	slowSpeedWindow     time.Duration
	serveCNB            func(w http.ResponseWriter, r *http.Request, zip []byte, call int)
	serveAsset          func(w http.ResponseWriter, r *http.Request, zip []byte, call int)
	serveR2             func(w http.ResponseWriter, r *http.Request, zip []byte, call int)
}

func newMultiSourceFixture(t *testing.T, cfg multiSourceConfig) *multiSourceFixture {
	t.Helper()
	pub, priv, err := GenerateTestKey()
	if err != nil {
		t.Fatal(err)
	}
	files, execFiles := DarwinZipFiles("NEW-V2")
	padding := make([]byte, 256*1024)
	rand.New(rand.NewSource(42)).Read(padding)
	files["qisiTV.app/Contents/Resources/padding.bin"] = padding
	zipPath := filepath.Join(t.TempDir(), "app.zip")
	if err := WriteZip(zipPath, files, execFiles); err != nil {
		t.Fatal(err)
	}
	zipBytes, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(zipBytes)
	f := &multiSourceFixture{
		zip:     zipBytes,
		sum:     hex.EncodeToString(digest[:]),
		root:    t.TempDir(),
		dataDir: t.TempDir(),
	}

	const (
		cnbZipURL = "https://cheeser.link/qisitv/releases/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
		r2ZipURL  = "https://github.com/wyuzhi/qisiTV/releases/download/v2.1.0/qisiTV-v2.1.0-darwin-arm64.zip"
		feedURL   = "https://github.com/wyuzhi/qisiTV/releases/download/desktop-update-v2.json"
	)

	var cnbCalls, assetCalls, r2Calls int

	assetServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		assetCalls++
		call := assetCalls
		f.assetRanges = append(f.assetRanges, r.Header.Get("Range"))
		f.requestOrder = append(f.requestOrder, "release-assets.githubusercontent.com")
		f.mu.Unlock()
		if cfg.serveAsset != nil {
			cfg.serveAsset(w, r, zipBytes, call)
			return
		}
		serveRange(w, r, zipBytes)
	}))
	t.Cleanup(assetServer.Close)

	cnbServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		cnbCalls++
		call := cnbCalls
		f.cnbRanges = append(f.cnbRanges, r.Header.Get("Range"))
		f.requestOrder = append(f.requestOrder, "cheeser.link")
		f.mu.Unlock()
		if cfg.serveCNB != nil {
			cfg.serveCNB(w, r, zipBytes, call)
			return
		}
		http.Redirect(w, r, "https://release-assets.githubusercontent.com/assets/t/token-"+strconv.Itoa(call), http.StatusFound)
	}))
	t.Cleanup(cnbServer.Close)

	r2Server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wyuzhi/qisiTV/releases/download/desktop-update-v2.json" {
			payload := Payload{
				Schema:  payloadSchemaV2,
				Version: "v2.1.0",
				Commit:  strings.Repeat("b", 40),
				Notes:   "v2.1.0 国内源与 R2 双源自动回退",
				Platforms: map[string]PlatformArtifact{
					"darwin-arm64": {
						URLs:   []string{cnbZipURL, r2ZipURL},
						SHA256: f.sum,
						Size:   int64(len(zipBytes)),
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
			return
		}
		f.mu.Lock()
		r2Calls++
		call := r2Calls
		f.r2Ranges = append(f.r2Ranges, r.Header.Get("Range"))
		f.requestOrder = append(f.requestOrder, "github.com")
		f.mu.Unlock()
		if cfg.serveR2 != nil {
			cfg.serveR2(w, r, zipBytes, call)
			return
		}
		serveRange(w, r, zipBytes)
	}))
	t.Cleanup(r2Server.Close)

	pool := x509.NewCertPool()
	pool.AddCert(assetServer.Certificate())
	pool.AddCert(cnbServer.Certificate())
	pool.AddCert(r2Server.Certificate())

	hostAddrs := map[string]string{
		"cheeser.link":                         cnbServer.Listener.Addr().String(),
		"release-assets.githubusercontent.com": assetServer.Listener.Addr().String(),
		"github.com":                           r2Server.Listener.Addr().String(),
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:            pool,
			InsecureSkipVerify: true, // httptest certs are bound to 127.0.0.1
		},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err == nil {
				if mapped, ok := hostAddrs[strings.ToLower(host)]; ok {
					return dialer.DialContext(ctx, network, mapped)
				}
			}
			return dialer.DialContext(ctx, network, addr)
		},
	}
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: httpsRedirects,
	}

	idle := cfg.idleTimeout
	if idle <= 0 {
		idle = 5 * time.Second
	}
	f.engine = NewWithOptions(Options{
		CurrentVersion:      "v2.0.6",
		DataDir:             f.dataDir,
		FeedURL:             feedURL,
		PublicKey:           pub,
		Platform:            "darwin-arm64",
		Locale:              cfg.locale,
		Timezone:            cfg.timezone,
		Client:              client,
		StagingRoot:         f.root,
		IdleTimeout:         idle,
		MinSpeedBytesPerSec: cfg.minSpeedBytesPerSec,
		SlowSpeedWindow:     cfg.slowSpeedWindow,
		RetryBackoff:        func(int) time.Duration { return 5 * time.Millisecond },
	})
	if _, err := f.engine.CheckForUpdate(context.Background()); err != nil {
		t.Fatalf("CheckForUpdate: %v", err)
	}
	return f
}

func (f *multiSourceFixture) partial() string {
	return filepath.Join(f.root, "downloads", f.sum+".part")
}

func TestMultiSourceOrderingMainlandChinaTriesDomesticFirstOtherwiseR2First(t *testing.T) {
	t.Run("mainland_china_locale_uses_cnb_first", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "UTC",
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.cnbRanges) != 1 || len(f.assetRanges) != 1 || len(f.r2Ranges) != 0 {
			t.Fatalf("expected CNB only, got cnb=%v asset=%v r2=%v", f.cnbRanges, f.assetRanges, f.r2Ranges)
		}
	})

	t.Run("mainland_china_timezone_uses_cnb_first", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "en-US",
			timezone: "Asia/Shanghai",
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.cnbRanges) != 1 || len(f.assetRanges) != 1 || len(f.r2Ranges) != 0 {
			t.Fatalf("expected CNB only, got cnb=%v asset=%v r2=%v", f.cnbRanges, f.assetRanges, f.r2Ranges)
		}
	})

	t.Run("non_mainland_uses_r2_first", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "en-US",
			timezone: "UTC",
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 || len(f.cnbRanges) != 0 || len(f.assetRanges) != 0 {
			t.Fatalf("expected R2 only, got r2=%v cnb=%v asset=%v", f.r2Ranges, f.cnbRanges, f.assetRanges)
		}
	})
}

func TestMultiSourceFallbackAndCrossSourceByteResume(t *testing.T) {
	t.Run("cnb_drops_midway_and_resumes_from_r2", func(t *testing.T) {
		cut := 64 * 1024
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "Asia/Shanghai",
			serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				abortAfter(w, zip, cut)
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady || state.DownloadedBytes != int64(len(f.zip)) {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.cnbRanges) != 1 || f.cnbRanges[0] != "" {
			t.Fatalf("cnb ranges = %v", f.cnbRanges)
		}
		if len(f.r2Ranges) != 1 || f.r2Ranges[0] != "bytes="+strconv.Itoa(cut)+"-" {
			t.Fatalf("r2 ranges = %v, want bytes=%d-", f.r2Ranges, cut)
		}
	})

	t.Run("cnb_http_404_falls_back_to_r2", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "Asia/Shanghai",
			serveCNB: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				http.NotFound(w, r)
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.cnbRanges) != 1 || len(f.r2Ranges) != 1 || f.r2Ranges[0] != "" {
			t.Fatalf("cnb=%v r2=%v", f.cnbRanges, f.r2Ranges)
		}
	})

	t.Run("r2_drops_midway_and_resumes_from_cnb_across_redirect", func(t *testing.T) {
		cut := 48 * 1024
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "en-US",
			timezone: "UTC",
			serveR2: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				abortAfter(w, zip, cut)
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 || f.r2Ranges[0] != "" {
			t.Fatalf("r2 ranges = %v", f.r2Ranges)
		}
		if len(f.assetRanges) != 1 || f.assetRanges[0] != "bytes="+strconv.Itoa(cut)+"-" {
			t.Fatalf("release-assets.githubusercontent.com ranges = %v, want bytes=%d-", f.assetRanges, cut)
		}
	})

	t.Run("oversized_response_on_first_source_falls_back_to_r2", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "Asia/Shanghai",
			serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(zip)
				_, _ = w.Write([]byte("extra-bytes"))
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 || f.r2Ranges[0] != "" {
			t.Fatalf("expected clean fallback to R2 after oversized CNB response, got r2Ranges=%v", f.r2Ranges)
		}
	})
}

func TestMultiSourceSwitchesOnIdleTimeoutAndSustainedLowSpeed(t *testing.T) {
	t.Run("idle_timeout_switches_to_r2_and_resumes", func(t *testing.T) {
		cut := 32 * 1024
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:      "zh-CN",
			timezone:    "Asia/Shanghai",
			idleTimeout: 100 * time.Millisecond,
			serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(zip[:cut])
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 || f.r2Ranges[0] != "bytes="+strconv.Itoa(cut)+"-" {
			t.Fatalf("r2 ranges = %v, want bytes=%d-", f.r2Ranges, cut)
		}
	})

	t.Run("sustained_low_speed_switches_to_r2_and_resumes", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:              "zh-CN",
			timezone:            "Asia/Shanghai",
			idleTimeout:         2 * time.Second,
			minSpeedBytesPerSec: 256 * 1024, // require 256 KiB/s
			slowSpeedWindow:     80 * time.Millisecond,
			serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				w.Header().Set("Content-Length", strconv.Itoa(len(zip)))
				w.WriteHeader(http.StatusOK)
				// Drip 1 KiB every 20ms (~50 KiB/s): keeps idle timer alive, but
				// stays well below the 256 KiB/s threshold over 80ms.
				for offset := 0; offset < len(zip); offset += 1024 {
					select {
					case <-r.Context().Done():
						return
					default:
					}
					end := min(offset+1024, len(zip))
					_, _ = w.Write(zip[offset:end])
					w.(http.Flusher).Flush()
					time.Sleep(20 * time.Millisecond)
				}
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 || !strings.HasPrefix(f.r2Ranges[0], "bytes=") {
			t.Fatalf("expected R2 resume range after slow CNB abort, got r2Ranges=%v", f.r2Ranges)
		}
	})
}

func TestRedirectedRangeResumeAndExpiredTemporaryLinkRecovery(t *testing.T) {
	t.Run("expired_redirect_token_recovers_via_canonical_cnb_url", func(t *testing.T) {
		cut := 40 * 1024
		expiredTokens := map[string]bool{}
		var tokenMu sync.Mutex

		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "Asia/Shanghai",
			serveCNB: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				token := "token-" + strconv.Itoa(call)
				http.Redirect(w, r, "https://release-assets.githubusercontent.com/assets/t/"+token, http.StatusFound)
			},
			serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				token := strings.TrimPrefix(r.URL.Path, "/assets/t/")
				tokenMu.Lock()
				expired := expiredTokens[token]
				tokenMu.Unlock()
				if expired {
					http.NotFound(w, r)
					return
				}
				if call == 1 {
					tokenMu.Lock()
					expiredTokens[token] = true
					tokenMu.Unlock()
					abortAfter(w, zip, cut)
				}
				serveRange(w, r, zip)
			},
			// Simulate R2 also failing once so retry comes back to canonical cheeser.link
			// and obtains a fresh token-2 on release-assets.githubusercontent.com.
			serveR2: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.cnbRanges) != 2 || f.cnbRanges[1] != "bytes="+strconv.Itoa(cut)+"-" {
			t.Fatalf("expected canonical cheeser.link retry with Range, got %v", f.cnbRanges)
		}
		if len(f.assetRanges) != 2 || f.assetRanges[1] != "bytes="+strconv.Itoa(cut)+"-" {
			t.Fatalf("expected release-assets.githubusercontent.com fresh token resume with Range, got %v", f.assetRanges)
		}
	})

	t.Run("untrusted_redirect_host_is_rejected_and_falls_back_to_r2", func(t *testing.T) {
		f := newMultiSourceFixture(t, multiSourceConfig{
			locale:   "zh-CN",
			timezone: "Asia/Shanghai",
			serveCNB: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
				http.Redirect(w, r, "https://evil.example.com/qisiTV.zip", http.StatusFound)
			},
		})
		state, err := f.engine.DownloadUpdate(context.Background())
		if err != nil || state.Status != StatusReady {
			t.Fatalf("download err=%v state=%+v", err, state)
		}
		if len(f.r2Ranges) != 1 {
			t.Fatalf("expected fallback to R2 after untrusted redirect, got r2Ranges=%v", f.r2Ranges)
		}
	})
}

func TestMultiSourceRejectsSHA256MismatchAfterCrossSourceResume(t *testing.T) {
	cut := 32 * 1024
	f := newMultiSourceFixture(t, multiSourceConfig{
		locale:   "zh-CN",
		timezone: "Asia/Shanghai",
		serveAsset: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
			abortAfter(w, zip, cut)
		},
		serveR2: func(w http.ResponseWriter, r *http.Request, zip []byte, call int) {
			tampered := append([]byte(nil), zip...)
			tampered[len(tampered)-1] ^= 0xff
			serveRange(w, r, tampered)
		},
	})
	_, err := f.engine.DownloadUpdate(context.Background())
	if !errors.Is(err, ErrTampered) {
		t.Fatalf("expected ErrTampered on SHA256 mismatch, got %v", err)
	}
	if _, statErr := os.Stat(f.partial()); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("corrupted partial file must be removed: %v", statErr)
	}
}
