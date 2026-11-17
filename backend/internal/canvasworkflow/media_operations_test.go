package canvasworkflow

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestWorkflowMediaOperationsCompileClosedArguments(t *testing.T) {
	cases := []struct {
		id, kind string
		config   map[string]any
		want     []string
	}{
		{"image.crop", "image", map[string]any{"x": 0.25, "y": 0.0, "width": 0.5, "height": 1.0}, []string{"-vf", "crop=640:720:320:0", "-frames:v", "1", "-an"}},
		{"image.resize", "image", map[string]any{"longEdge": 2048.0}, []string{"-vf", "scale=2048:1152:flags=bicubic", "-frames:v", "1", "-an"}},
		{"video.frame", "image", map[string]any{"seconds": 1.5}, []string{"-ss", "1.500", "-frames:v", "1", "-an"}},
		{"video.audio", "audio", nil, []string{"-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"}},
	}
	for _, tc := range cases {
		n := Node{ID: "step", Role: "operation", OperationID: tc.id, OperationVersion: 1, MediaType: tc.kind, Config: tc.config}
		args, ext, mime, err := MediaCommand(n, 1280, 720)
		if err != nil || !reflect.DeepEqual(args, tc.want) {
			t.Fatalf("%s: %v %v", tc.id, args, err)
		}
		if tc.id == "video.audio" && (ext != ".mp3" || mime != "audio/mpeg") {
			t.Fatalf("video.audio must emit compact reference-compatible audio/mpeg first, got ext=%q mime=%q", ext, mime)
		}
	}
}

func TestWorkflowMediaOperationsRejectInvalidConfig(t *testing.T) {
	for _, config := range []map[string]any{{"x": 0.8, "width": 0.5, "height": 1.0}, {"width": 0.0, "height": 1.0}, {"width": 1.0, "height": 1.0, "filter": "arbitrary"}} {
		if err := ValidateOperation(Node{ID: "crop", Role: "operation", OperationID: "image.crop", OperationVersion: 1, MediaType: "image", Config: config}); err == nil {
			t.Fatal("invalid crop accepted")
		}
	}
	n := Node{ID: "crop", Role: "operation", OperationID: "video.crop", OperationVersion: 1, MediaType: "video", Config: map[string]any{"width": 1.0, "height": 1.0}}
	args, ext, mime, err := MediaCommand(n, 1279, 719)
	if err != nil || args[1] != "crop=1278:718:0:0" || ext != ".mp4" || mime != "video/mp4" {
		t.Fatalf("video crop: %v %s %s %v", args, ext, mime, err)
	}
}

func TestExecuteMediaCommandsFallsBackToWavWhenMp3EncoderUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake ffmpeg test uses POSIX script")
	}
	dir := t.TempDir()
	fakeBin := filepath.Join(dir, "fake-ffmpeg")
	script := "#!/bin/sh\n" +
		"out=\"\"\n" +
		"is_mp3=0\n" +
		"for arg in \"$@\"; do\n" +
		"  if [ \"$arg\" = \"libmp3lame\" ]; then is_mp3=1; fi\n" +
		"  out=\"$arg\"\n" +
		"done\n" +
		"if [ \"$is_mp3\" = \"1\" ]; then\n" +
		"  printf 'partial' > \"$out\"\n" +
		"  exit 1\n" +
		"fi\n" +
		"printf 'RIFFxxxxWAVEfmt ' > \"$out\"\n" +
		"exit 0\n"
	if err := os.WriteFile(fakeBin, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}

	node := Node{ID: "audio", Role: "operation", OperationID: "video.audio", OperationVersion: 1, MediaType: "audio"}
	candidates, err := MediaCommandCandidates(node, 1280, 720)
	if err != nil {
		t.Fatalf("MediaCommandCandidates: %v", err)
	}
	if len(candidates) != 2 || candidates[0].Ext != ".mp3" || candidates[1].Ext != ".wav" {
		t.Fatalf("unexpected candidates: %+v", candidates)
	}

	workDir := filepath.Join(dir, "work")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir work: %v", err)
	}
	output, chosen, err := ExecuteMediaCommands(context.Background(), fakeBin, []string{"-i", "source.mp4"}, workDir, candidates)
	if err != nil {
		t.Fatalf("ExecuteMediaCommands failed: %v", err)
	}
	if chosen.Ext != ".wav" || chosen.Mime != "audio/wav" || filepath.Base(output) != "result.wav" {
		t.Fatalf("expected .wav fallback, got output=%q chosen=%+v", output, chosen)
	}
	if _, statErr := os.Stat(filepath.Join(workDir, "result.mp3")); !os.IsNotExist(statErr) {
		t.Fatalf("expected failed result.mp3 to be cleaned up, statErr=%v", statErr)
	}
}
