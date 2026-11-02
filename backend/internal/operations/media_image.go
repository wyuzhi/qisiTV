package operations

import (
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"path/filepath"

	"qisitv/backend/internal/editing"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

var (
	_ = bmp.Decode
	_ = tiff.Decode

	errImageTooManyPixels = errors.New("image exceeds pixel limit")
)

const maxDecodedImagePixels int64 = 32 << 20

// Coordinates refer to the displayed image, after the decoder applies orientation.
type MediaImageCrop struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (c MediaImageCrop) valid() bool {
	for _, value := range []float64{c.X, c.Y, c.Width, c.Height} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return c.X >= 0 && c.Y >= 0 && c.X < 1 && c.Y < 1 && c.Width > 0 && c.Height > 0 && c.X+c.Width <= 1 && c.Y+c.Height <= 1
}

type MediaImageRead struct {
	View           string          `json:"view"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	OriginalWidth  int             `json:"originalWidth"`
	OriginalHeight int             `json:"originalHeight"`
	Inspectable    bool            `json:"inspectable,omitempty"`
	Crop           *MediaImageCrop `json:"crop,omitempty"`
}

const mediaImageCropSchema = `{"type":"object","description":"图片局部原像素裁剪（0~1比例）","properties":{"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"}},"required":["x","y","width","height"]}`

// 3 MiB becomes 4 MiB of base64, below the SDK's default 4.5 MiB inline budget.
// This bounds payload bytes without imposing a pixel limit on detail inspection.
const maxInlineImageBytes int64 = 3 << 20

// Overview only needs a compact preview; images exceeding 256 KiB are re-encoded
// into a <=1600px JPEG preview so multi-image overview rounds do not bloat history.
const (
	maxOverviewImageBytes  int64 = 256 << 10
	maxOverviewPreviewEdge       = 1600
)

func inlineImagePart(path, mime string, source MediaSource) (MediaPart, error) {
	if stat, err := os.Stat(path); err == nil && stat.Size() > maxInlineImageBytes {
		return MediaPart{}, PreconditionFailed("media_part_too_large", "图片超过单次读取大小，请分区查看图片细节", nil)
	}
	return mediaFilePart(path, "image", mime, source)
}

func imageConfig(path string) (image.Config, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return image.Config{}, "", err
	}
	defer file.Close()
	cfg, format, err := image.DecodeConfig(file)
	if err != nil {
		return image.Config{}, "", err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxDecodedImagePixels {
		return image.Config{}, "", errImageTooManyPixels
	}
	return cfg, format, nil
}

// probeMediaFacts 读取素材的音视频轨与时长。图片由 Go 直接读取：随包的 ffprobe 只带音视频
// 解复用器，不能用它检查 PNG、JPEG、WebP 等图片，否则助手读图会失败。
func probeMediaFacts(ctx context.Context, input string, isImage bool) (editing.SourceFacts, error) {
	if isImage {
		_, _, err := imageConfig(input)
		if err == nil {
			return editing.SourceFacts{HasVideo: true}, nil
		}
		if errors.Is(err, errImageTooManyPixels) {
			return editing.SourceFacts{}, err
		}
	}
	return editing.Probe(ctx, input)
}

// convertImageToPNG 用 Go 把 GIF、WebP 等可解码图片转成同尺寸 PNG，不依赖 ffmpeg 的图片解码器。
func convertImageToPNG(source, target string) error {
	decoded, err := decodeImageFile(source)
	if err != nil {
		return err
	}
	return writePNGFile(target, decoded)
}

func decodeImageFile(source string) (image.Image, error) {
	in, err := os.Open(source)
	if err != nil {
		return nil, err
	}
	defer in.Close()
	cfg, _, err := image.DecodeConfig(in)
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxDecodedImagePixels {
		return nil, errImageTooManyPixels
	}
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	decoded, _, err := image.Decode(in)
	return decoded, err
}

func writePNGFile(target string, img image.Image) error {
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	if err := png.Encode(out, img); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func cropImageToPNG(source, target string, crop *MediaImageCrop) error {
	decoded, err := decodeImageFile(source)
	if err != nil {
		return err
	}
	b := decoded.Bounds()
	iw, ih := float64(b.Dx()), float64(b.Dy())
	x0 := int(math.Floor(iw * crop.X))
	y0 := int(math.Floor(ih * crop.Y))
	w := max(1, int(math.Ceil(iw*(crop.X+crop.Width)))-x0)
	h := max(1, int(math.Ceil(ih*(crop.Y+crop.Height)))-y0)
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), decoded, image.Pt(b.Min.X+x0, b.Min.Y+y0), draw.Src)
	return writePNGFile(target, dst)
}

func scaleImagePreviewJPEG(source, target string) error {
	decoded, err := decodeImageFile(source)
	if err != nil {
		return err
	}
	b := decoded.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > maxOverviewPreviewEdge || h > maxOverviewPreviewEdge {
		scale := math.Min(float64(maxOverviewPreviewEdge)/float64(w), float64(maxOverviewPreviewEdge)/float64(h))
		w = max(1, int(math.Round(float64(w)*scale)))
		h = max(1, int(math.Round(float64(h)*scale)))
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.BiLinear.Scale(dst, dst.Bounds(), decoded, b, draw.Over, nil)
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(out, dst, &jpeg.Options{Quality: 78}); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func imageFFmpegCommand(ctx context.Context, args ...string) ([]byte, error) {
	bin, err := editing.ResolveFFmpegBinary()
	if err != nil {
		return nil, PreconditionFailed("media_ffmpeg_unavailable", "媒体检查需要 ffmpeg", nil)
	}
	return mediaCommand(ctx, bin, args...)
}

func (p preparedMedia) readImage(ctx context.Context, operation string, args mediaArgs, result MediaResult) (MediaResult, error) {
	input := p.input
	config, format, err := imageConfig(input)
	if err != nil || (format != "jpeg" && format != "png") {
		// Convert unsupported inline formats without changing their pixel size.
		input = filepath.Join(p.directory, "image-original.png")
		if convertErr := convertImageToPNG(p.input, input); convertErr != nil {
			if _, err := imageFFmpegCommand(ctx, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-y", input); err != nil {
				return MediaResult{}, err
			}
		}
		config, format, err = imageConfig(input)
		if err != nil {
			return MediaResult{}, PreconditionFailed("media_processing_failed", "图片无法解码", nil)
		}
	}
	info := &MediaImageRead{View: "original", Width: config.Width, Height: config.Height, OriginalWidth: config.Width, OriginalHeight: config.Height}
	mime := "image/" + format
	if args.ImageCrop != nil {
		crop := args.ImageCrop
		input = filepath.Join(p.directory, "image-crop.png")
		if cropErr := cropImageToPNG(p.input, input, crop); cropErr != nil {
			filter := fmt.Sprintf("format=rgba,crop=w='max(1,ceil(iw*%.17g)-floor(iw*%.17g))':h='max(1,ceil(ih*%.17g)-floor(ih*%.17g))':x='floor(iw*%.17g)':y='floor(ih*%.17g)':exact=1", crop.X+crop.Width, crop.X, crop.Y+crop.Height, crop.Y, crop.X, crop.Y)
			if _, err := imageFFmpegCommand(ctx, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-vf", filter, "-y", input); err != nil {
				return MediaResult{}, err
			}
		}
		info.View, info.Crop, mime = "crop", crop, "image/png"
	}
	overviewNeedsPreview := false
	if operation == "media.overview" && args.ImageCrop == nil {
		if stat, statErr := os.Stat(input); statErr == nil && stat.Size() > maxOverviewImageBytes && stat.Size() <= maxInlineImageBytes {
			overviewNeedsPreview = true
		}
	}
	var part MediaPart
	if !overviewNeedsPreview {
		part, err = inlineImagePart(input, mime, result.Source)
	}
	oversizeForInspect := err != nil && AsError(err).Reason == "media_part_too_large"
	if overviewNeedsPreview || (oversizeForInspect && operation == "media.overview") {
		// Only a labeled overview may shrink. Inspection always keeps original pixels.
		input = filepath.Join(p.directory, "image-preview.jpg")
		if previewErr := scaleImagePreviewJPEG(p.input, input); previewErr != nil {
			scaleFilter := fmt.Sprintf("scale=w='min(iw,%d)':h='min(ih,%d)':force_original_aspect_ratio=decrease", maxOverviewPreviewEdge, maxOverviewPreviewEdge)
			if _, err := imageFFmpegCommand(ctx, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-vf", scaleFilter, "-q:v", "8", "-pix_fmt", "yuvj420p", "-y", input); err != nil {
				return MediaResult{}, err
			}
		}
		info.View = "preview"
		info.Inspectable = !oversizeForInspect
		if oversizeForInspect {
			result.Note = "这张图片超过单次读取大小，当前仅为概览。小字和纹理等细节请用 media.inspect 的 imageCrop 分区查看原始像素；不要根据概览猜测细节。"
		} else {
			result.Note = "当前为概览缩略图。小字和纹理等细节请用 media.inspect（mode=frames 或 imageCrop）查看原始像素；不要根据概览猜测细节。"
		}
		part, err = inlineImagePart(input, "image/jpeg", result.Source)
	}
	if err != nil {
		if AsError(err).Reason == "media_part_too_large" {
			return MediaResult{}, PreconditionFailed("media_part_too_large", "图片超过单次读取大小，请分区查看图片细节", nil)
		}
		return MediaResult{}, err
	}
	if info.View != "original" {
		output, _, err := imageConfig(input)
		if err != nil {
			return MediaResult{}, PreconditionFailed("media_processing_failed", "图片处理未产生有效内容", nil)
		}
		info.Width, info.Height = output.Width, output.Height
	}
	result.Image, result.Content = info, []MediaPart{part}
	return result, nil
}
