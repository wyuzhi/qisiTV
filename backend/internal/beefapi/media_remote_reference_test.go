package beefapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMeasuredRemoteReferenceUsesTicketAndBoundedCredentialFreeDownload(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, kind := range []string{"image", "video", "audio"} {
		t.Run(kind, func(t *testing.T) {
			data := []byte("ID3\x04\x00\x00reference-fixture")
			mime := kind + "/fixture"
			sum := sha256.Sum256(data)
			hash := hex.EncodeToString(sum[:])
			var uploads, downloads, puts atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/source", "/put":
					if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
						t.Error("storage received account credentials")
					}
					if r.URL.Path == "/source" {
						downloads.Add(1)
						w.Header().Set("Content-Type", mime)
						_, _ = w.Write(data)
					} else {
						puts.Add(1)
						actual, _ := io.ReadAll(r.Body)
						if !bytes.Equal(actual, data) {
							t.Error("upload changed source bytes")
						}
					}
				case "/v1/media/uploads":
					uploads.Add(1)
					var request UploadRequest
					_ = json.NewDecoder(r.Body).Decode(&request)
					if request.Kind != kind || request.SHA256 != hash || request.Bytes != int64(len(data)) {
						t.Errorf("ticket request=%+v", request)
					}
					_ = json.NewEncoder(w).Encode(UploadSession{Ticket: "original", UploadURL: server.URL + "/put", UploadMethod: "PUT"})
				case "/v1/media/uploads/complete":
					_ = json.NewEncoder(w).Encode(UploadedMedia{Kind: kind, URL: server.URL + "/finalized", Mime: mime, Bytes: int64(len(data)), SHA256: hash})
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
				}
			}))
			defer server.Close()
			client := &MediaClient{BaseURL: server.URL, APIKey: "private", AllowHTTPTest: true}
			ref := LocalMediaReference{MediaReference: MediaReference{Kind: kind, Role: "source", URL: server.URL + "/source"}, MaxBytes: 1024}
			url, err := client.UploadReference(context.Background(), ref)
			if err != nil || url != server.URL+"/finalized" || uploads.Load() != 1 || puts.Load() != 1 || downloads.Load() != 1 {
				t.Fatalf("url=%q err=%v counts=%d/%d/%d", url, err, uploads.Load(), puts.Load(), downloads.Load())
			}
			ref.MaxBytes = 4
			if _, err := client.UploadReference(context.Background(), ref); err == nil || uploads.Load() != 1 || puts.Load() != 1 {
				t.Fatal("oversized reference reached upload tickets")
			}
		})
	}
}
