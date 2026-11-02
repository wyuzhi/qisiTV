package providerpreset

import (
	"fmt"
	"strconv"
	"strings"
)

// SeedreamFamily 识别 Seedream 的型号族。国内官方型号带 doubao- 前缀，国际版和
// 网关型号不带；先去掉前缀再按族匹配，Pro / Flash 必须排在通用 5.0 之前，否则
// doubao-seedream-5-0-pro-* 会被当成 Lite。
func SeedreamFamily(model string) string {
	normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(model)), "doubao-")
	for _, item := range []struct{ prefix, family string }{
		{"dola-seedream-5-0-pro-", "pro"},
		{"seedream-5-0-pro-", "pro"},
		{"dola-seedream-5-0-flash-", "flash"},
		{"seedream-5-0-flash-", "flash"},
		{"seedream-5-0-", "lite"},
		{"seedream-4-5-", "4.5"},
		{"seedream-4-0-", "4.0"},
	} {
		if strings.HasPrefix(normalized, item.prefix) {
			return item.family
		}
	}
	return ""
}

// SeedreamSizeRule 是一个型号族对 size 的官方限制，抄自火山方舟图片生成 API
// （https://docs.volcengine.com/docs/ark/image-generation-api，2026-10-27 核对）。
// 自定义宽x高按「总像素区间 + 宽高比」判断，不是按单边像素范围判断。
type SeedreamSizeRule struct {
	Tiers     []string
	MinPixels int64
	MaxPixels int64
	// MinExampleSize / MaxExampleSize 是官方区间两端的示例尺寸，用来把限制讲成
	// 用户能直接照着填的说法，不要求用户理解像素数区间。
	MinExampleSize string
	MaxExampleSize string
}

const (
	seedreamMinRatio = 1.0 / 16
	seedreamMaxRatio = 16.0
	// SeedreamDefaultTier 是没填 size、填 1:1 或普通生图填 auto 时使用的默认档位。
	SeedreamDefaultTier = "2K"
)

var seedreamSizeRules = map[string]SeedreamSizeRule{
	// 5.0 pro / flash：1K、1.5K、2K；自定义总像素 [1280x720, 2048x2048x1.1025]。
	"pro":   {Tiers: []string{"1K", "1.5K", "2K"}, MinPixels: 921600, MaxPixels: 4624220, MinExampleSize: "1280x720", MaxExampleSize: "2048x2048"},
	"flash": {Tiers: []string{"1K", "1.5K", "2K"}, MinPixels: 921600, MaxPixels: 4624220, MinExampleSize: "1280x720", MaxExampleSize: "2048x2048"},
	// 5.0 lite：2K、3K、4K；自定义总像素 [2560x1440, 4096x4096]。
	"lite": {Tiers: []string{"2K", "3K", "4K"}, MinPixels: 3686400, MaxPixels: 16777216, MinExampleSize: "2560x1440", MaxExampleSize: "4096x4096"},
	// 4.5：2K、4K；自定义总像素 [2560x1440, 4096x4096]。
	"4.5": {Tiers: []string{"2K", "4K"}, MinPixels: 3686400, MaxPixels: 16777216, MinExampleSize: "2560x1440", MaxExampleSize: "4096x4096"},
	// 4.0：1K、2K、4K；自定义总像素 [1280x720, 4096x4096]。
	"4.0": {Tiers: []string{"1K", "2K", "4K"}, MinPixels: 921600, MaxPixels: 16777216, MinExampleSize: "1280x720", MaxExampleSize: "4096x4096"},
}

// seedreamRatioSizes 把画布比例映射成官方 2K 档位的参考像素。2K 是每个型号族都
// 支持的档位，这些取值也都落在各族的总像素区间与 [1/16, 16] 宽高比内。
var seedreamRatioSizes = map[string]string{
	"4:3":  "2304x1728",
	"3:4":  "1728x2304",
	"16:9": "2560x1440",
	"9:16": "1440x2560",
	"3:2":  "2496x1664",
	"2:3":  "1664x2496",
	"21:9": "3024x1296",
}

func SeedreamSizeRuleFor(family string) (SeedreamSizeRule, bool) {
	rule, ok := seedreamSizeRules[family]
	return rule, ok
}

func SeedreamFamilyLabel(family string) string {
	switch family {
	case "pro":
		return "5.0 Pro"
	case "flash":
		return "5.0 Flash"
	case "lite":
		return "5.0 Lite"
	}
	return family
}

