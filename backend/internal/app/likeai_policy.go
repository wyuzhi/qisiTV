package app

import (
	"net/url"
	"strings"

	"qisitv/backend/internal/workspace"
)

// Kept for older composition roots. qisiTV supports independent assistant and
// media channels; selecting a preferred service must not disable other tools.
func (s *Service) UseLikeAIOnly() {}

func validLikeAIBaseURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && u.Scheme == "https" && u.Host == "task.likeai.pro" &&
		u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		strings.TrimRight(u.Path, "/") == "/task-api"
}

func (s *Service) requireActiveProvider(protocol, baseURL string) error {
	if !isLikeAIProtocol(protocol) {
		return nil
	}
	if !validLikeAIBaseURL(baseURL) && baseURL != "https://cheeser.link/api-service/likeai" {
		return BadAuthRequest("LikeAI 协议仅允许官方 LikeAI 或 qisi API 地址")
	}
	return nil
}

func (s *Service) requireActiveTaskProvider(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	return s.requireActiveProvider(stringValue(config["interfaceType"]), stringValue(config["baseUrl"]))
}

func (s *Service) requireActiveCatalogProvider(input *ChannelModelsRequest) error {
	if input.APIFormat != "likeai" {
		return nil
	}
	if input.BaseURL != "" {
		return s.requireActiveProvider("likeai-image", input.BaseURL)
	}
	input.BaseURL = workspace.LikeAIBaseURL
	return nil
}
