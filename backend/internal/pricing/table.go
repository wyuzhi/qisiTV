// Package pricing turns BeefAPI's published price rows into estimates before a
// generation is submitted. It is the only place BeefTV computes a price; the
// bill stays authoritative.
package pricing

import (
	"encoding/json"
	"math"
	"strings"
)

// Table keeps the field names of one row in BeefAPI's public price catalog
// (/api/enterprise/catalog), so a stored model profile reads like its source.
type Table struct {
	Mode                string             `json:"mode"`
	Kind                string             `json:"display_kind,omitempty"`
	PerRequest          *float64           `json:"per_request_cny,omitempty"`
	PerSecond           map[string]float64 `json:"per_second_cny,omitempty"`
	VideoInputPerSecond map[string]float64 `json:"video_input_per_second_cny,omitempty"`
	ReferenceImage      *float64           `json:"reference_image_cny,omitempty"`
	FreeReferenceImages int                `json:"free_reference_images,omitempty"`
	Image               *ImageTable        `json:"image_price_table,omitempty"`
	VideoSeconds        []VideoSecondRate  `json:"video_official,omitempty"`
	VideoTokens         []VideoTokenRate   `json:"video_token_rates,omitempty"`
	InputPerMillion     *float64           `json:"input_cny,omitempty"`
	Invoice             *Invoice           `json:"invoice_billing,omitempty"`
	// ReferenceInvoice comes only from the older /v1/models video quote.
	ReferenceInvoice *ReferenceInvoice `json:"reference_invoice,omitempty"`
}

type ImageTable struct {
	Output         map[string]map[string]float64 `json:"output"`
	Reference      *float64                      `json:"reference,omitempty"`
	DefaultQuality string                        `json:"default_quality,omitempty"`
	DefaultSize    string                        `json:"default_size,omitempty"`
	AutoQuality    string                        `json:"auto_quality,omitempty"`
}

// VideoSecondRate is BeefAPI's per-second conversion of a video token price.
type VideoSecondRate struct {
	Resolution string  `json:"resolution"`
	Output     float64 `json:"output_per_second_cny"`
	Input      float64 `json:"input_per_second_cny"`
}

// VideoTokenRate is a price per million video tokens; Input applies when the
// request carries a reference video.
type VideoTokenRate struct {
	Resolution string  `json:"resolution"`
	Output     float64 `json:"output_cny"`
	Input      float64 `json:"input_cny"`
}

// Invoice marks a model charged up front and settled after the bill.
type Invoice struct {
	Reservation float64 `json:"reservation_cny"`
}

type ReferenceInvoice struct {
	USDCNY     float64 `json:"usd_cny"`
	ReserveUSD float64 `json:"reserve_usd"`
}

