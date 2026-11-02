package mediatools

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type MediaMetadata struct {
	FormatName         string
	Width, Height      int
	DurationMs         int64
	FPS                float64
	HasAudio, HasVideo bool
}

// ProbeLocal only accepts an existing local regular file. Protocol restrictions
// prevent a playlist or container from making network requests during probing.
func ProbeLocal(ctx context.Context, path string) (MediaMetadata, error) {
	var facts MediaMetadata
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return facts, fmt.Errorf("媒体文件无法读取")
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return facts, err
	}
	bin, err := ResolveFFprobe()
	if err != nil {
		return facts, err
	}
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-protocol_whitelist", "file,pipe",
		"-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration:format=duration,format_name", "-of", "json", path)
	HideConsole(cmd)
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return facts, ctx.Err()
	}
	if err != nil {
		return facts, fmt.Errorf("无法检查媒体，请确认素材完整且媒体工具可用")
	}
	var parsed struct {
		Streams []struct {
			CodecType     string `json:"codec_type"`
			Width, Height int
			AvgFrameRate  string `json:"avg_frame_rate"`
			Duration      string `json:"duration"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &parsed); err != nil {
		return facts, fmt.Errorf("无法解析媒体检查结果")
	}
	facts.DurationMs = probeDuration(parsed.Format.Duration)
	facts.FormatName = parsed.Format.FormatName
	for _, stream := range parsed.Streams {
		if stream.CodecType == "audio" {
			facts.HasAudio = true
		}
		if stream.CodecType == "video" {
			facts.HasVideo = true
			if facts.Width == 0 {
				facts.Width, facts.Height = stream.Width, stream.Height
			}
			if facts.FPS == 0 {
				facts.FPS = probeFrameRate(stream.AvgFrameRate)
			}
		}
		if facts.DurationMs == 0 {
			facts.DurationMs = probeDuration(stream.Duration)
		}
	}
	return facts, nil
}

func probeFrameRate(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if numStr, denStr, ok := strings.Cut(raw, "/"); ok {
		num, err1 := strconv.ParseFloat(strings.TrimSpace(numStr), 64)
		den, err2 := strconv.ParseFloat(strings.TrimSpace(denStr), 64)
		if err1 != nil || err2 != nil || num <= 0 || den <= 0 {
			return 0
		}
		fps := num / den
		if math.IsNaN(fps) || math.IsInf(fps, 0) {
			return 0
		}
		return fps
	}
	fps, err := strconv.ParseFloat(raw, 64)
	if err != nil || fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) {
		return 0
	}
	return fps
}

func probeDuration(raw string) int64 {
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds >= float64(math.MaxInt64)/1000 {
		return 0
	}
	return int64(math.Round(seconds * 1000))
}
