package mediaattempt

import (
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
	"net/http"
	"strings"
)

var ErrIdentityUnavailable = errors.New("原图片渠道或凭据身份已不可用")

// 幂等键的范围还包括上游账号和 token。这里只核对原渠道是否仍可用，
// 绝不把当前渠道的地址或凭据填回冻结请求，更不解析同模型的备用路由。
func (s *Service) ImageRecoveryChannelAvailable(attempt *model.RouteAttempt, wire WireRequest) (bool, error) {
	if attempt == nil {
		return false, nil
	}
	if attempt.ChannelID != "" {
		if wire.ChannelID != "" && wire.ChannelID != attempt.ChannelID {
			return false, nil
		}
		channel, err := s.connections.SystemChannel(attempt.ChannelID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		headers, err := outbound.ParseOutboundHeadersJSON(channel.HeadersJSON)
		if err != nil {
			return false, err
		}
		return sameFrozenImageIdentity(wire, channel.BaseURL, channel.APIKey, headers), nil
	}

	channelID := wire.ChannelID
	// 历史直连记录没有 channel ID；只对可明确识别的托管源核对原 Bearer 身份。
	if channelID == "" && beefapi.IsEnterpriseBaseURL(wire.URL) {
		channelID = beefapi.ChannelID
	}
	if channelID == beefapi.ChannelID && s.connections.HasManagedCredential() {
		key, base, _, _, err := s.connections.LookupManagedCredential()
		if err != nil {
			var appErr *kernel.AppError
			if errors.As(err, &appErr) && appErr.Status < 500 {
				return false, nil
			}
			return false, err
		}
		return sameFrozenImageIdentity(wire, base, key, nil), nil
	}
	if channelID == "" {
		return false, nil
	}
	body, err := s.connections.ReadLocalModelConfig()
	if err != nil {
		return false, err
	}
	var config struct {
		Channels []struct {
			ID      string                    `json:"id"`
			Enabled *bool                     `json:"enabled"`
			BaseURL string                    `json:"baseUrl"`
			APIKey  string                    `json:"apiKey"`
			Headers []outbound.OutboundHeader `json:"headers"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(body, &config); err != nil {
		return false, err
	}
	for _, channel := range config.Channels {
		if channel.ID != channelID {
			continue
		}
		if channel.Enabled != nil && !*channel.Enabled {
			return false, nil
		}
		return sameFrozenImageIdentity(wire, channel.BaseURL, channel.APIKey, channel.Headers), nil
	}
	return false, nil
}

func sameFrozenImageIdentity(wire WireRequest, baseURL, apiKey string, headers []outbound.OutboundHeader) bool {
	if !generation.SameProviderOrigin(baseURL, wire.URL) {
		return false
	}
	current := &http.Request{Header: make(http.Header)}
	if strings.TrimSpace(apiKey) != "" {
		current.Header.Set("Authorization", "Bearer "+apiKey)
	}
	outbound.ApplyOutboundHeaders(current, headers)
	if current.Header.Get("Authorization") == "" || current.Header.Get("Authorization") != wire.Header.Get("Authorization") {
		return false
	}
	for _, name := range []string{"X-API-Key", "X-Goog-API-Key", "Cookie"} {
		if current.Header.Get(name) != wire.Header.Get(name) {
			return false
		}
	}
	return true
}
