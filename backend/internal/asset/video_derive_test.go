package asset

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAssetFakeMediaToolHelperProcess(t *testing.T) {
	mode := os.Getenv("BEEFTV_ASSET_FAKE_TOOL")
	if mode == "" {
		return
	}
	scenario := os.Getenv("BEEFTV_ASSET_FAKE_SCENARIO")
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
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":80,"height":60,"avg_frame_rate":"10/1","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
			os.Exit(0)
		}
		_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":80,"height":60,"avg_frame_rate":"10/1","duration":"1.000"},{"codec_type":"audio","codec_name":"aac","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
		os.Exit(0)
	case "ffmpeg":
		if scenario == "corrupt" {
			_, _ = fmt.Fprintf(os.Stderr, "%s: Invalid data found when processing input\n", strings.Join(toolArgs, " "))
			os.Exit(1)
		}
		if scenario == "no_mp3_encoder" {
			if slices.Contains(toolArgs, "libmp3lame") {
				_, _ = fmt.Fprint(os.Stderr, "Unknown encoder 'libmp3lame'\n")
				os.Exit(1)
			}
			if slices.Contains(toolArgs, "libx264") {
				_, _ = fmt.Fprint(os.Stderr, "unexpected full video re-encode when only libmp3lame was missing\n")
				os.Exit(1)
			}
		}
		for _, arg := range toolArgs {
			if strings.HasSuffix(arg, ".png") {
				img := image.NewRGBA(image.Rect(0, 0, 80, 60))
				img.Set(0, 0, color.RGBA{R: 10, G: 20, B: 30, A: 255})
				var buf bytes.Buffer
				_ = png.Encode(&buf, img)
				_ = os.WriteFile(arg, buf.Bytes(), 0o600)
			} else if strings.HasSuffix(arg, ".mp3") || strings.HasSuffix(arg, ".wav") || strings.HasSuffix(arg, ".m4a") {
				if scenario == "large_muted" {
					_ = os.WriteFile(arg, bytes.Repeat([]byte("a"), 256*1024), 0o600)
				} else {
					_ = os.WriteFile(arg, bytes.Repeat([]byte("a"), 128), 0o600)
				}
			} else if strings.HasSuffix(arg, ".mp4") {
				if scenario == "large_muted" {
					_ = os.WriteFile(arg, bytes.Repeat([]byte("v"), 1536*1024), 0o600)
				} else {
					_ = os.WriteFile(arg, bytes.Repeat([]byte("v"), 512), 0o600)
				}
			}
		}
		os.Exit(0)
	}
	os.Exit(2)
}

func installAssetFakeMediaTools(t *testing.T, scenario string) {
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
		body := fmt.Sprintf("#!/bin/sh\nexport BEEFTV_ASSET_FAKE_TOOL=%s\nexport BEEFTV_ASSET_FAKE_SCENARIO=%s\nexec %q -test.run=^TestAssetFakeMediaToolHelperProcess$ -- \"$@\"\n",
			mode, scenario, testBin)
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	t.Setenv(mediatools.FFmpegPathEnv, write("fake-ffmpeg", "ffmpeg"))
	t.Setenv(mediatools.FFprobePathEnv, write("fake-ffprobe", "ffprobe"))
}

type failNthWriteBlobStore struct {
	BlobStore
	mu      sync.Mutex
	writes  int
	failNth int
}

func (b *failNthWriteBlobStore) Write(objectKey string, body io.Reader) error {
	b.mu.Lock()
	b.writes++
	shouldFail := b.writes == b.failNth
	b.mu.Unlock()
	if shouldFail {
		return errors.New("simulated second blob write failure")
	}
	return b.BlobStore.Write(objectKey, body)
}

