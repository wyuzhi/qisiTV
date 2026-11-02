package operations

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/image/tiff"
	"qisitv/backend/internal/mediatools"
)

func imageDomain(data []byte) *mediaDomain {
	return &mediaDomain{owner: "owner", data: data, mimeType: "image/png"}
}

func imageBytes(t *testing.T, result MediaResult) []byte {
	t.Helper()
	if len(result.Content) != 1 || result.Content[0].Type != "image" {
		t.Fatal("missing actual image content")
	}
	data, err := base64.StdEncoding.DecodeString(result.Content[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestImageReadsKeepOriginalPixelsAndBytes(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 3072, 2048))
	picture.SetNRGBA(2701, 1703, color.NRGBA{R: 231, G: 73, B: 19, A: 255})
	for _, format := range []string{"png", "jpeg"} {
		t.Run(format, func(t *testing.T) {
			var encoded bytes.Buffer
			var err error
			if format == "png" {
				err = png.Encode(&encoded, picture)
			} else {
				err = jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: 95})
			}
			if err != nil {
				t.Fatal(err)
			}
			d := imageDomain(encoded.Bytes())
			args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
			overview, err := mediaTestCall(t, d, "media.overview", args)
			if err != nil {
				t.Fatal(err)
			}
			args.ExpectedVersion, args.Mode = overview.Source.Version, "frames"
			inspected, err := mediaTestCall(t, d, "media.inspect", args)
			if err != nil {
				t.Fatal(err)
			}
			for _, result := range []MediaResult{overview, inspected} {
				if result.Image == nil || result.Image.View != "original" || result.Image.Width != 3072 || result.Image.Height != 2048 || !bytes.Equal(imageBytes(t, result), encoded.Bytes()) {
					t.Fatal("original image was resized or recompressed")
				}
			}
		})
	}
}

