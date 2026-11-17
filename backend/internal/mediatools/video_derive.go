package mediatools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const MaxExtractedFrames = 30

var (
	ErrNoVideoTrack       = errors.New("media has no video track")
	ErrNoAudioTrack       = errors.New("video has no audio track")
	ErrInvalidMedia       = errors.New("invalid or unsupported media")
	ErrMediaProcessFailed = errors.New("media processing failed")
)

type ExtractedFrame struct {
	TimeMs int64
	Path   string
	Mime   string
	Size   int64
	Width  int
	Height int
}

type ExtractedFrameFailure struct {
	TimeMs int64
	Reason string
}

type ExtractedFrames struct {
	Frames     []ExtractedFrame
	Failures   []ExtractedFrameFailure
	DurationMs int64
}

type DerivedMediaFile struct {
	Path       string
	FileName   string
	Mime       string
	Size       int64
	Width      int
	Height     int
	DurationMs int64
}

type SeparatedMedia struct {
	Audio      DerivedMediaFile
	MutedVideo DerivedMediaFile
	DurationMs int64
}

type frameTarget struct {
	timeMs          int64
	seekMs          int64
	isTail          bool
	allowTailRescue bool
}

// ExtractVideoFrames decodes exact PNG frames from a local video file using native ffmpeg.
// Tail frames decode through the end of the primary video stream (-update 1) so trailing
// audio packets or B-frame reorder timestamps never produce empty or black outputs.
func ExtractVideoFrames(ctx context.Context, srcPath string, outDir string, preset string, timesMs []int64) (*ExtractedFrames, error) {
	if err := ensureRegularFile(srcPath); err != nil {
		return nil, err
	}
	facts, err := ProbeLocal(ctx, srcPath)
	if err != nil {
		return nil, err
	}
	if !facts.HasVideo || facts.Width <= 0 || facts.Height <= 0 {
		return nil, ErrNoVideoTrack
	}
	ffmpegBin, err := ResolveFFmpeg()
	if err != nil {
		return nil, err
	}
	videoDurationMs := facts.VideoDurationMs
	if videoDurationMs <= 0 {
		videoDurationMs = facts.DurationMs
	}
	targets, err := normalizeFrameTargets(preset, timesMs, videoDurationMs, facts.FPS)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		return nil, fmt.Errorf("%w：创建临时目录失败", ErrMediaProcessFailed)
	}
	frames := make([]ExtractedFrame, 0, len(targets))
	failures := make([]ExtractedFrameFailure, 0)
	var firstFrameErr error
	allowPartial := strings.TrimSpace(preset) == "" && len(targets) > 1
	for index, target := range targets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		outPath := filepath.Join(outDir, fmt.Sprintf("frame-%02d.png", index))
		if err := extractSingleFrame(ctx, ffmpegBin, srcPath, outPath, target, facts); err != nil {
			if ctx.Err() != nil || errors.Is(err, ErrToolUnavailable) {
				return nil, err
			}
			if !allowPartial {
				return nil, err
			}
			if firstFrameErr == nil {
				firstFrameErr = err
			}
			failures = append(failures, ExtractedFrameFailure{
				TimeMs: target.timeMs,
				Reason: "画面提取失败",
			})
			continue
		}
		width, height, size, err := inspectPNGFile(outPath)
		if err != nil {
			frameErr := fmt.Errorf("%w：提取的视频帧无效", ErrInvalidMedia)
			if !allowPartial {
				return nil, frameErr
			}
			if firstFrameErr == nil {
				firstFrameErr = frameErr
			}
			failures = append(failures, ExtractedFrameFailure{
				TimeMs: target.timeMs,
				Reason: "画面提取失败",
			})
			continue
		}
		frames = append(frames, ExtractedFrame{
			TimeMs: target.timeMs,
			Path:   outPath,
			Mime:   "image/png",
			Size:   size,
			Width:  width,
			Height: height,
		})
	}
	if len(frames) == 0 {
		if firstFrameErr != nil {
			return nil, firstFrameErr
		}
		return nil, fmt.Errorf("%w：无法提取视频画面", ErrInvalidMedia)
	}
	durationMs := facts.DurationMs
	if durationMs <= 0 {
		durationMs = videoDurationMs
	}
	return &ExtractedFrames{Frames: frames, Failures: failures, DurationMs: durationMs}, nil
}