func makeVideoFixtureBytes(t *testing.T, withAudio bool, trailingAudioSec string) []byte {
	t.Helper()
	ffmpegBin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	outPath := filepath.Join(t.TempDir(), "fixture.mp4")
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=navy:s=80x60:r=12:d=0.8",
	}
	if withAudio {
		dur := "0.8"
		if trailingAudioSec != "" {
			dur = trailingAudioSec
		}
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=520:duration="+dur,
			"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", outPath)
	} else {
		args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", outPath)
	}
	if out, err := exec.Command(ffmpegBin, args...).CombinedOutput(); err != nil {
		t.Fatalf("create video fixture: %v\n%s", err, out)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

type failSaveResourcesRepo struct {
	Repository
	mu       sync.Mutex
	failNext bool
}

func (r *failSaveResourcesRepo) SaveResources(resources []*model.Resource) error {
	r.mu.Lock()
	shouldFail := r.failNext
	r.failNext = false
	r.mu.Unlock()
	if shouldFail && len(resources) >= 2 {
		// Delegate to the real SQLite SaveResources transaction while forcing the
		// second save inside the transaction to violate the (user_id, upload_key) unique index.
		origKey := resources[1].UploadKey
		resources[1].UploadKey = resources[0].UploadKey
		err := r.Repository.SaveResources(resources)
		resources[1].UploadKey = origKey
		return err
	}
	return r.Repository.SaveResources(resources)
}

func TestServiceDeriveScopedIdempotencyQuotaRollbackAndPathRedaction(t *testing.T) {
	installAssetFakeMediaTools(t, "ok")

	dataDir := filepath.Join(t.TempDir(), "Workspace With Spaces")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "meta.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	domainRepo := &failSaveResourcesRepo{Repository: NewRepository(repo)}
	var policyMu sync.Mutex
	policy := FileQuotaPolicy{
		ResourceUploadMB: 1,
		GeneratedFileMB:  1,
		DailyUploadMB:    20,
		StoredFileGB:     1,
	}
	quota := NewFileQuota(repo, func() (FileQuotaPolicy, error) {
		policyMu.Lock()
		defer policyMu.Unlock()
		return policy, nil
	}, nil)
	blobs := &failNthWriteBlobStore{BlobStore: NewFileStore(dataDir), failNth: -1}
	svc := NewService(Dependencies{
		Repository:   domainRepo,
		Blobs:        blobs,
		Quota:        quota,
		Lifecycle:    nopLifecycle{},
		LocalStorage: true,
		DataDir:      dataDir,
	})

	srcA, _, err := svc.Store("owner", "video", "a.mp4", "video/mp4", 64, 80, 60, 1000, bytes.NewReader(bytes.Repeat([]byte("a"), 64)), nil)
	if err != nil {
		t.Fatal(err)
	}
	srcB, _, err := svc.Store("owner", "video", "b.mp4", "video/mp4", 64, 80, 60, 1000, bytes.NewReader(bytes.Repeat([]byte("b"), 64)), nil)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Server-scoped idempotency: same client header across different videos or presets never collides.
	firstA, err := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{Preset: "first"}, "shared-idem")
	if err != nil {
		t.Fatal(err)
	}
	replayFirstA, err := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{Preset: "first"}, "shared-idem")
	if err != nil || replayFirstA.Frames[0].Resource.ID != firstA.Frames[0].Resource.ID {
		t.Fatalf("same request must replay resource: %+v vs %+v (%v)", replayFirstA, firstA, err)
	}
	lastA, err := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{Preset: "last"}, "shared-idem")
	if err != nil || lastA.Frames[0].Resource.ID == firstA.Frames[0].Resource.ID {
		t.Fatalf("different preset with same client key collided: %s", lastA.Frames[0].Resource.ID)
	}
	firstB, err := svc.ExtractVideoFrames(context.Background(), "owner", srcB.ID, ExtractVideoFramesRequest{Preset: "first"}, "shared-idem")
	if err != nil || firstB.Frames[0].Resource.ID == firstA.Frames[0].Resource.ID {
		t.Fatalf("different resourceID with same client key collided: %s", firstB.Frames[0].Resource.ID)
	}

	// 2. 30 frames accepted, 31 rejected with 400.
	thirty := make([]int64, 30)
	for i := range thirty {
		thirty[i] = int64(i * 20)
	}
	res30, err := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{TimesMs: thirty}, "idem-30")
	if err != nil || len(res30.Frames) != 30 {
		t.Fatalf("expected 30 frames stored, got %+v %v", res30, err)
	}
	if _, err := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{TimesMs: append(thirty, 999)}, ""); err == nil {
		t.Fatal("expected 31 frames rejected")
	}

	// Switch to large_muted scenario: audio=256KiB, mutedVideo=1.5MiB (exceeds ResourceUploadMB=1MiB).
	installAssetFakeMediaTools(t, "large_muted")
	today := time.Now().UTC().Format("2006-01-02")
	beforeResources, _ := repo.Resources("owner", 100)
	beforeDaily, err := repo.DailyUploadBytes("owner", today)
	if err != nil {
		t.Fatal(err)
	}
	beforeStored, err := repo.UserStoredFileBytes("owner")
	if err != nil {
		t.Fatal(err)
	}

	// 3. Real FileQuota daily limit exceeded on second output (256KiB fits 1MiB cap, +1.5MiB exceeds 1MiB cap):
	// audio's staged row, blob, pendingStorage, and SQLite DailyUploadBytes must all roll back cleanly.
	policyMu.Lock()
	policy.DailyUploadMB = 1
	policyMu.Unlock()
	if _, err := svc.SeparateVideoAudio(context.Background(), "owner", srcA.ID, "idem-quota-fail"); err == nil {
		t.Fatal("expected daily quota failure on mutedVideo")
	}
	afterQuotaDaily, _ := repo.DailyUploadBytes("owner", today)
	if afterQuotaDaily != beforeDaily {
		t.Fatalf("daily upload bytes leaked after partial reservation failure: got=%d want=%d", afterQuotaDaily, beforeDaily)
	}
	if quota.pendingStorageTotal("owner") != 0 {
		t.Fatalf("pendingStorage leaked after partial reservation failure: %d", quota.pendingStorageTotal("owner"))
	}
	afterQuotaFailResources, _ := repo.Resources("owner", 100)
	if len(afterQuotaFailResources) != len(beforeResources) {
		t.Fatalf("orphan resource committed on quota failure: got %d want %d", len(afterQuotaFailResources), len(beforeResources))
	}

	// 4. Mid-batch blob write failure on mutedVideo refunds real SQLite DailyUploadBytes, pendingStorage, DB rows, and blobs.
	policyMu.Lock()
	policy.DailyUploadMB = 20
	policyMu.Unlock()
	blobs.mu.Lock()
	blobs.writes = 0
	blobs.failNth = 2
	blobs.mu.Unlock()
	if _, err := svc.SeparateVideoAudio(context.Background(), "owner", srcA.ID, "idem-write-fail"); err == nil {
		t.Fatal("expected write failure on second output")
	}
	blobs.mu.Lock()
	blobs.failNth = -1
	blobs.mu.Unlock()
	afterWriteFailDaily, _ := repo.DailyUploadBytes("owner", today)
	if afterWriteFailDaily != beforeDaily {
		t.Fatalf("daily upload bytes leaked after mid-batch write failure: got=%d want=%d", afterWriteFailDaily, beforeDaily)
	}
	if quota.pendingStorageTotal("owner") != 0 {
		t.Fatalf("pendingStorage leaked after mid-batch write failure: %d", quota.pendingStorageTotal("owner"))
	}
	afterWriteFailStored, _ := repo.UserStoredFileBytes("owner")
	if afterWriteFailStored != beforeStored {
		t.Fatalf("stored bytes changed after mid-batch write failure: got=%d want=%d", afterWriteFailStored, beforeStored)
	}
	var leftoverReservations int64
	if err := db.Model(&model.UserUploadReservation{}).Where("user_id = ?", "owner").Count(&leftoverReservations).Error; err != nil || leftoverReservations != 0 {
		t.Fatalf("expected 0 leftover upload reservations, got %d (err=%v)", leftoverReservations, err)
	}
	afterWriteFailResources, _ := repo.Resources("owner", 100)
	if len(afterWriteFailResources) != len(beforeResources) {
		t.Fatalf("audio resource leaked after mutedVideo write failure: got %d want %d", len(afterWriteFailResources), len(beforeResources))
	}

	// 4b. Atomic batch READY publication failure (SaveResources fails): zero rows become READY,
	// daily/pending/stored bytes return to baseline, and retrying the same idempotencyKey succeeds.
	domainRepo.mu.Lock()
	domainRepo.failNext = true
	domainRepo.mu.Unlock()
	if _, err := svc.SeparateVideoAudio(context.Background(), "owner", srcA.ID, "idem-publish-tx-fail"); err == nil {
		t.Fatal("expected SaveResources transaction failure")
	}
	afterPublishFailDaily, _ := repo.DailyUploadBytes("owner", today)
	if afterPublishFailDaily != beforeDaily {
		t.Fatalf("daily upload bytes leaked after SaveResources failure: got=%d want=%d", afterPublishFailDaily, beforeDaily)
	}
	if quota.pendingStorageTotal("owner") != 0 {
		t.Fatalf("pendingStorage leaked after SaveResources failure: %d", quota.pendingStorageTotal("owner"))
	}
	afterPublishFailResources, _ := repo.Resources("owner", 100)
	if len(afterPublishFailResources) != len(beforeResources) {
		t.Fatalf("partial resource leaked after SaveResources failure: got %d want %d", len(afterPublishFailResources), len(beforeResources))
	}
	recoveredAfterPublishFail, err := svc.SeparateVideoAudio(context.Background(), "owner", srcA.ID, "idem-publish-tx-fail")
	if err != nil || recoveredAfterPublishFail.Audio.ID == "" || recoveredAfterPublishFail.MutedVideo.ID == "" {
		t.Fatalf("retry after SaveResources failure must succeed cleanly, got %+v (%v)", recoveredAfterPublishFail, err)
	}
	beforeDaily, _ = repo.DailyUploadBytes("owner", today)

	// 5. Large derived mutedVideo (1.5MiB > ResourceUploadMB=1MiB) succeeds via ReserveChunked,
	// and concurrent requests with the same idempotencyKey serialize cleanly and charge daily quota once.
	const workers = 4
	results := make([]*SeparateVideoAudioResult, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func(idx int) {
			defer wg.Done()
			results[idx], errs[idx] = svc.SeparateVideoAudio(context.Background(), "owner", srcA.ID, "idem-concurrent-large")
		}(w)
	}
	wg.Wait()
	for w := 0; w < workers; w++ {
		if errs[w] != nil {
			t.Fatalf("worker %d failed: %v", w, errs[w])
		}
		if results[w].Audio.ID != results[0].Audio.ID || results[w].MutedVideo.ID != results[0].MutedVideo.ID {
			t.Fatalf("worker %d returned mismatched resource IDs: %+v vs %+v", w, results[w], results[0])
		}
	}
	afterConcurrentDaily, _ := repo.DailyUploadBytes("owner", today)
	wantConcurrentDaily := beforeDaily + 256*1024 + 1536*1024
	if afterConcurrentDaily != wantConcurrentDaily {
		t.Fatalf("concurrent replay miscounted daily upload bytes: got=%d want=%d", afterConcurrentDaily, wantConcurrentDaily)
	}

	// 6. Corrupt media returns sanitized 400 to client while retaining redacted diagnostic cause for server logging.
	installAssetFakeMediaTools(t, "corrupt")
	_, corruptErr := svc.ExtractVideoFrames(context.Background(), "owner", srcA.ID, ExtractVideoFramesRequest{Preset: "first"}, "")
	var appErr *kernel.AppError
	if !errors.As(corruptErr, &appErr) || appErr.Status != 400 {
		t.Fatalf("expected sanitized 400 AppError, got %#v", corruptErr)
	}
	if strings.Contains(appErr.Message, dataDir) || strings.Contains(appErr.Message, "Invalid data") {
		t.Fatalf("AppError client message leaked raw stderr or local path: %q", appErr.Message)
	}
	internalCause := errors.Unwrap(appErr)
	if internalCause == nil || !strings.Contains(internalCause.Error(), "Invalid data found when processing input") {
		t.Fatalf("expected internal cause to retain redacted diagnostic detail, got %v", internalCause)
	}
	if strings.Contains(internalCause.Error(), dataDir) || strings.Contains(internalCause.Error(), "Workspace With Spaces") {
		t.Fatalf("internal cause leaked local path with spaces: %q", internalCause.Error())
	}
}