func TestImageCropKeepsOriginalPixelDetail(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 2048, 3072))
	for y := 0; y < 3072; y++ {
		for x := 0; x < 2048; x++ {
			picture.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: uint8(x ^ y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	d := imageDomain(encoded.Bytes())
	overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
	if err != nil {
		t.Fatal(err)
	}
	crop := &MediaImageCrop{X: 0.25, Y: 0.5, Width: 0.125, Height: 0.125}
	result, err := mediaTestCall(t, d, "media.inspect", mediaArgs{CanvasID: "canvas", NodeID: "node", ExpectedVersion: overview.Source.Version, Mode: "frames", ImageCrop: crop})
	if err != nil {
		t.Fatal(err)
	}
	actual, err := png.Decode(bytes.NewReader(imageBytes(t, result)))
	if err != nil {
		t.Fatal(err)
	}
	if actual.Bounds().Dx() != 256 || actual.Bounds().Dy() != 384 || result.Image.View != "crop" || *result.Image.Crop != *crop || result.Source.Version != overview.Source.Version {
		t.Fatal("crop changed source version or pixel dimensions")
	}
	for y := 0; y < 384; y++ {
		for x := 0; x < 256; x++ {
			if actual.At(x, y) != picture.At(x+512, y+1536) {
				// Decoders can return different Color implementations for equal pixels.
				ar, ag, ab, aa := actual.At(x, y).RGBA()
				er, eg, eb, ea := picture.At(x+512, y+1536).RGBA()
				if ar != er || ag != eg || ab != eb || aa != ea {
					t.Fatalf("detail changed at %d,%d", x, y)
				}
			}
		}
	}
}

func TestOversizeImageOverviewLabelsPreviewAndInspectionCanCrop(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 2300, 600))
	random := rand.New(rand.NewSource(17))
	for i := 0; i < len(picture.Pix); i += 4 {
		picture.Pix[i], picture.Pix[i+1], picture.Pix[i+2], picture.Pix[i+3] = uint8(random.Intn(256)), uint8(random.Intn(256)), uint8(random.Intn(256)), 255
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	if int64(encoded.Len()) <= maxInlineImageBytes || int64(encoded.Len()) > maxMediaPartBytes {
		t.Fatal("fixture must exceed the request byte budget")
	}
	d := imageDomain(encoded.Bytes())
	args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
	preview, err := mediaTestCall(t, d, "media.overview", args)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Image.View != "preview" || preview.Image.Inspectable || preview.Image.Width != maxOverviewPreviewEdge || preview.Image.OriginalWidth != 2300 || !strings.Contains(preview.Note, "imageCrop") {
		t.Fatal("overview silently lost detail")
	}
	args.ExpectedVersion, args.Mode = preview.Source.Version, "frames"
	if _, err := mediaTestCall(t, d, "media.inspect", args); err == nil || AsError(err).Reason != "media_part_too_large" {
		t.Fatalf("inspection silently resized an oversized image: %v", err)
	}
	args.ImageCrop = &MediaImageCrop{Width: 0.25, Height: 0.25}
	detail, err := mediaTestCall(t, d, "media.inspect", args)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Image.View != "crop" || detail.Image.Width != 575 || detail.Image.Height != 150 || detail.Source.Version != preview.Source.Version {
		t.Fatal("oversized image could not be inspected at original pixel resolution")
	}
}

func TestHighResPhotoOverviewUsesCompactPreviewWhileInspectKeepsOriginal(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 1584, 2816))
	for y := 0; y < 2816; y++ {
		for x := 0; x < 1584; x++ {
			bx, by := x/4, y/4
			picture.SetNRGBA(x, y, color.NRGBA{
				R: uint8((bx*7 + by*3) & 0xff),
				G: uint8((bx*5 ^ by*11) & 0xff),
				B: uint8((bx*13 + by*17) & 0xff),
				A: 255,
			})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: 88}); err != nil {
		t.Fatal(err)
	}
	if int64(encoded.Len()) <= maxOverviewImageBytes || int64(encoded.Len()) >= maxInlineImageBytes {
		t.Fatalf("fixture bytes=%d, want between %d and %d", encoded.Len(), maxOverviewImageBytes, maxInlineImageBytes)
	}
	d := &mediaDomain{owner: "owner", data: encoded.Bytes(), mimeType: "image/jpeg"}
	args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
	overview, err := mediaTestCall(t, d, "media.overview", args)
	if err != nil {
		t.Fatal(err)
	}
	previewBytes := imageBytes(t, overview)
	if overview.Image == nil || overview.Image.View != "preview" || !overview.Image.Inspectable || overview.Image.Width != 900 || overview.Image.Height != 1600 || overview.Image.OriginalWidth != 1584 || overview.Image.OriginalHeight != 2816 {
		t.Fatalf("unexpected overview image metadata: %+v", overview.Image)
	}
	if len(previewBytes) >= encoded.Len()/2 {
		t.Fatalf("preview bytes=%d did not shrink significantly from original=%d", len(previewBytes), encoded.Len())
	}
	args.ExpectedVersion, args.Mode = overview.Source.Version, "frames"
	inspected, err := mediaTestCall(t, d, "media.inspect", args)
	if err != nil {
		t.Fatal(err)
	}
	if inspected.Image == nil || inspected.Image.View != "original" || inspected.Image.Width != 1584 || inspected.Image.Height != 2816 || !bytes.Equal(imageBytes(t, inspected), encoded.Bytes()) {
		t.Fatalf("inspect did not preserve original pixels: %+v", inspected.Image)
	}
}