// ParseCatalog reads the /api/enterprise/catalog response into raw rows keyed
// by model name. Every amount in it is CNY.
func ParseCatalog(body []byte) (map[string]json.RawMessage, bool) {
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			Currency string            `json:"currency"`
			Models   []json.RawMessage `json:"models"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil || !payload.Success || payload.Data.Currency != "CNY" {
		return nil, false
	}
	rows := make(map[string]json.RawMessage, len(payload.Data.Models))
	for _, raw := range payload.Data.Models {
		var row struct {
			ModelName string `json:"model_name"`
		}
		if json.Unmarshal(raw, &row) == nil && strings.TrimSpace(row.ModelName) != "" {
			rows[strings.TrimSpace(row.ModelName)] = raw
		}
	}
	return rows, true
}

// Normalize validates one catalog row. Rows with a malformed or missing price
// are rejected as a whole so a partial row never prices a request.
func Normalize(raw json.RawMessage) (*Table, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var table Table
	if json.Unmarshal(raw, &table) != nil {
		return nil, false
	}
	return table.normalized()
}

func (t Table) normalized() (*Table, bool) {
	t.Mode = strings.TrimSpace(t.Mode)
	t.Kind = strings.TrimSpace(t.Kind)
	if t.Mode != "per_request" && t.Mode != "video_tokens" && t.Mode != "tokens" {
		return nil, false
	}
	if !validPrice(t.PerRequest) || !validPrice(t.ReferenceImage) || !validPrice(t.InputPerMillion) || t.FreeReferenceImages < 0 {
		return nil, false
	}
	var ok bool
	if t.PerSecond, ok = resolutionPrices(t.PerSecond); !ok {
		return nil, false
	}
	if t.VideoInputPerSecond, ok = resolutionPrices(t.VideoInputPerSecond); !ok {
		return nil, false
	}
	for i := range t.VideoSeconds {
		rate := &t.VideoSeconds[i]
		rate.Resolution = videoResolution(rate.Resolution)
		if rate.Resolution == "" || !positive(rate.Output) || !finite(rate.Input) || rate.Input < 0 {
			return nil, false
		}
	}
	for i := range t.VideoTokens {
		rate := &t.VideoTokens[i]
		rate.Resolution = videoResolution(rate.Resolution)
		if rate.Resolution == "" || !positive(rate.Output) || !finite(rate.Input) || rate.Input < 0 {
			return nil, false
		}
	}
	if t.Image != nil {
		image, ok := t.Image.normalized()
		if !ok {
			return nil, false
		}
		t.Image = image
	}
	if t.Invoice != nil && !positive(t.Invoice.Reservation) {
		return nil, false
	}
	if t.ReferenceInvoice != nil && (!positive(t.ReferenceInvoice.USDCNY) || !positive(t.ReferenceInvoice.ReserveUSD)) {
		return nil, false
	}
	if t.PerRequest == nil && len(t.PerSecond) == 0 && len(t.VideoSeconds) == 0 && len(t.VideoTokens) == 0 &&
		t.Image == nil && t.InputPerMillion == nil && t.Invoice == nil {
		return nil, false
	}
	return &t, true
}

func (image ImageTable) normalized() (*ImageTable, bool) {
	if !validPrice(image.Reference) {
		return nil, false
	}
	output := map[string]map[string]float64{}
	for quality, tiers := range image.Output {
		quality = strings.ToLower(strings.TrimSpace(quality))
		if quality == "" {
			return nil, false
		}
		prices := map[string]float64{}
		for tier, price := range tiers {
			tier = strings.ToUpper(strings.TrimSpace(tier))
			if tier == "" || !positive(price) {
				return nil, false
			}
			prices[tier] = price
		}
		if len(prices) > 0 {
			output[quality] = prices
		}
	}
	if len(output) == 0 {
		return nil, false
	}
	image.Output = output
	image.DefaultQuality = strings.ToLower(strings.TrimSpace(image.DefaultQuality))
	image.AutoQuality = strings.ToLower(strings.TrimSpace(image.AutoQuality))
	image.DefaultSize = strings.TrimSpace(image.DefaultSize)
	return &image, true
}

// FromVideoQuote reads the older video quote that /v1/models returns
// (videoPricing). It covers a connection whose price catalog read failed.
func FromVideoQuote(quote map[string]any) *Table {
	if len(quote) == 0 {
		return nil
	}
	raw, err := json.Marshal(quote)
	if err != nil {
		return nil
	}
	var value struct {
		Mode                string            `json:"mode"`
		ReferenceImage      *float64          `json:"reference_image"`
		FreeReferenceImages int               `json:"free_reference_images"`
		ReferenceInvoice    *ReferenceInvoice `json:"reference_invoice"`
		Rates               map[string]struct {
			Output         float64 `json:"output"`
			ReferenceVideo float64 `json:"reference_video"`
		} `json:"rates"`
	}
	if json.Unmarshal(raw, &value) != nil || len(value.Rates) == 0 {
		return nil
	}
	table := Table{Kind: "video", ReferenceImage: value.ReferenceImage, FreeReferenceImages: value.FreeReferenceImages, ReferenceInvoice: value.ReferenceInvoice}
	switch value.Mode {
	case "seconds":
		table.Mode = "per_request"
		table.PerSecond = map[string]float64{}
		for resolution, rate := range value.Rates {
			table.PerSecond[resolution] = rate.Output
		}
	case "tokens":
		table.Mode = "video_tokens"
		for resolution, rate := range value.Rates {
			table.VideoTokens = append(table.VideoTokens, VideoTokenRate{Resolution: resolution, Output: rate.Output, Input: rate.ReferenceVideo})
		}
	default:
		return nil
	}
	normalized, ok := table.normalized()
	if !ok {
		return nil
	}
	return normalized
}

func resolutionPrices(values map[string]float64) (map[string]float64, bool) {
	if len(values) == 0 {
		return nil, true
	}
	result := make(map[string]float64, len(values))
	for resolution, price := range values {
		key := videoResolution(resolution)
		if key == "" || !finite(price) || price < 0 {
			return nil, false
		}
		result[key] = price
	}
	return result, true
}

// videoResolution accepts the forms canvases and catalogs use: 720p, 720, 2K.
func videoResolution(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if strings.Trim(value, "0123456789") == "" {
		return value + "p"
	}
	return value
}

func validPrice(value *float64) bool {
	return value == nil || finite(*value) && *value >= 0
}

func positive(value float64) bool {
	return finite(value) && value > 0
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
