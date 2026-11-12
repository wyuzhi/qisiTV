package pricing

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Target is one planned generation in the shape BeefTV will submit it.
type Target struct {
	Kind            string // image, video or audio
	Size            string // image size as sent; empty uses the catalog default
	Quality         string // image quality as sent; empty or auto uses the catalog default
	Layers          bool   // Seedream layer decomposition
	Count           int
	ReferenceImages int
	ReferenceVideos int
	Resolution      string
	Seconds         float64 // duration of one video output
	Characters      int     // speech text length
}

// Estimate is either a known amount in CNY or the reason it is unknown. Basis
// says how the amount was reached so the user can check it against the bill.
type Estimate struct {
	Amount *float64 `json:"amount"`
	// Approx marks an amount converted from a token price or a character count.
	Approx bool   `json:"approx,omitempty"`
	Basis  string `json:"basis"`
	// Text is the line shown to the user: the amount with its basis, or the reason.
	Text string `json:"text"`
	// Reserve is charged up front and settled later; it never joins a total.
	Reserve *float64 `json:"reserve,omitempty"`
}

type Summary struct {
	Amount  float64 `json:"amount"`
	Priced  int     `json:"priced"`
	Unknown int     `json:"unknown"`
	Approx  bool    `json:"approx,omitempty"`
	Text    string  `json:"text"`
}

func Unknown(reason string) Estimate {
	return Estimate{Basis: reason, Text: reason}
}

// Quote prices one target from the catalog row only. Anything the row does
// not determine is returned as unknown instead of a guessed number.
func Quote(table *Table, target Target) Estimate {
	if table == nil {
		return Unknown("暂无价格")
	}
	count := max(target.Count, 1)
	if table.Invoice != nil {
		reserve := round(table.Invoice.Reservation * float64(count))
		return reserved(reserve, fmt.Sprintf("先扣 %s，账单核对后按实际结算", total(reserve)))
	}
	switch target.Kind {
	case "image":
		return quoteImage(table, target, count)
	case "video":
		return quoteVideo(table, target, count)
	case "audio":
		return quoteAudio(table, target, count)
	}
	return Unknown("暂无价格")
}

func Summarize(items []Estimate) Summary {
	var summary Summary
	for _, item := range items {
		if item.Amount == nil {
			summary.Unknown++
			continue
		}
		summary.Priced++
		summary.Amount += *item.Amount
		summary.Approx = summary.Approx || item.Approx
	}
	summary.Amount = round(summary.Amount)
	label := ""
	if summary.Approx {
		label = "约 "
	}
	switch {
	case summary.Priced == 0:
		summary.Text = "预计费用：暂无价格，按所选渠道实际计费"
	case summary.Unknown == 0:
		summary.Text = "预计费用：" + label + total(summary.Amount)
	default:
		summary.Text = fmt.Sprintf("预计费用：已知部分%s%s，另有 %d 项暂无价格", label, total(summary.Amount), summary.Unknown)
	}
	return summary
}

func quoteImage(table *Table, target Target, count int) Estimate {
	if image := table.Image; image != nil {
		// BeefTV 官方算力 publishes Seedream rows with standard/layers qualities. Those
		// rows tier by pixel area and include the first reference image.
		seedream := image.Output["standard"] != nil
		tier := imageTier(image, target.Size, seedream)
		if target.Layers {
			if price, ok := image.Output["layers"][tier]; ok {
				return Unknown(fmt.Sprintf("图层拆分按实际拆出的图层数计费，每层 %s", yuan(price)))
			}
			return Unknown("图层拆分暂无价格")
		}
		quality := imageQuality(image, target.Quality)
		price, ok := image.Output[quality][tier]
		if !ok {
			return Unknown(strings.TrimSpace(tier+" "+qualityLabel(quality)) + " 暂无价格")
		}
		refs := target.ReferenceImages
		if seedream {
			refs--
		}
		refs = max(refs, 0)
		refPrice := 0.0
		if image.Reference != nil {
			refPrice = *image.Reference
		}
		basis := fmt.Sprintf("%s %s/张 × %d 张", strings.TrimSpace(tier+" "+qualityLabel(quality)), yuan(price), count)
		if refs > 0 && refPrice > 0 {
			basis += fmt.Sprintf(" + 参考图 %d 张 × %s", refs, yuan(refPrice))
		}
		return known(price*float64(count)+refPrice*float64(refs), false, basis)
	}
	if table.PerRequest != nil && *table.PerRequest > 0 {
		return known(*table.PerRequest*float64(count), false, fmt.Sprintf("%s/张 × %d 张", yuan(*table.PerRequest), count))
	}
	return Unknown("暂无价格")
}