func TestInvalidImageCropsNeverOpenResources(t *testing.T) {
	d := imageDomain(nil)
	for _, args := range []mediaArgs{
		{ImageCrop: &MediaImageCrop{X: -0.1, Width: 0.5, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{X: 1, Width: 0.1, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{X: 0.8, Width: 0.5, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{Width: 0, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}, Mode: "video"},
		{ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}, EndMs: 1},
	} {
		args.CanvasID, args.NodeID, args.ExpectedVersion = "canvas", "node", strings.Repeat("a", 64)
		if _, err := mediaTestCall(t, d, "media.inspect", args); err == nil || AsError(err).Reason != "invalid_image_crop" {
			t.Fatalf("invalid crop accepted: %+v %v", args, err)
		}
	}
	d.mimeType = "video/mp4"
	if _, err := mediaTestCall(t, d, "media.inspect", mediaArgs{CanvasID: "canvas", NodeID: "node", ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}}); err == nil || AsError(err).Reason != "invalid_image_crop" {
		t.Fatalf("video accepted image crop: %v", err)
	}
	if d.opens != 0 {
		t.Fatal("invalid crop opened source bytes")
	}
}

// 随包的 ffprobe 只带音视频解复用器；图片检查不能依赖它，也不该为常见图片调用 ffmpeg。
func TestImageOverviewWorksWithoutImageCapableTools(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell stub")
	}
	stub := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(mediatools.FFprobePathEnv, stub)
	t.Setenv(mediatools.FFmpegPathEnv, "")
	t.Setenv("PATH", "")
	picture := image.NewPaletted(image.Rect(0, 0, 64, 48), color.Palette{color.Black, color.White})
	for format, encode := range map[string]func(*bytes.Buffer) error{
		"png":  func(b *bytes.Buffer) error { return png.Encode(b, picture) },
		"gif":  func(b *bytes.Buffer) error { return gif.Encode(b, picture, nil) },
		"tiff": func(b *bytes.Buffer) error { return tiff.Encode(b, picture, nil) },
	} {
		t.Run(format, func(t *testing.T) {
			var encoded bytes.Buffer
			if err := encode(&encoded); err != nil {
				t.Fatal(err)
			}
			d := &mediaDomain{owner: "owner", data: encoded.Bytes(), mimeType: "image/" + format}
			overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
			if err != nil {
				t.Fatal(err)
			}
			if overview.Image == nil || overview.Image.Width != 64 || overview.Image.Height != 48 || len(overview.Content) != 1 {
				t.Fatalf("overview=%+v", overview.Image)
			}
		})
	}
	var genericPNG bytes.Buffer
	if err := png.Encode(&genericPNG, picture); err != nil {
		t.Fatal(err)
	}
	genericOverview, err := mediaTestCall(t, &mediaDomain{owner: "owner", data: genericPNG.Bytes(), mimeType: "application/octet-stream"}, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
	if err != nil || genericOverview.Image == nil || genericOverview.Image.Width != 64 || genericOverview.Image.Height != 48 {
		t.Fatalf("generic-mime overview=%+v err=%v", genericOverview.Image, err)
	}
	avifHeader := []byte{0x00, 0x00, 0x00, 0x1c, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f', 0x00, 0x00, 0x00, 0x00}
	if _, err := mediaTestCall(t, &mediaDomain{owner: "owner", data: avifHeader, mimeType: "image/avif"}, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"}); err == nil || AsError(err).Reason != "media_format_unsupported" {
		t.Fatalf("unsupported avif err=%v, want media_format_unsupported", err)
	}
	// Patch IHDR width/height to 8192x8192 (64M pixels > 32M limit) with a valid CRC so DecodeConfig succeeds and triggers the pixel cap before allocating pixel buffers.
	hugePNG := append([]byte(nil), genericPNG.Bytes()...)
	binary.BigEndian.PutUint32(hugePNG[16:20], 8192)
	binary.BigEndian.PutUint32(hugePNG[20:24], 8192)
	binary.BigEndian.PutUint32(hugePNG[29:33], crc32.ChecksumIEEE(hugePNG[12:29]))
	if _, err := mediaTestCall(t, &mediaDomain{owner: "owner", data: hugePNG, mimeType: "image/png"}, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"}); err == nil || AsError(err).Reason != "media_too_large" {
		t.Fatalf("huge pixel image err=%v, want media_too_large", err)
	}
}
