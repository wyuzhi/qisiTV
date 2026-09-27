package app

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"errors"
	"strings"

	"qisitv/backend/internal/model"
)

// 播放副本转码：HEVC/H.265 原片在 Chrome/Firefox 等无法解码（<video> 黑屏），
// 上传就绪后若探测到 hvc1/hev1 且本机可用 ffmpeg，则异步转 H.264/AAC 到本地
// playback 目录，供 file 端点 variant=playback 读取。转码只作用于本地原件；
// OSS 原件不转码（避免每次上传拉取远端）。

// ErrPlaybackNotReady 表示资源没有可用的浏览器兼容播放副本（未转码/转码中/失败），
// file 端点应回退 serve 原件。
var ErrPlaybackNotReady = errors.New("播放副本尚未就绪")

const (
	playbackDirName         = "playback"
	videoCodecH264          = "h264"
	videoCodecH265          = "h265"
	videoCodecAV1           = "av1"
	videoCodecVP9           = "vp9"
	videoCodecMPEG4         = "mpeg4"
	probeMaxMoovSize        = 128 << 20
	playbackPersistAttempts = 3
)

// probeVideoCodec 解析本地 mp4 的 stsd 首个视频 sample entry fourcc，返回 h264/h265 等。
// 非 mp4 容器或解析失败返回空串（调用方按“无需转码”处理，前端仍可用原件）。
func probeVideoCodec(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	// 顶层 box 遍历（跳过 mdat 数据体），定位 moov。
	var moovSize int64
	var moovData []byte
	pos := int64(0)
	for {
		boxType, size, err := readMP4BoxHeaderAt(f, pos)
		if err != nil {
			return ""
		}
		switch boxType {
		case "moov":
			if size > probeMaxMoovSize {
				return ""
			}
			moovData = make([]byte, size-8)
			if _, err := f.ReadAt(moovData, pos+8); err != nil {
				return ""
			}
			moovSize = size
		}
		pos += size
		if moovSize != 0 {
			break
		}
		if size < 8 {
			return ""
		}
	}
	return codecFromMoov(moovData)
}

// readMP4BoxHeaderAt 定位文件 pos 处的 box（8/16 字节头），返回类型与总大小。
func readMP4BoxHeaderAt(r io.ReaderAt, pos int64) (string, int64, error) {
	var hdr [16]byte
	if _, err := r.ReadAt(hdr[:8], pos); err != nil {
		return "", 0, err
	}
	size := int64(binary.BigEndian.Uint32(hdr[:4]))
	boxType := string(hdr[4:8])
	if size == 1 {
		if _, err := r.ReadAt(hdr[8:16], pos+8); err != nil {
			return "", 0, err
		}
		size = int64(binary.BigEndian.Uint64(hdr[8:16]))
	}
	if size < 8 {
		return "", 0, fmt.Errorf("invalid box size %d", size)
	}
	return boxType, size, nil
}

type mp4BoxHeader struct {
	Type string
	Hdr  int
	Size int
}

// parseMP4Box reads one ISO-BMFF box at pos within data[0:end].
// Extended sizes are checked against remaining bytes before converting to int,
// and declared size must cover the 8- or 16-byte header.
func parseMP4Box(data []byte, pos, end int) (mp4BoxHeader, bool) {
	if pos < 0 || end > len(data) || pos >= end {
		return mp4BoxHeader{}, false
	}
	remaining := end - pos
	if remaining < 8 {
		return mp4BoxHeader{}, false
	}
	raw32 := binary.BigEndian.Uint32(data[pos : pos+4])
	typ := string(data[pos+4 : pos+8])
	hdr := 8
	var raw uint64
	switch raw32 {
	case 1:
		if remaining < 16 {
			return mp4BoxHeader{}, false
		}
		raw = binary.BigEndian.Uint64(data[pos+8 : pos+16])
		hdr = 16
	case 0:
		raw = uint64(remaining)
	default:
		raw = uint64(raw32)
	}
	if raw < uint64(hdr) || raw > uint64(remaining) {
		return mp4BoxHeader{}, false
	}
	return mp4BoxHeader{Type: typ, Hdr: hdr, Size: int(raw)}, true
}

func mp4BoxPayload(data []byte, pos int, header mp4BoxHeader) []byte {
	return data[pos+header.Hdr : pos+header.Size]
}