func TestServiceExtractFramesAndSeparateAudioLifecycle(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	videoBytes := makeVideoFixtureBytes(t, true, "3.2")
	source, _, err := svc.Store("owner", "video", "clip.mp4", "video/mp4", int64(len(videoBytes)), 80, 60, 0, bytes.NewReader(videoBytes), nil)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ExtractVideoFrames(context.Background(), "intruder", source.ID, ExtractVideoFramesRequest{Preset: "last"}, ""); err == nil {
		t.Fatal("foreign user must not extract frames")
	}

	tailRes, err := svc.ExtractVideoFrames(context.Background(), "owner", source.ID, ExtractVideoFramesRequest{Preset: "last"}, "idem-tail")
	if err != nil || len(tailRes.Frames) != 1 {
		t.Fatalf("extract tail: %+v %v", tailRes, err)
	}
	if tailRes.Frames[0].Resource.Width != 80 || tailRes.Frames[0].Resource.Height != 60 || tailRes.Frames[0].Resource.Kind != "image" {
		t.Fatalf("unexpected frame resource: %+v", tailRes.Frames[0].Resource)
	}
	retryTail, err := svc.ExtractVideoFrames(context.Background(), "owner", source.ID, ExtractVideoFramesRequest{Preset: "last"}, "idem-tail")
	if err != nil || retryTail.Frames[0].Resource.ID != tailRes.Frames[0].Resource.ID {
		t.Fatalf("idempotency broken: %+v vs %+v (%v)", retryTail, tailRes, err)
	}

	separated, err := svc.SeparateVideoAudio(context.Background(), "owner", source.ID, "idem-split")
	if err != nil {
		t.Fatalf("separate audio: %v", err)
	}
	if separated.Audio.Kind != "audio" || (separated.Audio.MimeType != "audio/mpeg" && separated.Audio.MimeType != "audio/wav") || separated.Audio.DurationMs <= 0 {
		t.Fatalf("unexpected audio resource: %+v", separated.Audio)
	}
	if separated.MutedVideo.Kind != "video" || separated.MutedVideo.Width != 80 || separated.MutedVideo.Height != 60 {
		t.Fatalf("unexpected muted video resource: %+v", separated.MutedVideo)
	}
	retrySplit, err := svc.SeparateVideoAudio(context.Background(), "owner", source.ID, "idem-split")
	if err != nil || retrySplit.Audio.ID != separated.Audio.ID || retrySplit.MutedVideo.ID != separated.MutedVideo.ID {
		t.Fatalf("split idempotency broken: %+v vs %+v (%v)", retrySplit, separated, err)
	}

	// Minimal FFmpeg builds without libmp3lame fall back cleanly to PCM WAV (audio/wav), never audio/mp4.
	installAssetFakeMediaTools(t, "no_mp3_encoder")
	wavSplit, err := svc.SeparateVideoAudio(context.Background(), "owner", source.ID, "idem-split-wav-fallback")
	if err != nil {
		t.Fatalf("separate audio wav fallback failed: %v", err)
	}
	if wavSplit.Audio.Kind != "audio" || wavSplit.Audio.MimeType != "audio/wav" || !strings.HasSuffix(wavSplit.Audio.ObjectKey, ".wav") {
		t.Fatalf("expected audio/wav .wav fallback when libmp3lame unavailable, got %+v", wavSplit.Audio)
	}
}

func TestServiceSeparateAudioErrorsAreTyped(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	silentBytes := makeVideoFixtureBytes(t, false, "")
	silent, _, err := svc.Store("owner", "video", "silent.mp4", "video/mp4", int64(len(silentBytes)), 80, 60, 800, bytes.NewReader(silentBytes), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.SeparateVideoAudio(context.Background(), "owner", silent.ID, "")
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != 400 {
		t.Fatalf("expected 400 AppError for silent video, got %#v", err)
	}

	t.Setenv(mediatools.FFmpegPathEnv, filepath.Join(t.TempDir(), "missing-ffmpeg"))
	t.Setenv(mediatools.FFprobePathEnv, filepath.Join(t.TempDir(), "missing-ffprobe"))
	_, err = svc.ExtractVideoFrames(context.Background(), "owner", silent.ID, ExtractVideoFramesRequest{Preset: "first"}, "")
	if !errors.As(err, &appErr) || appErr.Status != kernel.CodeUnavailable || appErr.Reason != kernel.ReasonUnavailable {
		t.Fatalf("expected 503 unavailable when native tool missing, got %#v", err)
	}
}
