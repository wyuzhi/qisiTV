package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"qisitv/backend/internal/protocol"
)

const likeAIBaseURL = "https://task.likeai.pro/task-api"

func isLikeAIProtocol(id string) bool {
	return id == "likeai-image" || id == "likeai-video" || id == "likeai-text" || id == "likeai-audio"
}

func fetchLikeAIModelCatalog(ctx context.Context, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	headers, err := NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}
	config := providerConfig{BaseURL: input.BaseURL, APIKey: input.APIKey, Headers: headers}
	body, err := executeProtocolRequest(ctx, config, protocol.RequestSpec{Method: http.MethodGet, Path: "/task/models", Auth: likeAIAuth()})
	if err != nil {
		return nil, channelModelsUpstreamError(err)
	}
	var response struct {
		Code int `json:"code"`
		Data struct {
			Models []struct {
				Name string `json:"api_name"`
				Type string `json:"type"`
			} `json:"models"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &response) != nil || response.Code != 200 {
		return nil, fmt.Errorf("LikeAI 模型目录返回失败，请检查 API Key 与服务状态")
	}
	seen := map[string]bool{}
	items := []ChannelModelCatalogItem{}
	for _, model := range response.Data.Models {
		name, kind := strings.TrimSpace(model.Name), strings.TrimSpace(model.Type)
		if kind == "chat" {
			kind = "text"
		}
		if name == "" || seen[name] || normalizeCapability(kind) == "" {
			continue
		}
		seen[name] = true
		item := ChannelModelCatalogItem{ID: name, DisplayName: name, ModelType: kind, SupportedEndpointTypes: []string{"likeai-" + kind}}
		if kind == "video" {
			item.DefaultParameters.Resolution = "720p"
			item.DefaultParameters.DurationSeconds = "5"
		}
		if kind == "image" {
			item.DefaultParameters.Resolution = "1080p"
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

func likeAIAuth() protocol.ManifestAuth {
	return protocol.ManifestAuth{Type: "header", Header: "X-API-Key", Field: "apiKey"}
}

// Local resources have already been hydrated through ownership-checked storage.
// Upload them only when submitting a new task; recovery must never upload or create again.
func prepareLikeAIReferences(ctx context.Context, input *canvasGenerationInput) error {
	if !isLikeAIProtocol(input.Config.InterfaceType) {
		return nil
	}
	if input.Mask != nil {
		return fmt.Errorf("LikeAI 当前任务接口未声明蒙版编辑，不能忽略蒙版生成")
	}
	if err := validateLikeAIReferenceRoles(*input); err != nil {
		return err
	}
	groups := []*[]providerMedia{&input.ReferenceImages, &input.ReferenceVideos, &input.ReferenceAudios}
	for _, group := range groups {
		for index := range *group {
			media := &(*group)[index]
			if strings.HasPrefix(media.URL, "asset://") {
				continue
			}
			if media.DataURL == "" && (strings.HasPrefix(media.URL, "https://") || strings.HasPrefix(media.URL, "http://")) {
				continue
			}
			if media.DataURL == "" {
				return fmt.Errorf("LikeAI 参考素材缺少可上传内容")
			}
			ref := protocolMediaReference(*media, "", index)
			spec := protocol.RequestSpec{Method: http.MethodPost, Path: "/files", ContentType: "multipart/form-data", Auth: likeAIAuth(), Files: []protocol.RequestFilePart{{Name: "file", Filename: media.Name, MIMEType: media.MimeType, Reference: ref}}}
			body, err := executeProtocolRequest(withProviderRequestKind(ctx, "upload"), input.Config, spec)
			if err != nil {
				return fmt.Errorf("LikeAI 上传参考素材失败：%w", err)
			}
			var uploaded struct {
				URL  string `json:"url"`
				Data struct {
					URL string `json:"url"`
				} `json:"data"`
			}
			if json.Unmarshal(body, &uploaded) != nil {
				return fmt.Errorf("LikeAI 上传响应无效")
			}
			url := firstNonEmpty(uploaded.URL, uploaded.Data.URL)
			if !strings.HasPrefix(url, "https://") {
				return fmt.Errorf("LikeAI 上传未返回有效 HTTPS 素材地址")
			}
			media.URL, media.DataURL = url, ""
		}
	}
	return nil
}

func validateLikeAIReferenceRoles(input canvasGenerationInput) error {
	if input.Mode != "video" {
		return nil
	}
	first, last, references := 0, 0, 0
	for _, image := range protocolVideoImageReferences(input) {
		switch image.Role {
		case "first_frame":
			first++
		case "last_frame":
			last++
		default:
			references++
		}
	}
	if first > 1 || last > 1 {
		return fmt.Errorf("LikeAI 首帧和尾帧各只能指定一张图片")
	}
	if last > 0 && first == 0 && input.Config.Model != "qianfan_vidu_q2_turbo_video_extend" {
		return fmt.Errorf("LikeAI 尾帧必须同时指定首帧")
	}
	if input.Config.Model == "doubao_seedance_2_5" && first > 0 && input.Config.Size != "adaptive" {
		return fmt.Errorf("Seedance 2.5 使用首帧时画幅必须为 adaptive")
	}
	if (input.Config.Model == "tongyi_wan_video_3_prime" || input.Config.Model == "wan_video_3_prime") && (first+last) > 0 && references+len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
		return fmt.Errorf("Wan3 Prime 首尾帧不能与参考素材混用")
	}
	return nil
}