func quoteVideo(table *Table, target Target, count int) Estimate {
	resolution := videoResolution(target.Resolution)
	if resolution == "" {
		return Unknown("分辨率未定，暂无价格")
	}
	if !(target.Seconds > 0) {
		return Unknown("时长由模型决定，按实际时长结算")
	}
	seconds := target.Seconds
	if rate, ok := table.PerSecond[resolution]; ok {
		if target.ReferenceVideos > 0 {
			if input, declared := table.VideoInputPerSecond[resolution]; !declared || input > 0 {
				return Unknown(fmt.Sprintf("含参考视频，按生成和参考视频的实际秒数结算（%s %s/秒）", resolution, yuan(rate)))
			}
		}
		if invoice := table.ReferenceInvoice; invoice != nil && target.ReferenceImages > 0 {
			reserve := round(invoice.ReserveUSD * invoice.USDCNY * 1.5 * float64(count))
			return reserved(reserve, fmt.Sprintf("参考生成先扣 %s，出账后按实际美元账单 × %s × 1.5 结算", total(reserve), number(invoice.USDCNY)))
		}
		paid, refPrice := 0, 0.0
		if table.ReferenceImage != nil && *table.ReferenceImage > 0 {
			paid, refPrice = max(target.ReferenceImages-table.FreeReferenceImages, 0), *table.ReferenceImage
		}
		basis := fmt.Sprintf("%s %s/秒 × %s 秒", resolution, yuan(rate), number(seconds))
		if paid > 0 {
			basis += fmt.Sprintf(" + 参考图 %d 张 × %s", paid, yuan(refPrice))
		}
		return known((rate*seconds+refPrice*float64(paid))*float64(count), false, withCount(basis, count))
	}
	tokens := tokenRate(table, resolution)
	if target.ReferenceVideos > 0 {
		if tokens != nil {
			return Unknown(fmt.Sprintf("含参考视频，按实际视频 Token 结算（%s %s/百万 Token）", resolution, yuan(tokens.Input)))
		}
		return Unknown("含参考视频，按实际视频 Token 结算")
	}
	if rate := secondRate(table, resolution); rate != nil {
		basis := withCount(fmt.Sprintf("%s %s/秒 × %s 秒", resolution, yuan(rate.Output), number(seconds)), count) + "，按 Token 折算"
		return known(rate.Output*seconds*float64(count), true, basis)
	}
	if tokens != nil {
		return Unknown(fmt.Sprintf("%s 按实际视频 Token 结算（%s/百万 Token）", resolution, yuan(tokens.Output)))
	}
	return Unknown(resolution + " 暂无价格")
}

func quoteAudio(table *Table, target Target, count int) Estimate {
	if table.Mode == "tokens" && table.InputPerMillion != nil && *table.InputPerMillion > 0 {
		if target.Characters <= 0 {
			return Unknown("台词为空，暂无价格")
		}
		per := *table.InputPerMillion
		basis := withCount(fmt.Sprintf("%d 字 × %s/百万字", target.Characters, yuan(per)), count)
		return known(per/1e6*float64(target.Characters)*float64(count), true, basis)
	}
	if table.PerRequest != nil && *table.PerRequest > 0 {
		return known(*table.PerRequest*float64(count), false, fmt.Sprintf("%s/次 × %d 次", yuan(*table.PerRequest), count))
	}
	return Unknown("暂无价格")
}

func imageQuality(image *ImageTable, quality string) string {
	quality = strings.ToLower(strings.TrimSpace(quality))
	if quality == "" || quality == "auto" || quality == "any" {
		if image.AutoQuality != "" {
			return image.AutoQuality
		}
		quality = image.DefaultQuality
	}
	if image.Output[quality] == nil && len(image.Output) == 1 {
		for only := range image.Output {
			return only
		}
	}
	return quality
}

// imageTier mirrors how BeefTV 官方算力 picks the billed tier from the sent size.
func imageTier(image *ImageTable, size string, seedream bool) string {
	size = strings.ToUpper(strings.TrimSpace(strings.ReplaceAll(size, "×", "x")))
	if size == "" || size == "AUTO" {
		size = strings.ToUpper(image.DefaultSize)
	}
	width, height, pixels := imagePixels(size)
	if seedream {
		switch {
		case size == "1K" || size == "1.5K":
			return "1K"
		case size == "2K" || size == "3K" || size == "4K":
			return "2K"
		case pixels && width*height <= 2610000:
			return "1K"
		case pixels:
			return "2K"
		}
		return ""
	}
	switch {
	case size == "1K" || size == "2K" || size == "4K":
		return size
	case pixels && min(width, height) <= 1024:
		return "1K"
	case pixels && min(width, height) <= 2048:
		return "2K"
	case pixels:
		return "4K"
	}
	return ""
}

func imagePixels(size string) (int, int, bool) {
	parts := strings.Split(size, "X")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func qualityLabel(quality string) string {
	switch quality {
	case "low":
		return "低质量"
	case "medium":
		return "中质量"
	case "high":
		return "高质量"
	case "xhigh":
		return "超高质量"
	case "max":
		return "最高质量"
	case "standard", "":
		return ""
	}
	return quality
}

func secondRate(table *Table, resolution string) *VideoSecondRate {
	for i := range table.VideoSeconds {
		if table.VideoSeconds[i].Resolution == resolution {
			return &table.VideoSeconds[i]
		}
	}
	return nil
}

func tokenRate(table *Table, resolution string) *VideoTokenRate {
	for i := range table.VideoTokens {
		if table.VideoTokens[i].Resolution == resolution {
			return &table.VideoTokens[i]
		}
	}
	return nil
}

func known(amount float64, approx bool, basis string) Estimate {
	amount = round(amount)
	label := "预计 "
	if approx {
		label = "约 "
	}
	return Estimate{Amount: &amount, Approx: approx, Basis: basis, Text: fmt.Sprintf("%s%s（%s）", label, total(amount), basis)}
}

func reserved(reserve float64, basis string) Estimate {
	return Estimate{Reserve: &reserve, Basis: basis, Text: basis}
}

func withCount(basis string, count int) string {
	if count <= 1 {
		return basis
	}
	return fmt.Sprintf("每个 %s，共 %d 个", basis, count)
}

func round(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// yuan shows a unit price to four decimals so the basis multiplies out.
func yuan(value float64) string {
	return "¥" + number(math.Round(value*10000)/10000)
}

// total shows a sum to the fen once it reaches one yuan.
func total(value float64) string {
	if value < 1 {
		return yuan(value)
	}
	return "¥" + number(math.Round(value*100)/100)
}

func number(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
