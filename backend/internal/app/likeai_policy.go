package app

import (
	"net/url"
	"strings"

	"qisitv/backend/internal/workspace"
)

// UseLikeAIOnly is applied by the local application composition root before
// workers start. Historical protocol adapters remain available to data tooling.
func (s *Service) UseLikeAIOnly() { s.likeAIOnly = true }

func validLikeAIBaseURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && u.Scheme == "https" && u.Host == "task.likeai.pro" &&
		u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		strings.TrimRight(u.Path, "/") == "/task-api"
}

func (s *Service) requireActiveProvider(protocol, baseURL string) error {
	if !s.likeAIOnly {
		return nil
	}
	if !isLikeAIProtocol(protocol) || !validLikeAIBaseURL(baseURL) {
		return BadAuthRequest("当前 qisiTV 仅支持 LikeAI，请在模型设置中选择 LikeAI 模型")
	}
	return nil
}

func (s *Service) requireActiveTaskProvider(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	return s.requireActiveProvider(stringValue(config["interfaceType"]), stringValue(config["baseUrl"]))
}

func (s *Service) requireActiveCatalogProvider(input *ChannelModelsRequest) error {
	if !s.likeAIOnly {
		return nil
	}
	if input.APIFormat != "likeai" || (input.ChannelID != "" && input.ChannelID != "likeai") ||
		(input.BaseURL != "" && !validLikeAIBaseURL(input.BaseURL)) {
		return BadAuthRequest("当前 qisiTV 仅支持 LikeAI 模型目录")
	}
	input.BaseURL = workspace.LikeAIBaseURL
	return nil
}
