package beefapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const historicalReceiptLimit = int64(64 << 20)

// Storage requests deliberately have no API or provider headers. Redirects are
// validated independently, so a different storage vendor needs no client update.
func (c *MediaClient) storageJSON(ctx context.Context, receipt MediaReceipt) ([]byte, error) {
	ctx = c.networkContext(ctx)
	if receipt.Format != "openai-image-response" || receipt.ExpiresAt <= time.Now().Unix() {
		return nil, errors.New("历史图片回执已过期或格式不受支持，请重新查询原任务")
	}
	if err := c.validURLContext(ctx, receipt.URL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, receipt.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.storageClient("历史回执重定向次数过多").Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("历史图片回执下载失败，请重新查询原任务")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, historicalReceiptLimit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > historicalReceiptLimit {
		return nil, errors.New("历史图片回执超过可读取大小")
	}
	return data, nil
}

// storageClient follows redirects to public HTTPS object storage only. Every
// hop is validated, and each hop starts without headers or cookies, so the API
// key and custom API headers never reach storage.
func (c *MediaClient) storageClient(tooMany string) *http.Client {
	client := *c.httpClient()
	client.Jar = nil
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		next.Header = make(http.Header)
		if len(via) >= storageRedirectLimit {
			return errors.New(tooMany)
		}
		return c.validURLContext(next.Context(), next.URL.String())
	}
	return &client
}

const storageRedirectLimit = 10

func (c *MediaClient) Result(ctx context.Context, task MediaTask, legacy bool) (map[string]any, error) {
	if task.MediaType != "image" {
		return c.singleMediaResult(ctx, task)
	}
	items := make([]map[string]any, 0, len(task.Outputs))
	usage, metadata := task.Usage, task.Metadata
	if len(task.Outputs) == 0 && task.ResultReceipt != nil {
		if !legacy {
			return nil, errors.New("新媒体任务未返回可保存的图片链接")
		}
		data, err := c.storageJSON(ctx, *task.ResultReceipt)
		if err != nil {
			return nil, err
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw["data"], &items); err != nil {
			return nil, err
		}
		usage = raw["usage"]
		metadata = make(map[string]any)
		for key, value := range raw {
			if key == "data" || key == "usage" {
				continue
			}
			var decoded any
			if err := json.Unmarshal(value, &decoded); err != nil {
				return nil, err
			}
			metadata[key] = decoded
		}
	} else {
		for _, output := range task.Outputs {
			if output.Kind != "image" {
				return nil, errors.New("媒体结果类型不匹配")
			}
			if err := c.validURLContext(ctx, output.URL); err != nil {
				return nil, err
			}
			item := make(map[string]any, len(output.Metadata)+1)
			for key, value := range output.Metadata {
				item[key] = value
			}
			item["url"] = output.URL
			items = append(items, item)
		}
	}
	images := make([]map[string]string, 0, len(items))
	layers := make([]map[string]any, 0, len(items))
	hasLayer := false
	for index, item := range items {
		link, _ := item["url"].(string)
		if encoded, _ := item["b64_json"].(string); encoded != "" {
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return nil, errors.New("历史图片结果编码无效")
			}
			mime := strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0])
			switch mime {
			case "image/png", "image/jpeg", "image/webp", "image/gif":
			default:
				return nil, errors.New("历史图片结果不是可识别的图片")
			}
			link = "data:" + mime + ";base64," + encoded
		} else if err := c.validURLContext(ctx, link); err != nil {
			return nil, err
		}
		if link == "" {
			return nil, errors.New("媒体结果缺少图片")
		}
		images = append(images, map[string]string{"dataUrl": link})
		layer := map[string]any{"imageIndex": index}
		for key, value := range item {
			if key != "url" && key != "b64_json" && key != "imageIndex" {
				layer[key] = value
				hasLayer = true
			}
		}
		layers = append(layers, layer)
	}
	if len(images) == 0 {
		return nil, errors.New("媒体任务未返回可保存的图片")
	}
	result := map[string]any{"mode": "image", "images": images}
	if hasLayer {
		result["imageLayers"] = layers
	}
	if len(metadata) > 0 {
		result["metadata"] = metadata
	}
	if len(usage) > 0 && string(usage) != "null" {
		var value any
		if err := json.Unmarshal(usage, &value); err != nil {
			return nil, err
		}
		result["usage"] = value
	}
	return result, nil
}

// Videos, speech and upscale return one owned storage URL. Local delivery owns
// downloading it; control-plane queries never proxy the media bytes.
func (c *MediaClient) singleMediaResult(ctx context.Context, task MediaTask) (map[string]any, error) {
	if task.MediaType != "video" && task.MediaType != "audio" && task.MediaType != "upscale" {
		return nil, errors.New("媒体任务类型不受支持")
	}
	if len(task.Outputs) != 1 {
		return nil, errors.New("媒体任务未返回唯一可保存的结果")
	}
	output := task.Outputs[0]
	if task.MediaType == "upscale" {
		if output.Kind != "image" && output.Kind != "video" {
			return nil, errors.New("超分结果类型不匹配")
		}
		if c.ExpectedOutputKind != "" && output.Kind != c.ExpectedOutputKind {
			return nil, errors.New("超分结果与原素材类型不一致")
		}
	} else if output.Kind != task.MediaType {
		return nil, errors.New("媒体结果类型不匹配")
	}
	if err := c.validURLContext(ctx, output.URL); err != nil {
		return nil, err
	}
	item := map[string]any{"url": output.URL}
	for key, value := range output.Metadata {
		if key != "url" && key != "dataUrl" && key != "resourceId" && key != "storageKey" {
			item[key] = value
		}
	}
	result := map[string]any{"mode": output.Kind}
	if output.Kind == "image" {
		result["images"] = []map[string]any{item}
	} else {
		result[output.Kind] = item
	}
	if len(task.Metadata) > 0 {
		result["metadata"] = task.Metadata
	}
	if len(task.Usage) > 0 && string(task.Usage) != "null" {
		var usage any
		if err := json.Unmarshal(task.Usage, &usage); err != nil {
			return nil, err
		}
		result["usage"] = usage
	}
	return result, nil
}
