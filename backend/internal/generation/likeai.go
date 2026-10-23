package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"qisitv/backend/internal/protocol"
)

const LikeAIBaseURL = "https://task.likeai.pro/task-api"
const QisiAPIBaseURL = "https://cheeser.link/api-service/likeai"

func IsLikeAIProtocol(id string) bool {
	return id == "likeai-image" || id == "likeai-video" || id == "likeai-text" || id == "likeai-audio"
}

func LikeAIAuth(baseURL string) (protocol.ManifestAuth, error) {
	switch strings.TrimRight(strings.TrimSpace(baseURL), "/") {
	case LikeAIBaseURL:
		return protocol.ManifestAuth{Type: "header", Header: "X-API-Key", Field: "apiKey"}, nil
	case QisiAPIBaseURL:
		return protocol.ManifestAuth{Type: "bearer", Field: "apiKey"}, nil
	default:
		return protocol.ManifestAuth{}, fmt.Errorf("LikeAI 协议仅允许官方 LikeAI 或 qisi API 地址")
	}
}

// Hydration already checks ownership. Upload only on a fresh submission, never
// when recovering an accepted provider task.
func PrepareLikeAIReferences(ctx context.Context, input *Input) error {
	if !IsLikeAIProtocol(input.Config.InterfaceType) {
		return nil
	}
	auth, err := LikeAIAuth(input.Config.BaseURL)
	if err != nil {
		return err
	}
	if input.Mask != nil {
		return fmt.Errorf("LikeAI 当前任务接口未声明蒙版编辑，不能忽略蒙版生成")
	}
	if err := ValidateLikeAIReferenceRoles(*input); err != nil {
		return err
	}
	for _, group := range []*[]Media{&input.ReferenceImages, &input.ReferenceVideos, &input.ReferenceAudios} {
		for index := range *group {
			media := &(*group)[index]
			if strings.HasPrefix(media.URL, "asset://") {
				return fmt.Errorf("LikeAI 不支持其他供应商的私有素材 ID，请使用本机原始素材")
			}
			if media.DataURL == "" && (strings.HasPrefix(media.URL, "https://") || strings.HasPrefix(media.URL, "http://")) {
				continue
			}
			if media.DataURL == "" {
				return fmt.Errorf("LikeAI 参考素材缺少可上传内容")
			}
			ref := ProtocolMediaReference(*media, "", index)
			spec := protocol.RequestSpec{Method: http.MethodPost, Path: "/files", ContentType: "multipart/form-data", Auth: auth, Files: []protocol.RequestFilePart{{Name: "file", Filename: media.Name, MIMEType: media.MimeType, Reference: ref}}}
			body, err := ExecuteProtocolRequest(WithRequestKind(ctx, "upload"), input.Config, spec)
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
			url := uploaded.URL
			if url == "" {
				url = uploaded.Data.URL
			}
			if !strings.HasPrefix(url, "https://") {
				return fmt.Errorf("LikeAI 上传未返回有效 HTTPS 素材地址")
			}
			media.URL, media.DataURL = url, ""
		}
	}
	return nil
}

func ValidateLikeAIReferenceRoles(input Input) error {
	if input.Mode != "video" {
		return nil
	}
	first, last, references := 0, 0, 0
	for _, image := range ProtocolVideoImageReferences(input) {
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
	if (input.Config.Model == "tongyi_wan_video_3_prime" || input.Config.Model == "wan_video_3_prime") && first+last > 0 && references+len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
		return fmt.Errorf("Wan3 Prime 首尾帧不能与参考素材混用")
	}
	return nil
}