// probeGeneratedVideoMedia reads width, height, and duration from the same
// vide track. Audio, cover-art, and other non-vide tracks are ignored.
func probeGeneratedVideoMedia(data []byte) (width int, height int, durationMs int64) {
	moov := firstMP4Payload(data, 0, len(data), "moov")
	if len(moov) == 0 {
		return 0, 0, 0
	}
	for _, trak := range mp4Payloads(moov, "trak") {
		if trakHandlerType(trak) != "vide" {
			continue
		}
		trackWidth, trackHeight := 0, 0
		trackDurationMs := int64(0)
		if tkhd := firstMP4Payload(trak, 0, len(trak), "tkhd"); len(tkhd) > 0 {
			trackWidth, trackHeight = videoTkhdDimensions(tkhd)
		}
		if mdia := firstMP4Payload(trak, 0, len(trak), "mdia"); len(mdia) > 0 {
			if mdhd := firstMP4Payload(mdia, 0, len(mdia), "mdhd"); len(mdhd) > 0 {
				trackDurationMs = videoMdhdDurationMs(mdhd)
			}
		}
		if trackWidth > 0 && trackHeight > 0 {
			return trackWidth, trackHeight, trackDurationMs
		}
	}
	return 0, 0, 0
}

func trakHandlerType(trak []byte) string {
	for _, mdia := range mp4Payloads(trak, "mdia") {
		if hdlr := firstMP4Payload(mdia, 0, len(mdia), "hdlr"); len(hdlr) >= 12 {
			return string(hdlr[8:12])
		}
	}
	return ""
}

func firstMP4Payload(data []byte, pos, end int, want string) []byte {
	payloads := collectMP4Payloads(data, pos, end, want, true)
	if len(payloads) == 0 {
		return nil
	}
	return payloads[0]
}

func mp4Payloads(data []byte, want string) [][]byte {
	return collectMP4Payloads(data, 0, len(data), want, false)
}

func videoTkhdDimensions(body []byte) (int, int) {
	if len(body) < 4 {
		return 0, 0
	}
	widthAt, heightAt := 76, 80
	switch body[0] {
	case 0:
	case 1:
		widthAt, heightAt = 88, 92
	default:
		return 0, 0
	}
	if len(body) < heightAt+4 {
		return 0, 0
	}
	return int(binary.BigEndian.Uint32(body[widthAt:widthAt+4]) >> 16), int(binary.BigEndian.Uint32(body[heightAt:heightAt+4]) >> 16)
}

func videoMdhdDurationMs(body []byte) int64 {
	if len(body) < 4 {
		return 0
	}
	var timescale uint32
	var duration uint64
	switch body[0] {
	case 1:
		if len(body) < 32 {
			return 0
		}
		timescale = binary.BigEndian.Uint32(body[20:24])
		duration = binary.BigEndian.Uint64(body[24:32])
	case 0:
		if len(body) < 20 {
			return 0
		}
		timescale = binary.BigEndian.Uint32(body[12:16])
		duration = uint64(binary.BigEndian.Uint32(body[16:20]))
	default:
		return 0
	}
	if timescale == 0 {
		return 0
	}
	return durationMillis(duration, uint64(timescale))
}

func durationMillis(duration, timescale uint64) int64 {
	if timescale == 0 {
		return 0
	}
	major := duration / timescale
	frac := duration % timescale
	if major > uint64(math.MaxInt64/1000) {
		return 0
	}
	ms := major * 1000
	fracMs := frac * 1000 / timescale
	if ms > uint64(math.MaxInt64)-fracMs {
		return 0
	}
	return int64(ms + fracMs)
}

// codecFromMoov 在 moov 子树中找出所有 stsd，取首个视频 sample entry fourcc。
func codecFromMoov(moov []byte) string {
	for _, stsdBody := range boxBodies(moov, "stsd") {
		// stsd = fullbox(4) + entry_count(4) + entries…
		// 首个 sample entry：entry_size(4) + fourcc(4) → fourcc 在 body+12。
		if stsdBody+16 > len(moov) {
			continue
		}
		fourcc := string(moov[stsdBody+12 : stsdBody+16])
		switch fourcc {
		case "avc1":
			return videoCodecH264
		case "hvc1", "hev1":
			return videoCodecH265
		case "av01":
			return videoCodecAV1
		case "vp09":
			return videoCodecVP9
		case "mp4v":
			return videoCodecMPEG4
		}
	}
	return ""
}

