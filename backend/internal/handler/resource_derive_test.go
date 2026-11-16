package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestHandlerFakeMediaToolHelperProcess(t *testing.T) {
	mode := os.Getenv("BEEFTV_HANDLER_FAKE_TOOL")
	if mode == "" {
		return
	}
	args := os.Args
	sep := slices.Index(args, "--")
	toolArgs := args[1:]
	if sep >= 0 {
		toolArgs = args[sep+1:]
	}
	switch mode {
	case "ffprobe":
		target := toolArgs[len(toolArgs)-1]
		if strings.HasSuffix(target, ".mp3") || strings.HasSuffix(target, ".wav") || strings.HasSuffix(target, ".m4a") {
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"audio","codec_name":"mp3","duration":"1.000"}],"format":{"format_name":"mp3","duration":"1.000"}}`)
			os.Exit(0)
		}
		if strings.Contains(target, "muted-video") {
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":96,"height":54,"avg_frame_rate":"10/1","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
			os.Exit(0)
		}
		_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":96,"height":54,"avg_frame_rate":"10/1","duration":"1.000"},{"codec_type":"audio","codec_name":"aac","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
		os.Exit(0)
	case "ffmpeg":
		if os.Getenv("BEEFTV_HANDLER_FAKE_CORRUPT") == "1" {
			_, _ = fmt.Fprintf(os.Stderr, "%s: Invalid data found when processing input\n", strings.Join(toolArgs, " "))
			os.Exit(1)
		}
		if os.Getenv("BEEFTV_HANDLER_FAKE_SLOW") == "1" {
			time.Sleep(400 * time.Millisecond)
		}
		for _, arg := range toolArgs {
			if strings.HasSuffix(arg, ".png") {
				img := image.NewRGBA(image.Rect(0, 0, 96, 54))
				img.Set(0, 0, color.RGBA{R: 50, G: 100, B: 150, A: 255})
				var buf bytes.Buffer
				_ = png.Encode(&buf, img)
				_ = os.WriteFile(arg, buf.Bytes(), 0o600)
			} else if strings.HasSuffix(arg, ".mp3") || strings.HasSuffix(arg, ".wav") || strings.HasSuffix(arg, ".m4a") {
				_ = os.WriteFile(arg, bytes.Repeat([]byte("a"), 128), 0o600)
			} else if strings.HasSuffix(arg, ".mp4") {
				_ = os.WriteFile(arg, bytes.Repeat([]byte("v"), 512), 0o600)
			}
		}
		os.Exit(0)
	}
	os.Exit(2)
}

func installHandlerFakeMediaTools(t *testing.T) {
	t.Helper()
	if os.PathSeparator == '\\' {
		t.Skip("shell wrapper helper uses POSIX sh")
	}
	testBin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	write := func(name, mode string) string {
		p := filepath.Join(dir, name)
		body := fmt.Sprintf("#!/bin/sh\nexport BEEFTV_HANDLER_FAKE_TOOL=%s\nexec %q -test.run=^TestHandlerFakeMediaToolHelperProcess$ -- \"$@\"\n", mode, testBin)
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	t.Setenv(mediatools.FFmpegPathEnv, write("fake-ffmpeg", "ffmpeg"))
	t.Setenv(mediatools.FFprobePathEnv, write("fake-ffprobe", "ffprobe"))
}

func TestResourceDeriveRoutesHTTPContractsWithoutNativeFFmpeg(t *testing.T) {
	installHandlerFakeMediaTools(t)
	gin.SetMode(gin.TestMode)
	dir := filepath.Join(t.TempDir(), "Workspace With Spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "derive-contracts.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), dir)
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	videoFile := filepath.Join(dir, "resources", "sample.mp4")
	if err := os.WriteFile(videoFile, bytes.Repeat([]byte("video-bytes"), 32), 0o600); err != nil {
		t.Fatal(err)
	}
	srcResource := &model.Resource{
		ID: "video-contract-1", UserID: owner.ID, Kind: "video", MimeType: "video/mp4",
		Provider: "local", ObjectKey: "sample.mp4", Status: model.ResourceStatusReady, Size: 352,
	}
	if err := db.Create(srcResource).Error; err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	RegisterCanvasAPI(router.Group("/api"), svc)

	// 1. 30-frame batch succeeds and idempotent replay returns identical resource IDs.
	thirty := make([]int64, 30)
	for i := range thirty {
		thirty[i] = int64(i * 30)
	}
	body30, _ := json.Marshal(asset.ExtractVideoFramesRequest{TimesMs: thirty})
	req30 := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader(body30))
	req30.Header.Set("Content-Type", "application/json")
	req30.Header.Set("X-Idempotency-Key", "http-30-idem")
	rec30 := httptest.NewRecorder()
	router.ServeHTTP(rec30, req30)
	if rec30.Code != http.StatusOK {
		t.Fatalf("expected 200 for 30 frames, got %d: %s", rec30.Code, rec30.Body.String())
	}
	var env30 struct {
		Data asset.ExtractVideoFramesResult `json:"data"`
	}
	if err := json.Unmarshal(rec30.Body.Bytes(), &env30); err != nil || len(env30.Data.Frames) != 30 {
		t.Fatalf("expected 30 frames in response, got %d (%v)", len(env30.Data.Frames), err)
	}

	reqReplay := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader(body30))
	reqReplay.Header.Set("Content-Type", "application/json")
	reqReplay.Header.Set("X-Idempotency-Key", "http-30-idem")
	recReplay := httptest.NewRecorder()
	router.ServeHTTP(recReplay, reqReplay)
	var envReplay struct {
		Data asset.ExtractVideoFramesResult `json:"data"`
	}
	if recReplay.Code != http.StatusOK || json.Unmarshal(recReplay.Body.Bytes(), &envReplay) != nil || envReplay.Data.Frames[0].Resource.ID != env30.Data.Frames[0].Resource.ID {
		t.Fatalf("expected idempotent replay to match first frame ID, got %d %s", recReplay.Code, recReplay.Body.String())
	}

	// 2. 31 frames, malformed JSON, and >8KiB body return 400.
	body31, _ := json.Marshal(asset.ExtractVideoFramesRequest{TimesMs: append(thirty, 999)})
	req31 := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader(body31))
	req31.Header.Set("Content-Type", "application/json")
	rec31 := httptest.NewRecorder()
	router.ServeHTTP(rec31, req31)
	if rec31.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for 31 frames, got %d: %s", rec31.Code, rec31.Body.String())
	}

	reqBadJSON := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader([]byte(`{"preset":`)))
	reqBadJSON.Header.Set("Content-Type", "application/json")
	recBadJSON := httptest.NewRecorder()
	router.ServeHTTP(recBadJSON, reqBadJSON)
	if recBadJSON.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed JSON, got %d: %s", recBadJSON.Code, recBadJSON.Body.String())
	}

	oversized := append([]byte(`{"preset":"first","pad":"`), bytes.Repeat([]byte("x"), 9000)...)
	oversized = append(oversized, []byte(`"}`)...)
	reqOversized := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader(oversized))
	reqOversized.Header.Set("Content-Type", "application/json")
	recOversized := httptest.NewRecorder()
	router.ServeHTTP(recOversized, reqOversized)
	if recOversized.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for >8KiB JSON body, got %d: %s", recOversized.Code, recOversized.Body.String())
	}

	// 3. Cancellation -> 499 request_cancelled; mid-execution DeadlineExceeded -> 408 timeout.
	cancelCtx, cancel := context.WithCancel(context.Background())
	cancel()
	reqCancelled := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/separate-audio", nil).WithContext(cancelCtx)
	recCancelled := httptest.NewRecorder()
	router.ServeHTTP(recCancelled, reqCancelled)
	if recCancelled.Code != 499 || !strings.Contains(recCancelled.Body.String(), `"reason":"request_cancelled"`) {
		t.Fatalf("expected 499 request_cancelled, got %d: %s", recCancelled.Code, recCancelled.Body.String())
	}

	t.Setenv("BEEFTV_HANDLER_FAKE_SLOW", "1")
	timeoutCtx, cancelTimeout := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancelTimeout()
	reqTimeout := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/separate-audio", nil).WithContext(timeoutCtx)
	recTimeout := httptest.NewRecorder()
	router.ServeHTTP(recTimeout, reqTimeout)
	t.Setenv("BEEFTV_HANDLER_FAKE_SLOW", "")
	if recTimeout.Code != http.StatusRequestTimeout || !strings.Contains(recTimeout.Body.String(), `"reason":"timeout"`) {
		t.Fatalf("expected 408 timeout, got %d: %s", recTimeout.Code, recTimeout.Body.String())
	}

	// 4. Corrupt media -> 400 sanitized response + server log with redacted diagnostic (no space-path leak).
	var logBuf bytes.Buffer
	prevWriter := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prevWriter)

	t.Setenv("BEEFTV_HANDLER_FAKE_CORRUPT", "1")
	bodyFirst, _ := json.Marshal(asset.ExtractVideoFramesRequest{Preset: "first"})
	reqCorrupt := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/frames", bytes.NewReader(bodyFirst))
	reqCorrupt.Header.Set("Content-Type", "application/json")
	recCorrupt := httptest.NewRecorder()
	router.ServeHTTP(recCorrupt, reqCorrupt)
	t.Setenv("BEEFTV_HANDLER_FAKE_CORRUPT", "")
	if recCorrupt.Code != http.StatusBadRequest || strings.Contains(recCorrupt.Body.String(), "Invalid data") || strings.Contains(recCorrupt.Body.String(), "Workspace With Spaces") {
		t.Fatalf("expected sanitized 400 response, got %d: %s", recCorrupt.Code, recCorrupt.Body.String())
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "resource media derive failed:") || !strings.Contains(logged, "Invalid data found when processing input") {
		t.Fatalf("expected redacted ffmpeg diagnostic logged on 400 failure, got %q", logged)
	}
	if strings.Contains(logged, dir) || strings.Contains(logged, "Workspace With Spaces") || strings.Contains(logged, "sample.mp4") {
		t.Fatalf("server log leaked local path or filename: %q", logged)
	}

	// 5. Non-ffmpeg internal failure (makeDeriveTempDir failure in spaced dir) -> 500 with zero path fragments in server log.
	logBuf.Reset()
	tmpBlocker := filepath.Join(dir, "tmp")
	_ = os.RemoveAll(tmpBlocker)
	if err := os.WriteFile(tmpBlocker, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	badSysTmp := filepath.Join(dir, "blocked-sys-tmp")
	if err := os.WriteFile(badSysTmp, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	prevTmpDir, hadTmpDir := os.LookupEnv("TMPDIR")
	_ = os.Setenv("TMPDIR", badSysTmp)
	reqTmpFail := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/separate-audio", nil)
	recTmpFail := httptest.NewRecorder()
	router.ServeHTTP(recTmpFail, reqTmpFail)
	if hadTmpDir {
		_ = os.Setenv("TMPDIR", prevTmpDir)
	} else {
		_ = os.Unsetenv("TMPDIR")
	}
	_ = os.Remove(tmpBlocker)
	if recTmpFail.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when temp dir cannot be created, got %d: %s", recTmpFail.Code, recTmpFail.Body.String())
	}
	tmpLogged := logBuf.String()
	if strings.Contains(tmpLogged, dir) || strings.Contains(tmpLogged, "Workspace With Spaces") || strings.Contains(tmpLogged, "With Spaces") {
		t.Fatalf("non-ffmpeg 500 log leaked spaced directory fragment: %q", tmpLogged)
	}

	// 6. Missing native tool -> 503 unavailable.
	t.Setenv(mediatools.FFmpegPathEnv, filepath.Join(dir, "missing-ffmpeg"))
	t.Setenv(mediatools.FFprobePathEnv, filepath.Join(dir, "missing-ffprobe"))
	reqUnavailable := httptest.NewRequest(http.MethodPost, "/api/resources/video-contract-1/separate-audio", nil)
	recUnavailable := httptest.NewRecorder()
	router.ServeHTTP(recUnavailable, reqUnavailable)
	if recUnavailable.Code != http.StatusServiceUnavailable || !strings.Contains(recUnavailable.Body.String(), `"reason":"unavailable"`) {
		t.Fatalf("expected 503 unavailable, got %d: %s", recUnavailable.Code, recUnavailable.Body.String())
	}
}

