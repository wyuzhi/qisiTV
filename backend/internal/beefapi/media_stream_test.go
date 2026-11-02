package beefapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
)

type virtualMediaFile struct {
	prefix       []byte
	size, offset int64
	largest      atomic.Int64
}

func (f *virtualMediaFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= f.size {
		return 0, io.EOF
	}
	n := int(min(int64(len(p)), f.size-off))
	clear(p[:n])
	if off < int64(len(f.prefix)) {
		copy(p[:n], f.prefix[off:])
	}
	for old := f.largest.Load(); int64(n) > old; old = f.largest.Load() {
		if f.largest.CompareAndSwap(old, int64(n)) {
			break
		}
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
func (f *virtualMediaFile) Read(p []byte) (int, error) {
	n, err := f.ReadAt(p, f.offset)
	f.offset += int64(n)
	return n, err
}
func (f *virtualMediaFile) Seek(off int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		f.offset = off
	case io.SeekCurrent:
		f.offset += off
	case io.SeekEnd:
		f.offset = f.size + off
	}
	return f.offset, nil
}
func (*virtualMediaFile) Close() error { return nil }

// Opt-in local bandwidth evidence: no physical 5 GiB fixture and no model call.
// Every byte is hashed once and transmitted to a storage server in bounded reads.
func TestMediaSourceStreamingFiveGiB(t *testing.T) {
	if os.Getenv("BEEFTV_TEST_LARGE_MEDIA_STREAM") != "1" {
		t.Skip("explicit local 5 GiB streaming verification")
	}
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	prefix, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=")
	source := &virtualMediaFile{prefix: prefix, size: 5 << 30}
	var bytesStored, puts atomic.Int64
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("storage request leaked credentials or method")
		}
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil || n != r.ContentLength {
			t.Errorf("partial storage put n=%d length=%d err=%v", n, r.ContentLength, err)
		}
		bytesStored.Add(n)
		puts.Add(1)
	}))
	defer storage.Close()
	var metadata UploadRequest
	controlBytes := 0
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
		controlBytes += len(data)
		switch r.URL.Path {
		case "/v1/media/uploads":
			_ = json.Unmarshal(data, &metadata)
			plan := &UploadPlan{PartBytes: 64 << 20}
			for offset := int64(0); offset < metadata.Bytes; offset += plan.PartBytes {
				plan.Parts = append(plan.Parts, UploadPart{Number: len(plan.Parts) + 1, Bytes: min(plan.PartBytes, metadata.Bytes-offset), UploadURL: storage.URL + fmt.Sprintf("/part/%d", len(plan.Parts)+1)})
			}
			_ = json.NewEncoder(w).Encode(UploadSession{Ticket: "same-ticket", Multipart: plan})
		case "/v1/media/uploads/complete":
			_ = json.NewEncoder(w).Encode(UploadedMedia{URL: storage.URL + "/owned", Kind: metadata.Kind, Mime: metadata.Mime, Bytes: metadata.Bytes, SHA256: metadata.SHA256})
		default:
			t.Error("unexpected generation or replacement ticket request")
			w.WriteHeader(500)
		}
	}))
	defer gateway.Close()
	client := &MediaClient{BaseURL: gateway.URL, AllowHTTPTest: true, APIKey: "fixture", Open: func(context.Context, string) (io.ReadCloser, string, int64, error) {
		return source, "image/png", source.size, nil
	}}
	_, err := client.UploadReference(context.Background(), LocalMediaReference{MediaReference: MediaReference{Kind: "image", Role: "reference"}, StorageKey: "resource:virtual-5g"})
	if err != nil || bytesStored.Load() != source.size || puts.Load() != 80 || source.largest.Load() > 64<<10 || controlBytes > 4096 {
		t.Fatalf("err=%v storage=%d puts=%d max_read=%d control=%d", err, bytesStored.Load(), puts.Load(), source.largest.Load(), controlBytes)
	}
	t.Logf("source_bytes=%d storage_put_bytes=%d parts=%d largest_read=%d control_json_bytes=%d paid_creates=0", source.size, bytesStored.Load(), puts.Load(), source.largest.Load(), controlBytes)
}