// boxBodies 在 data 中递归查找类型为 want 的 box，返回其 body 起始偏移。
// 只下钻容器 box（moov/trak/mdia/minf/stbl），避免误入 sample entry 内部。
func boxBodies(data []byte, want string) []int {
	var out []int
	var walk func(start, end int)
	walk = func(start, end int) {
		pos := start
		for {
			header, ok := parseMP4Box(data, pos, end)
			if !ok {
				return
			}
			if header.Type == want {
				out = append(out, pos+header.Hdr)
			}
			switch header.Type {
			case "moov", "trak", "mdia", "minf", "stbl":
				walk(pos+header.Hdr, pos+header.Size)
			}
			pos += header.Size
		}
	}
	walk(0, len(data))
	return out
}

func collectMP4Payloads(data []byte, start, end int, want string, firstOnly bool) [][]byte {
	var out [][]byte
	pos := start
	for {
		header, ok := parseMP4Box(data, pos, end)
		if !ok {
			return out
		}
		if header.Type == want {
			out = append(out, mp4BoxPayload(data, pos, header))
			if firstOnly {
				return out
			}
		}
		pos += header.Size
	}
}

// maybeStartPlaybackTranscode 由上传就绪路径调用；H.265 且 ffmpeg 可用时置
// processing 并异步转码。H.264 直接标记 none，避免每次上传重复探测。
func (s *Service) maybeStartPlaybackTranscode(resource *model.Resource) {
	if resource == nil || resource.Kind != "video" {
		return
	}
	// 远端存储（OSS 等）不落本地副本：标 none 表示无需转码，前端按原生播放/直链处理，
	// 避免状态留空被当成 processing 无限轮询（markPlaybackNone 幂等）。
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		if resource.Provider != "local" {
			markPlaybackNone(s, resource)
		}
		return
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return
	}
	// 不可转码场景（无 ffmpeg）落 none：状态为空会被前端当成 processing 无限轮询，
	// 也会让启动回填每次重试探测。none 表示"无需转码"，按原生播放处理。
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		markPlaybackNone(s, resource)
		return
	}
	src := filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))
	switch probeVideoCodec(src) {
	case videoCodecH265, videoCodecMPEG4:
		// H.265 与 MPEG-4 Part 2（mp4v）Chromium/Firefox/Edge 均不能解码：
		// H.265 需转 H.264；MPEG-4 Part 2 浏览器不支持，老式/损坏文件只能转码兜底
		// （转码失败会落 failed，前端据此显示终止性错误，不再出现死循环）。
		// 原子抢占（空/none → processing）：并发上传 + 回填、多实例同抢时
		// 仅一个能成功置位，其余直接返回，避免重复转码。
		claimed, err := s.repo.ClaimPlaybackTranscode(resource.ID)
		if err != nil || !claimed {
			return
		}
		resource.PlaybackStatus = model.PlaybackStatusProcessing
		go s.runPlaybackTranscode(resource.UserID, resource.ID, src)
	case videoCodecH264, videoCodecAV1, videoCodecVP9, "":
		// H.264 浏览器可直接解码；AV1/VP9 现代浏览器可直接解码，均不需转码；
		// 探针读不出编码（非 mp4 / moov 在尾部 / 加密容器）也无法处理 —— 均标 none，
		// 避免重复探测与前端无限轮询。
		markPlaybackNone(s, resource)
	}
}

// markPlaybackNone 将资源标记为无需播放副本（幂等）。写失败必须可见：空状态会被前端当成 processing 轮询。
func markPlaybackNone(s *Service, resource *model.Resource) {
	if resource.PlaybackStatus == model.PlaybackStatusNone {
		return
	}
	previous := resource.PlaybackStatus
	resource.PlaybackStatus = model.PlaybackStatusNone
	if err := persistPlaybackResource(s.repo, resource, "mark_none"); err != nil {
		resource.PlaybackStatus = previous
	}
}