func estimateFrameIntervalMs(fps float64) int64 {
	if fps > 0 && !math.IsNaN(fps) && !math.IsInf(fps, 0) {
		interval := int64(math.Ceil(1000.0 / fps))
		return max(int64(16), min(int64(250), interval))
	}
	return 50
}

func normalizeFrameTargets(preset string, timesMs []int64, videoDurationMs int64, fps float64) ([]frameTarget, error) {
	switch strings.TrimSpace(preset) {
	case "first":
		return []frameTarget{{timeMs: 0, seekMs: 0}}, nil
	case "last":
		displayMs := int64(0)
		if videoDurationMs > 0 {
			displayMs = videoDurationMs - 1
		}
		return []frameTarget{{timeMs: displayMs, seekMs: displayMs, isTail: true, allowTailRescue: true}}, nil
	case "":
		if len(timesMs) == 0 {
			return nil, fmt.Errorf("请选择要截取的时间点")
		}
		if len(timesMs) > MaxExtractedFrames {
			return nil, fmt.Errorf("单次最多截取 %d 帧", MaxExtractedFrames)
		}
		frameIntervalMs := estimateFrameIntervalMs(fps)
		tailWindowMs := max(int64(150), frameIntervalMs+20)
		normalized := make([]frameTarget, 0, len(timesMs))
		for _, raw := range timesMs {
			clamped := max(int64(0), raw)
			if videoDurationMs > 0 && clamped >= videoDurationMs {
				clamped = videoDurationMs - 1
			}
			seekMs := clamped
			allowTailRescue := false
			if videoDurationMs > 0 && clamped >= max(int64(1), videoDurationMs-tailWindowMs) {
				allowTailRescue = true
				maxSafeSeek := max(int64(0), videoDurationMs-frameIntervalMs-5)
				if seekMs > maxSafeSeek {
					seekMs = maxSafeSeek
				}
			}
			normalized = append(normalized, frameTarget{
				timeMs:          clamped,
				seekMs:          seekMs,
				allowTailRescue: allowTailRescue,
			})
		}
		slices.SortFunc(normalized, func(a, b frameTarget) int {
			if a.timeMs < b.timeMs {
				return -1
			}
			if a.timeMs > b.timeMs {
				return 1
			}
			return 0
		})
		deduped := make([]frameTarget, 0, len(normalized))
		for _, item := range normalized {
			if n := len(deduped); n > 0 && deduped[n-1].timeMs == item.timeMs {
				if item.allowTailRescue {
					deduped[n-1].allowTailRescue = true
				}
				continue
			}
			deduped = append(deduped, item)
		}
		return deduped, nil
	default:
		return nil, fmt.Errorf("不支持的截帧模式")
	}
}