// ResolveSeedreamSize 把画布上的尺寸（比例、档位、宽x高或 auto）解析成发给上游的
// size，并拒绝该型号族不接受的取值。请求体与提交前的预检都用这一个函数，避免两边
// 判断不一致。layers 表示这次是图层拆分：官方只接受档位和 auto，不接受显式像素尺寸。
func ResolveSeedreamSize(family, raw string, layers bool) (string, error) {
	size := strings.TrimSpace(raw)
	if size == "" || size == "1:1" {
		size = SeedreamDefaultTier
	}
	if pixels, ok := seedreamRatioSizes[strings.ToLower(size)]; ok {
		// 图层拆分只能按档位出图，比例交给上游按原图保持。
		if layers {
			return SeedreamDefaultTier, nil
		}
		// 比例映射出来的像素仍按型号族规则复核，避免映射表改动后送出无效尺寸。
		if rule, known := SeedreamSizeRuleFor(family); known {
			width, height, _ := parseSeedreamPixelSize(pixels)
			if err := rule.validatePixels(SeedreamFamilyLabel(family), width, height); err != nil {
				return "", err
			}
		}
		return pixels, nil
	}
	if strings.EqualFold(size, "auto") {
		// auto（跟随原图）是 Pro / Flash 图层拆分的专用档位。普通生图的官方取值只有
		// 档位和宽x高，按默认档位发出，和通用插件把 auto 映射成 2k 的做法一致。
		if _, known := SeedreamSizeRuleFor(family); known && !layers {
			return SeedreamDefaultTier, nil
		}
		return "auto", nil
	}
	rule, ok := SeedreamSizeRuleFor(family)
	if !ok {
		// 没识别出型号族（含自定义网关）不套用官方限制。
		return size, nil
	}
	label := SeedreamFamilyLabel(family)
	tier := strings.ToUpper(size)
	for _, allowed := range rule.Tiers {
		if tier == allowed {
			return tier, nil
		}
	}
	if layers {
		// 图层拆分只接受档位和 auto，官方不支持显式像素尺寸。
		return "", fmt.Errorf("Seedream %s 的图层拆分不支持 %s，请改选 %s 档位，或选「跟随原图」", label, size, strings.Join(rule.Tiers, "、"))
	}
	if isSeedreamTierName(tier) {
		return "", fmt.Errorf("Seedream %s 没有 %s 档位，请改选 %s，或直接填宽x高像素（例如 %s）", label, size, strings.Join(rule.Tiers, "、"), rule.MinExampleSize)
	}
	width, height, ok := parseSeedreamPixelSize(size)
	if !ok {
		return "", fmt.Errorf("Seedream %s 看不懂尺寸 %s，请填 %s 档位、16:9 这类画布比例，或宽x高像素（例如 %s）", label, size, strings.Join(rule.Tiers, "、"), rule.MinExampleSize)
	}
	if err := rule.validatePixels(label, width, height); err != nil {
		return "", err
	}
	return fmt.Sprintf("%dx%d", width, height), nil
}

// validatePixels 的报错会原样显示在画布上，所以用「至少/最多多大多小」这类直白说法，
// 不抛像素区间、宽高比小数这些内部口径。
func (r SeedreamSizeRule) validatePixels(label string, width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("Seedream %s 的宽和高要填正整数像素，例如 %s", label, r.MinExampleSize)
	}
	ratio := float64(width) / float64(height)
	// 16:1 与 1:16 对应 seedreamMaxRatio 与 seedreamMinRatio。
	if ratio < seedreamMinRatio || ratio > seedreamMaxRatio {
		return fmt.Errorf("Seedream %s 支持最宽 16:1、最窄 1:16 的图片，%dx%d 超出这个范围", label, width, height)
	}
	pixels := int64(width) * int64(height)
	if pixels < r.MinPixels {
		return fmt.Errorf("Seedream %s 的图片至少要 %s（%s），%dx%d 只有 %s", label, r.MinExampleSize, megapixels(r.MinPixels), width, height, megapixels(pixels))
	}
	if pixels > r.MaxPixels {
		return fmt.Errorf("Seedream %s 的图片最多 %s（%s），%dx%d 有 %s", label, r.MaxExampleSize, megapixels(r.MaxPixels), width, height, megapixels(pixels))
	}
	return nil
}

// megapixels 把像素总数讲成「多少万像素」，避免让用户心算六位数。
func megapixels(pixels int64) string {
	return strconv.FormatFloat(float64(pixels)/10000, 'f', 0, 64) + " 万像素"
}

func isSeedreamTierName(value string) bool {
	switch value {
	case "1K", "1.5K", "2K", "3K", "4K":
		return true
	}
	return false
}

func parseSeedreamPixelSize(raw string) (int, int, bool) {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(raw), "×", "x"), "X", "x"))
	parts := strings.Split(normalized, "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, widthErr := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, heightErr := strconv.Atoi(strings.TrimSpace(parts[1]))
	if widthErr != nil || heightErr != nil {
		return 0, 0, false
	}
	return width, height, true
}