// runPlaybackTranscode 转码本地原件到 playback/<id>.mp4 并回写状态（幂等按 id 重载）。
func (s *Service) runPlaybackTranscode(userID string, resourceID string, src string) {
	// 转码 goroutine 意外 panic 时把状态落 failed，避免 processing 卡死到下次重启。
	defer func() {
		if r := recover(); r != nil {
			if res, err := s.repo.ResourceForUser(userID, resourceID); err == nil && res != nil {
				res.PlaybackStatus = model.PlaybackStatusFailed
				res.PlaybackError = clipText(fmt.Sprintf("转码 panic：%v", r), 1000)
				_ = persistPlaybackResource(s.repo, res, "panic")
			}
		}
	}()
	status := model.PlaybackStatusFailed
	objectKey := ""
	var errText string
	dst := filepath.Join(s.dataDir, playbackDirName, resourceID+".mp4")
	// 副本已存在且为 H.264（上次转码完成但回写随进程崩溃丢失）：直接置 ready 不重转。
	if probeVideoCodec(dst) == videoCodecH264 {
		status = model.PlaybackStatusReady
		objectKey = resourceID + ".mp4"
	} else if err := runH264Transcode(src, dst); err != nil {
		errText = clipText(err.Error(), 1000)
	} else {
		status = model.PlaybackStatusReady
		objectKey = resourceID + ".mp4"
	}
	res, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil || res == nil {
		log.Printf("playback transcode persist skipped: resource=%s user=%s lookup_error=%v", resourceID, userID, err)
		return
	}
	res.PlaybackStatus = status
	res.PlaybackObjectKey = objectKey
	res.PlaybackError = errText
	_ = persistPlaybackResource(s.repo, res, "transcode_complete")
}

type resourcePersister interface {
	SaveResource(resource *model.Resource) error
}

func persistPlaybackResource(saver resourcePersister, resource *model.Resource, context string) error {
	var err error
	for attempt := 1; attempt <= playbackPersistAttempts; attempt++ {
		err = saver.SaveResource(resource)
		if err == nil {
			return nil
		}
	}
	log.Printf("playback transcode persist failed: resource=%s context=%s attempts=%d error=%v", resource.ID, context, playbackPersistAttempts, err)
	return err
}

// runH264Transcode 用 ffmpeg 将任意输入转为 H.264/AAC mp4（faststart、yuv420p、偶数尺寸）。
func runH264Transcode(src string, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-i", src,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
		"-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		dst)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg 转码失败：%s", clipText(msg, 800))
	}
	return nil
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// OpenResourcePlaybackRange 打开浏览器兼容播放副本（本地 ffmpeg 转码的 H.264）。
// 仅当资源为本地存储且副本 ready 时可用；否则返回 ErrPlaybackNotReady，调用方回退原件。
func (s *Service) OpenResourcePlaybackRange(userID string, resourceID string) (*ResourceStream, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource == nil || resource.Status != model.ResourceStatusReady || resource.Provider != "local" ||
		resource.PlaybackStatus != model.PlaybackStatusReady || resource.PlaybackObjectKey == "" {
		return nil, ErrPlaybackNotReady
	}
	body, err := os.Open(filepath.Join(s.dataDir, playbackDirName, filepath.FromSlash(resource.PlaybackObjectKey)))
	if err != nil {
		return nil, err
	}
	playback := *resource
	playback.MimeType = "video/mp4"
	playback.ObjectKey = filepath.Join(playbackDirName, resource.PlaybackObjectKey)
	size := int64(0)
	if st, err := body.Stat(); err == nil {
		size = st.Size()
	}
	return &ResourceStream{Resource: &playback, Body: body, StatusCode: http.StatusOK, ContentLength: size, AcceptRanges: "bytes"}, nil
}

// BackfillPlaybackTranscodes 在服务启动后扫描存量本地视频：未判定 codec 的补判定，
// H.265/MPEG-4 Part 2 触发转码、H.264 标记 none；再对旧规则遗留的 none 行做一次
// 有界重判（见 PlaybackNoneVideos）。幂等：maybeStartPlaybackTranscode 先置
// processing/none 再入库，重复扫描不会重复转码。
func (s *Service) BackfillPlaybackTranscodes() {
	// 上次进程可能崩溃在转码中途（状态卡 processing），先重置为待判定。
	_ = s.repo.ResetStuckPlaybackTranscodes()
	for {
		resources, err := s.repo.PlaybackPendingVideos(20)
		if err != nil || len(resources) == 0 {
			break
		}
		for i := range resources {
			s.maybeStartPlaybackTranscode(&resources[i])
		}
	}
	// 旧版本曾把 H.265/MPEG-4 Part 2 误判为浏览器可播并落 none；对存量 none 行
	// 做一次有界重判（H.264 保持 none，H.265/MPEG-4 Part 2 触发转码），使 codec
	// 判定规则的变更覆盖规则变更前已导入的文件。每次启动最多重判 20 条最旧行，
	// 天然收敛且不会重复转码（claim 原子地把 none → processing）。
	legacy, err := s.repo.PlaybackNoneVideos(20)
	if err == nil {
		for i := range legacy {
			s.maybeStartPlaybackTranscode(&legacy[i])
		}
	}
}