func TestResourceDeriveRoutesEndToEnd(t *testing.T) {
	ffmpegBin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "derive.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), dir)
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	videoFile := filepath.Join(dir, "resources", "sample.mp4")
	cmd := exec.Command(ffmpegBin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=orange:s=96x54:r=10:d=0.6",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2.0",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
		videoFile,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create sample video: %v\n%s", err, out)
	}
	info, err := os.Stat(videoFile)
	if err != nil {
		t.Fatal(err)
	}
	srcResource := &model.Resource{
		ID: "video-1", UserID: owner.ID, Kind: "video", MimeType: "video/mp4",
		Provider: "local", ObjectKey: "sample.mp4", Status: model.ResourceStatusReady, Size: info.Size(),
	}
	if err := db.Create(srcResource).Error; err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	RegisterCanvasAPI(router.Group("/api"), svc)

	body, _ := json.Marshal(asset.ExtractVideoFramesRequest{Preset: "last"})
	frameReq := httptest.NewRequest(http.MethodPost, "/api/resources/video-1/frames", bytes.NewReader(body))
	frameReq.Header.Set("Content-Type", "application/json")
	frameReq.Header.Set("X-Idempotency-Key", "route-tail-1")
	frameRec := httptest.NewRecorder()
	router.ServeHTTP(frameRec, frameReq)
	if frameRec.Code != http.StatusOK {
		t.Fatalf("frames status=%d body=%s", frameRec.Code, frameRec.Body.String())
	}
	var frameEnv struct {
		Code int                            `json:"code"`
		Data asset.ExtractVideoFramesResult `json:"data"`
	}
	if err := json.Unmarshal(frameRec.Body.Bytes(), &frameEnv); err != nil || len(frameEnv.Data.Frames) != 1 || frameEnv.Data.Frames[0].Resource.Width != 96 {
		t.Fatalf("unexpected frame response: %s (%v)", frameRec.Body.String(), err)
	}

	splitReq := httptest.NewRequest(http.MethodPost, "/api/resources/video-1/separate-audio", nil)
	splitReq.Header.Set("X-Idempotency-Key", "route-split-1")
	splitRec := httptest.NewRecorder()
	router.ServeHTTP(splitRec, splitReq)
	if splitRec.Code != http.StatusOK {
		t.Fatalf("separate-audio status=%d body=%s", splitRec.Code, splitRec.Body.String())
	}
	var splitEnv struct {
		Code int                            `json:"code"`
		Data asset.SeparateVideoAudioResult `json:"data"`
	}
	if err := json.Unmarshal(splitRec.Body.Bytes(), &splitEnv); err != nil || splitEnv.Data.Audio.ID == "" || splitEnv.Data.MutedVideo.ID == "" {
		t.Fatalf("unexpected separate-audio response: %s (%v)", splitRec.Body.String(), err)
	}
}
