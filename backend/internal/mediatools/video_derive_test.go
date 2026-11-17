package mediatools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestFakeMediaToolHelperProcess(t *testing.T) {
	mode := os.Getenv("BEEFTV_TEST_FAKE_TOOL")
	if mode == "" {
		return
	}
	scenario := os.Getenv("BEEFTV_TEST_FAKE_SCENARIO")
	args := os.Args
	sep := slices.Index(args, "--")
	toolArgs := args[1:]
	if sep >= 0 {
		toolArgs = args[sep+1:]
	}

	switch mode {
	case "ffprobe":
		target := toolArgs[len(toolArgs)-1]
		if strings.HasSuffix(target, ".m4a") || strings.HasSuffix(target, ".mp3") || strings.HasSuffix(target, ".wav") {
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"audio","codec_name":"aac","duration":"1.200"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.200"}}`)
			os.Exit(0)
		}
		if strings.Contains(target, "muted-video") {
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":80,"height":60,"avg_frame_rate":"10/1","duration":"1.200"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.200"}}`)
			os.Exit(0)
		}
		if scenario == "silent" {
			_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":80,"height":60,"avg_frame_rate":"10/1","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
			os.Exit(0)
		}
		_, _ = fmt.Fprint(os.Stdout, `{"streams":[{"codec_type":"video","codec_name":"h264","width":80,"height":60,"avg_frame_rate":"10/1","duration":"1.000"},{"codec_type":"audio","codec_name":"aac","duration":"1.000"}],"format":{"format_name":"mov,mp4,m4a","duration":"1.000"}}`)
		os.Exit(0)

	case "ffmpeg":
		if logFile := os.Getenv("BEEFTV_TEST_FAKE_LOG"); logFile != "" {
			f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
			if err == nil {
				_, _ = fmt.Fprintln(f, strings.Join(toolArgs, " "))
				_ = f.Close()
			}
		}
		if scenario == "corrupt_first" {
			_, _ = fmt.Fprintf(os.Stderr, "%s: Invalid data found when processing input\n", strings.Join(toolArgs, " "))
			os.Exit(1)
		}
		if scenario == "fail_mid_500" && slices.Contains(toolArgs, "0.500") {
			_, _ = fmt.Fprintln(os.Stderr, "Error while decoding stream #0:0: Invalid data found when processing input")
			os.Exit(1)
		}
		for _, arg := range toolArgs {
			if strings.HasSuffix(arg, ".png") {
				img := image.NewRGBA(image.Rect(0, 0, 80, 60))
				for y := 0; y < 60; y++ {
					for x := 0; x < 80; x++ {
						img.Set(x, y, color.RGBA{R: 40, G: 120, B: 220, A: 255})
					}
				}
				var buf bytes.Buffer
				_ = png.Encode(&buf, img)
				_ = os.WriteFile(arg, buf.Bytes(), 0o600)
			} else if strings.HasSuffix(arg, ".m4a") || strings.HasSuffix(arg, ".mp4") {
				_ = os.WriteFile(arg, bytes.Repeat([]byte("media-bytes-"), 32), 0o600)
			}
		}
		os.Exit(0)
	}
	os.Exit(2)
}

func installFakeMediaTools(t *testing.T, scenario string) string {
	t.Helper()
	testBin, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "ffmpeg-invocations.log")
	writeWrapper := func(name, toolMode string) string {
		scriptPath := filepath.Join(dir, name)
		content := fmt.Sprintf("#!/bin/sh\nexport BEEFTV_TEST_FAKE_TOOL=%s\nexport BEEFTV_TEST_FAKE_SCENARIO=%s\nexport BEEFTV_TEST_FAKE_LOG=%q\nexec %q -test.run=^TestFakeMediaToolHelperProcess$ -- \"$@\"\n",
			toolMode, scenario, logPath, testBin)
		if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
			t.Fatalf("write wrapper %s: %v", name, err)
		}
		return scriptPath
	}
	if os.PathSeparator == '\\' {
		t.Skip("shell wrapper helper uses POSIX sh")
	}
	t.Setenv(FFmpegPathEnv, writeWrapper("fake-ffmpeg", "ffmpeg"))
	t.Setenv(FFprobePathEnv, writeWrapper("fake-ffprobe", "ffprobe"))
	return logPath
}

func requireNativeFFmpeg(t *testing.T) string {
	t.Helper()
	bin, err := ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	return bin
}

func decodePNGPixel(t *testing.T, path string) (r, g, b uint8) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	img, err := png.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	bounds := img.Bounds()
	cr, cg, cb, _ := img.At(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+bounds.Dy()/2).RGBA()
	return uint8(cr >> 8), uint8(cg >> 8), uint8(cb >> 8)
}

func TestNormalizeFrameTargetsPreservesDistinctNearEndTimestampsAnd30Cap(t *testing.T) {
	targets, err := normalizeFrameTargets("", []int64{860, 980, 0}, 1000, 10)
	if err != nil {
		t.Fatalf("normalizeFrameTargets error: %v", err)
	}
	if len(targets) != 3 || targets[0].timeMs != 0 || targets[1].timeMs != 860 || targets[2].timeMs != 980 {
		t.Fatalf("expected [0, 860, 980] preserved without collapsing, got %+v", targets)
	}
	if targets[0].allowTailRescue || targets[0].isTail {
		t.Fatalf("0ms target must not enable tail rescue: %+v", targets[0])
	}

	firstTargets, err := normalizeFrameTargets("first", nil, 1000, 24)
	if err != nil || len(firstTargets) != 1 || firstTargets[0].isTail || firstTargets[0].allowTailRescue {
		t.Fatalf("first preset must never allow tail rescue: %+v %v", firstTargets, err)
	}

	thirty := make([]int64, 30)
	for i := range thirty {
		thirty[i] = int64(i * 30)
	}
	if got, err := normalizeFrameTargets("", thirty, 2000, 25); err != nil || len(got) != 30 {
		t.Fatalf("30 frames must succeed, got len=%d err=%v", len(got), err)
	}

	thirtyOne := make([]int64, 31)
	for i := range thirtyOne {
		thirtyOne[i] = int64(i * 30)
	}
	if _, err := normalizeFrameTargets("", thirtyOne, 2000, 25); err == nil {
		t.Fatal("31 frames must be rejected")
	}
}

func TestExtractVideoFramesFakeToolNeverSubstitutesTailAndSanitizesPaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Library Application Support")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "private source clip.mp4")
	if err := os.WriteFile(src, []byte("placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. Corrupt first frame: must NOT invoke -sseof tail rescue and must NOT leak local paths (including spaces) in error.
	logCorrupt := installFakeMediaTools(t, "corrupt_first")
	_, err := ExtractVideoFrames(context.Background(), src, filepath.Join(dir, "out corrupt"), "first", nil)
	if !errors.Is(err, ErrInvalidMedia) {
		t.Fatalf("expected ErrInvalidMedia, got %v", err)
	}
	if strings.Contains(err.Error(), dir) || strings.Contains(err.Error(), "Application Support") || strings.Contains(err.Error(), "private source clip") {
		t.Fatalf("error leaked local path with spaces: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "Invalid data found when processing input") {
		t.Fatalf("expected redacted diagnostic detail preserved for server logging, got %q", err.Error())
	}
	if relRedacted := RedactDiagnosticText("sub folder/nested clip.mp4: moov atom not found", "sub folder/nested clip.mp4"); strings.Contains(relRedacted, "sub folder") || strings.Contains(relRedacted, "nested clip") || !strings.Contains(relRedacted, "moov atom not found") {
		t.Fatalf("relative spaced path not redacted cleanly: %q", relRedacted)
	}
	invocations, _ := os.ReadFile(logCorrupt)
	if strings.Contains(string(invocations), "-sseof") || strings.Contains(string(invocations), "-update") {
		t.Fatalf("preset=first must not invoke tail frame fallback; invocations:\n%s", invocations)
	}

	// 2. Partial mid-point decode failure: 0ms succeeds, 500ms fails -> returns 0ms + Failures[{500}], never tail fallback.
	logMid := installFakeMediaTools(t, "fail_mid_500")
	partial, err := ExtractVideoFrames(context.Background(), src, filepath.Join(dir, "out-partial"), "", []int64{0, 500})
	if err != nil {
		t.Fatalf("expected partial success, got error: %v", err)
	}
	if len(partial.Frames) != 1 || partial.Frames[0].TimeMs != 0 {
		t.Fatalf("unexpected frames: %+v", partial.Frames)
	}
	if len(partial.Failures) != 1 || partial.Failures[0].TimeMs != 500 {
		t.Fatalf("expected failure recorded at 500ms, got %+v", partial.Failures)
	}
	midInvocations, _ := os.ReadFile(logMid)
	if strings.Contains(string(midInvocations), "-sseof") {
		t.Fatalf("mid-point failure must not invoke tail fallback; invocations:\n%s", midInvocations)
	}

	// 3. Full 30-frame batch succeeds without native ffmpeg.
	installFakeMediaTools(t, "ok")
	thirty := make([]int64, 30)
	for i := range thirty {
		thirty[i] = int64(i * 25)
	}
	batch30, err := ExtractVideoFrames(context.Background(), src, filepath.Join(dir, "out-30"), "", thirty)
	if err != nil || len(batch30.Frames) != 30 || len(batch30.Failures) != 0 {
		t.Fatalf("expected 30 extracted frames with 0 failures, got frames=%d failures=%d err=%v", len(batch30.Frames), len(batch30.Failures), err)
	}
}

func TestExtractVideoFramesHandlesLongerAudioTailAndExactColors(t *testing.T) {
	ffmpegBin := requireNativeFFmpeg(t)
	dir := t.TempDir()
	videoPath := filepath.Join(dir, "tail-audio-mismatch.mp4")

	// 0.0s-0.5s pure red, 0.5s-1.0s pure blue, while AAC audio continues to 5.0s (4s longer than video).
	cmd := exec.Command(ffmpegBin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=0.5",
		"-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=0.5",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=5.0",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
		"-map", "[v]", "-map", "2:a",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
		videoPath,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v\n%s", err, out)
	}

	firstRes, err := ExtractVideoFrames(context.Background(), videoPath, filepath.Join(dir, "first"), "first", nil)
	if err != nil || len(firstRes.Frames) != 1 {
		t.Fatalf("extract first: %+v %v", firstRes, err)
	}
	fr, fg, fb := decodePNGPixel(t, firstRes.Frames[0].Path)
	if fr < 180 || fb > 80 || fg > 80 {
		t.Fatalf("expected red first frame, got RGB(%d,%d,%d)", fr, fg, fb)
	}
	if firstRes.Frames[0].Width != 64 || firstRes.Frames[0].Height != 48 {
		t.Fatalf("unexpected dimensions: %+v", firstRes.Frames[0])
	}

	lastRes, err := ExtractVideoFrames(context.Background(), videoPath, filepath.Join(dir, "last"), "last", nil)
	if err != nil || len(lastRes.Frames) != 1 {
		t.Fatalf("extract last: %+v %v", lastRes, err)
	}
	lr, lg, lb := decodePNGPixel(t, lastRes.Frames[0].Path)
	if lb < 180 || lr > 80 || lg > 80 {
		t.Fatalf("expected blue last frame despite 4s trailing audio, got RGB(%d,%d,%d)", lr, lg, lb)
	}

	// Timestamp near container end (4800ms > 1000ms video end) clamps to video end and recovers the real blue tail frame.
	batchRes, err := ExtractVideoFrames(context.Background(), videoPath, filepath.Join(dir, "batch"), "", []int64{0, 4800})
	if err != nil || len(batchRes.Frames) != 2 {
		t.Fatalf("extract batch: %+v %v", batchRes, err)
	}
	br, bg, bb := decodePNGPixel(t, batchRes.Frames[1].Path)
	if bb < 180 || br > 80 || bg > 80 {
		t.Fatalf("expected blue tail fallback frame, got RGB(%d,%d,%d)", br, bg, bb)
	}

	// Distinct near-end timestamps (860ms and 980ms) must both succeed without collapsing into 1 frame.
	nearEndRes, err := ExtractVideoFrames(context.Background(), videoPath, filepath.Join(dir, "near-end"), "", []int64{860, 980})
	if err != nil || len(nearEndRes.Frames) != 2 || len(nearEndRes.Failures) != 0 {
		t.Fatalf("near-end distinct frames collapsed or failed: %+v %v", nearEndRes, err)
	}
	if nearEndRes.Frames[0].TimeMs != 860 || nearEndRes.Frames[1].TimeMs != 980 {
		t.Fatalf("near-end timestamps rewritten: %+v", nearEndRes.Frames)
	}
}

func TestSeparateVideoAudioSinglePassAndSilentRejection(t *testing.T) {
	ffmpegBin := requireNativeFFmpeg(t)
	dir := t.TempDir()

	withAudio := filepath.Join(dir, "with-audio.mp4")
	cmd := exec.Command(ffmpegBin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc=size=96x64:rate=15:d=1.2",
		"-f", "lavfi", "-i", "sine=frequency=660:duration=1.2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
		withAudio,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create with-audio fixture: %v\n%s", err, out)
	}

	separated, err := SeparateVideoAudio(context.Background(), withAudio, filepath.Join(dir, "out"))
	if err != nil {
		t.Fatalf("SeparateVideoAudio failed: %v", err)
	}
	if separated.Audio.Mime != "audio/mp4" || separated.Audio.Size <= 0 || separated.Audio.DurationMs < 900 {
		t.Fatalf("unexpected audio output: %+v", separated.Audio)
	}
	if separated.MutedVideo.Mime != "video/mp4" || separated.MutedVideo.Width != 96 || separated.MutedVideo.Height != 64 || separated.MutedVideo.Size <= 0 {
		t.Fatalf("unexpected muted video output: %+v", separated.MutedVideo)
	}
	mutedFacts, err := ProbeLocal(context.Background(), separated.MutedVideo.Path)
	if err != nil || !mutedFacts.HasVideo || mutedFacts.HasAudio {
		t.Fatalf("muted video still has audio or lost video: %+v %v", mutedFacts, err)
	}

	silent := filepath.Join(dir, "silent.mp4")
	cmdSilent := exec.Command(ffmpegBin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=green:s=64x64:r=10:d=0.6",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
		silent,
	)
	if out, err := cmdSilent.CombinedOutput(); err != nil {
		t.Fatalf("create silent fixture: %v\n%s", err, out)
	}
	if _, err := SeparateVideoAudio(context.Background(), silent, filepath.Join(dir, "out-silent")); !errors.Is(err, ErrNoAudioTrack) {
		t.Fatalf("expected ErrNoAudioTrack, got %v", err)
	}
}