func extractSingleFrame(ctx context.Context, ffmpegBin, srcPath, outPath string, target frameTarget, facts MediaMetadata) error {
	_ = os.Remove(outPath)
	if target.isTail {
		return extractTailFrame(ctx, ffmpegBin, srcPath, outPath, facts)
	}
	var err error
	if target.seekMs <= 0 {
		err = runFFmpeg(ctx, ffmpegBin, "-protocol_whitelist", "file,pipe", "-i", srcPath, "-map", "0:v:0", "-frames:v", "1", outPath)
	} else {
		seekSec := formatSeconds(float64(target.seekMs) / 1000.0)
		err = runFFmpeg(ctx, ffmpegBin, "-ss", seekSec, "-protocol_whitelist", "file,pipe", "-i", srcPath, "-map", "0:v:0", "-frames:v", "1", outPath)
	}
	if err == nil && hasValidPNG(outPath) {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, ErrToolUnavailable) {
		return err
	}
	if target.allowTailRescue {
		// Near-end timestamps can land inside a trailing audio tail or past the last frame PTS.
		return extractTailFrame(ctx, ffmpegBin, srcPath, outPath, facts)
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("%w：无法在指定时间点提取画面", ErrInvalidMedia)
}

func extractTailFrame(ctx context.Context, ffmpegBin, srcPath, outPath string, facts MediaMetadata) error {
	_ = os.Remove(outPath)
	if err := runFFmpeg(ctx, ffmpegBin, "-sseof", "-3", "-protocol_whitelist", "file,pipe", "-i", srcPath, "-map", "0:v:0", "-update", "1", outPath); err == nil && hasValidPNG(outPath) {
		return nil
	} else if errors.Is(err, ErrToolUnavailable) {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if facts.VideoDurationMs > 0 {
		_ = os.Remove(outPath)
		seekSec := formatSeconds(math.Max(0, float64(facts.VideoDurationMs)/1000.0-2.0))
		if err := runFFmpeg(ctx, ffmpegBin, "-ss", seekSec, "-protocol_whitelist", "file,pipe", "-i", srcPath, "-map", "0:v:0", "-update", "1", outPath); err == nil && hasValidPNG(outPath) {
			return nil
		} else if errors.Is(err, ErrToolUnavailable) {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	_ = os.Remove(outPath)
	if err := runFFmpeg(ctx, ffmpegBin, "-protocol_whitelist", "file,pipe", "-i", srcPath, "-map", "0:v:0", "-update", "1", outPath); err != nil {
		return err
	}
	if !hasValidPNG(outPath) {
		return fmt.Errorf("%w：无法提取视频尾帧，请检查视频画面是否完整", ErrInvalidMedia)
	}
	return nil
}

// SeparateVideoAudio demuxes a local video into a standalone audio file and a muted MP4
// in a single native ffmpeg pass, preferring lossless stream copy whenever container-compatible
// and automatically falling back to AAC / H.264 re-encoding when stream copy cannot remux cleanly.
func SeparateVideoAudio(ctx context.Context, srcPath string, outDir string) (*SeparatedMedia, error) {
	if err := ensureRegularFile(srcPath); err != nil {
		return nil, err
	}
	facts, err := ProbeLocal(ctx, srcPath)
	if err != nil {
		return nil, err
	}
	if !facts.HasVideo || facts.Width <= 0 || facts.Height <= 0 {
		return nil, ErrNoVideoTrack
	}
	if !facts.HasAudio {
		return nil, ErrNoAudioTrack
	}
	ffmpegBin, err := ResolveFFmpeg()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		return nil, fmt.Errorf("%w：创建临时目录失败", ErrMediaProcessFailed)
	}
	audioName, audioMime, audioArgs := buildAudioOutputSpec(facts.AudioCodec, outDir, true)
	audioPath := filepath.Join(outDir, audioName)
	mutedPath := filepath.Join(outDir, "muted-video.mp4")
	videoArgs := buildMutedVideoOutputArgs(facts.VideoCodec, mutedPath, true)

	args := append([]string{"-protocol_whitelist", "file,pipe", "-i", srcPath}, audioArgs...)
	args = append(args, videoArgs...)
	err = runFFmpeg(ctx, ffmpegBin, args...)
	if errors.Is(err, ErrToolUnavailable) {
		return nil, err
	}
	audioFacts, audioErr := ProbeLocal(ctx, audioPath)
	videoFacts, videoErr := ProbeLocal(ctx, mutedPath)
	if err != nil || audioErr != nil || videoErr != nil || !audioFacts.HasAudio || !videoFacts.HasVideo {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		_ = os.Remove(audioPath)
		_ = os.Remove(mutedPath)
		audioName, audioMime, audioArgs = buildAudioOutputSpec(facts.AudioCodec, outDir, false)
		audioPath = filepath.Join(outDir, audioName)
		videoArgs = buildMutedVideoOutputArgs(facts.VideoCodec, mutedPath, false)
		fallbackArgs := append([]string{"-protocol_whitelist", "file,pipe", "-i", srcPath}, audioArgs...)
		fallbackArgs = append(fallbackArgs, videoArgs...)
		if fallbackErr := runFFmpeg(ctx, ffmpegBin, fallbackArgs...); fallbackErr != nil {
			return nil, fallbackErr
		}
		audioFacts, err = ProbeLocal(ctx, audioPath)
		if err != nil || !audioFacts.HasAudio {
			return nil, fmt.Errorf("%w：音频提取失败，输出没有可用的音轨", ErrInvalidMedia)
		}
		videoFacts, err = ProbeLocal(ctx, mutedPath)
		if err != nil || !videoFacts.HasVideo {
			return nil, fmt.Errorf("%w：无声视频生成失败，输出没有可用的视频轨道", ErrInvalidMedia)
		}
	}
	audioInfo, err := os.Stat(audioPath)
	if err != nil || audioInfo.Size() <= 0 {
		return nil, fmt.Errorf("%w：音频提取失败，输出文件为空", ErrMediaProcessFailed)
	}
	videoInfo, err := os.Stat(mutedPath)
	if err != nil || videoInfo.Size() <= 0 {
		return nil, fmt.Errorf("%w：无声视频生成失败，输出文件为空", ErrMediaProcessFailed)
	}
	audioDuration := audioFacts.DurationMs
	if audioDuration <= 0 {
		audioDuration = facts.DurationMs
	}
	videoDuration := videoFacts.DurationMs
	if videoDuration <= 0 {
		videoDuration = facts.VideoDurationMs
	}
	if videoDuration <= 0 {
		videoDuration = facts.DurationMs
	}
	width, height := videoFacts.Width, videoFacts.Height
	if width <= 0 || height <= 0 {
		width, height = facts.Width, facts.Height
	}
	return &SeparatedMedia{
		Audio: DerivedMediaFile{
			Path:       audioPath,
			FileName:   audioName,
			Mime:       audioMime,
			Size:       audioInfo.Size(),
			DurationMs: audioDuration,
		},
		MutedVideo: DerivedMediaFile{
			Path:       mutedPath,
			FileName:   "muted-video.mp4",
			Mime:       "video/mp4",
			Size:       videoInfo.Size(),
			Width:      width,
			Height:     height,
			DurationMs: videoDuration,
		},
		DurationMs: max(facts.DurationMs, max(audioDuration, videoDuration)),
	}, nil
}

func buildAudioOutputSpec(codec string, outDir string, allowCopy bool) (fileName string, mime string, args []string) {
	if allowCopy {
		switch codec {
		case "aac", "alac":
			fileName = "extracted-audio.m4a"
			return fileName, "audio/mp4", []string{"-map", "0:a:0", "-vn", "-c:a", "copy", "-movflags", "+faststart", filepath.Join(outDir, fileName)}
		case "mp3":
			fileName = "extracted-audio.mp3"
			return fileName, "audio/mpeg", []string{"-map", "0:a:0", "-vn", "-c:a", "copy", filepath.Join(outDir, fileName)}
		case "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8":
			fileName = "extracted-audio.wav"
			return fileName, "audio/wav", []string{"-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", filepath.Join(outDir, fileName)}
		}
	}
	fileName = "extracted-audio.m4a"
	return fileName, "audio/mp4", []string{"-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", filepath.Join(outDir, fileName)}
}

func buildMutedVideoOutputArgs(codec string, outPath string, allowCopy bool) []string {
	if allowCopy {
		switch codec {
		case "h264", "hevc", "mpeg4", "av1":
			return []string{"-map", "0:V:0", "-an", "-c:v", "copy", "-movflags", "+faststart", outPath}
		}
	}
	return []string{"-map", "0:V:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath}
}

var (
	stderrURLPattern            = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"':]+`)
	stderrSpacedMediaPathRegexp = regexp.MustCompile(`(?i)(?:[A-Za-z]:)?[\\/][^\r\n"':]*?\.(?:mp4|mov|m4v|mkv|webm|avi|ts|m4a|mp3|wav|aac|flac|ogg|png|jpe?g|webp)`)
	stderrQuotedPathPattern     = regexp.MustCompile(`"[^"\r\n]*[\\/][^"\r\n]*"|'[^'\r\n]*[\\/][^'\r\n]*'`)
	stderrWinPathPattern        = regexp.MustCompile(`[A-Za-z]:[\\/][^\s"':]+`)
	stderrUnixPathPattern       = regexp.MustCompile(`(^|[\s"'=(])((?:\.{0,2}/)[^\s"':)]+)`)
	stderrMediaFilePattern      = regexp.MustCompile(`(?i)[^\s"':/\\]+\.(?:mp4|mov|m4v|mkv|webm|avi|ts|m4a|mp3|wav|aac|flac|ogg|png|jpe?g|webp)`)
)

type mediaToolDiagnosticError struct {
	sentinel error
	summary  string
	detail   string
}

func (e *mediaToolDiagnosticError) Error() string {
	if e.detail != "" {
		return fmt.Sprintf("%s：%s (%s)", e.sentinel.Error(), e.summary, e.detail)
	}
	return fmt.Sprintf("%s：%s", e.sentinel.Error(), e.summary)
}

func (e *mediaToolDiagnosticError) Unwrap() error {
	return e.sentinel
}

// IsPreRedactedDiagnostic reports whether err carries a media tool diagnostic
// whose stderr/path tokens were already sanitized at the mediatools boundary.
func IsPreRedactedDiagnostic(err error) bool {
	var diag *mediaToolDiagnosticError
	return errors.As(err, &diag) && diag != nil
}

// RedactDiagnosticText strips local filesystem paths (including paths with spaces
// and relative media paths), URLs, and filenames from media tool diagnostics so
// server logs retain actionable codec/demuxer failure details safely.
func RedactDiagnosticText(raw string, knownPaths ...string) string {
	candidates := make([]string, 0, len(knownPaths)*3)
	for _, p := range knownPaths {
		trimmed := strings.TrimSpace(p)
		if len(trimmed) < 2 || strings.HasPrefix(trimmed, "-") {
			continue
		}
		if strings.ContainsAny(trimmed, `/\`) || filepath.Ext(trimmed) != "" {
			candidates = append(candidates, trimmed, filepath.Clean(trimmed), filepath.ToSlash(trimmed))
			if dir := filepath.Dir(trimmed); dir != "." && dir != "/" && dir != `\` && len(dir) > 1 {
				candidates = append(candidates, dir, filepath.ToSlash(dir))
			}
		}
	}
	slices.SortFunc(candidates, func(a, b string) int {
		return len(b) - len(a)
	})
	sanitized := raw
	for _, candidate := range candidates {
		if candidate != "" {
			sanitized = strings.ReplaceAll(sanitized, candidate, "<path>")
		}
	}
	sanitized = stderrURLPattern.ReplaceAllString(sanitized, "<url>")
	sanitized = stderrQuotedPathPattern.ReplaceAllString(sanitized, "<path>")
	sanitized = stderrSpacedMediaPathRegexp.ReplaceAllString(sanitized, "<path>")
	sanitized = stderrWinPathPattern.ReplaceAllString(sanitized, "<path>")
	sanitized = stderrUnixPathPattern.ReplaceAllString(sanitized, "${1}<path>")
	sanitized = stderrMediaFilePattern.ReplaceAllString(sanitized, "<file>")
	collapsed := strings.Join(strings.Fields(sanitized), " ")
	runes := []rune(collapsed)
	if len(runes) > 240 {
		return string(runes[:240]) + "…"
	}
	return collapsed
}

func classifyFFmpegFailure(stderrText string, knownPaths ...string) error {
	lower := strings.ToLower(stderrText)
	detail := RedactDiagnosticText(stderrText, knownPaths...)
	invalidIndicators := []string{
		"invalid data found when processing input",
		"moov atom not found",
		"error while decoding",
		"corrupt",
		"damaged",
		"does not contain any stream",
		"could not find codec parameters",
		"unsupported codec",
		"decoder ",
	}
	for _, marker := range invalidIndicators {
		if strings.Contains(lower, marker) {
			return &mediaToolDiagnosticError{
				sentinel: ErrInvalidMedia,
				summary:  "视频文件损坏或编码格式不受支持",
				detail:   detail,
			}
		}
	}
	if strings.Contains(lower, "no space left on device") || strings.Contains(lower, "disk quota exceeded") {
		return &mediaToolDiagnosticError{
			sentinel: ErrMediaProcessFailed,
			summary:  "no space left on device",
			detail:   detail,
		}
	}
	return &mediaToolDiagnosticError{
		sentinel: ErrMediaProcessFailed,
		summary:  "本地视频处理未完成",
		detail:   detail,
	}
}

func runFFmpeg(ctx context.Context, binary string, args ...string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	fullArgs := append([]string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y"}, args...)
	cmd := exec.CommandContext(ctx, binary, fullArgs...)
	HideConsole(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("%w：视频处理工具不可用，请重新安装应用", ErrToolUnavailable)
		}
		return classifyFFmpegFailure(stderr.String(), append([]string{binary}, args...)...)
	}
	return ctx.Err()
}

func ensureRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%w：媒体文件无法读取", ErrInvalidMedia)
	}
	return nil
}

func hasValidPNG(path string) bool {
	width, height, size, err := inspectPNGFile(path)
	return err == nil && width > 0 && height > 0 && size > 0
}

func inspectPNGFile(path string) (width int, height int, size int64, err error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return 0, 0, 0, fmt.Errorf("空图片文件")
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, 0, err
	}
	defer file.Close()
	cfg, err := png.DecodeConfig(file)
	if err != nil {
		return 0, 0, 0, err
	}
	return cfg.Width, cfg.Height, info.Size(), nil
}

func formatSeconds(seconds float64) string {
	if seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return "0"
	}
	return strconv.FormatFloat(seconds, 'f', 3, 64)
}
