package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
)

const responseInterceptionSettingKey = "response_interception"

const (
	maxResponseInterceptionRules        = 100
	maxResponseInterceptionTextRunes    = 200
	maxResponseInterceptionReplaceRunes = 500
)

type ResponseInterceptionRule struct {
	Contains string `json:"contains"`
	Replace  string `json:"replace"`
}

type ResponseInterceptionSetting struct {
	Enabled bool                       `json:"enabled"`
	Rules   []ResponseInterceptionRule `json:"rules"`
}

func defaultResponseInterceptionSetting() ResponseInterceptionSetting {
	return ResponseInterceptionSetting{Rules: []ResponseInterceptionRule{}}
}

// InterceptResponseText 只投影用户可见文案，不修改上游响应或请求明细中的原始内容。
func (s *Service) InterceptResponseText(raw string) string {
	raw = strings.TrimSpace(raw)
	setting, readErr := s.responseInterceptionSetting()
	if readErr != nil || !setting.Enabled {
		return raw
	}
	return interceptResponseMessage(setting, raw)
}

// UserFacingErrorMessage 只投影用户可见错误，不修改上游响应或请求明细中的原始内容。
func (s *Service) UserFacingErrorMessage(err error) string {
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		return s.InterceptResponseText(providerUserFacingErrorMessage(err))
	}
	return s.InterceptResponseText(taskFailureMessage(err))
}

func interceptResponseMessage(setting ResponseInterceptionSetting, raw string) string {
	lower := strings.ToLower(raw)
	for _, rule := range setting.Rules {
		if strings.Contains(lower, strings.ToLower(rule.Contains)) {
			return rule.Replace
		}
	}
	return raw
}

func (s *Service) responseInterceptionSetting() (ResponseInterceptionSetting, error) {
	setting, err := s.repo.SystemSetting(responseInterceptionSettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return defaultResponseInterceptionSetting(), nil
	}
	if err != nil {
		return ResponseInterceptionSetting{}, err
	}
	value := defaultResponseInterceptionSetting()
	if strings.TrimSpace(setting.ValueJSON) == "" {
		return value, nil
	}
	if err := json.Unmarshal([]byte(setting.ValueJSON), &value); err != nil {
		return ResponseInterceptionSetting{}, fmt.Errorf("模型响应拦截配置格式错误: %w", err)
	}
	value = normalizeResponseInterceptionSetting(value)
	if err := validateResponseInterceptionSetting(value); err != nil {
		return ResponseInterceptionSetting{}, err
	}
	return value, nil
}

func normalizeResponseInterceptionSetting(value ResponseInterceptionSetting) ResponseInterceptionSetting {
	if value.Rules == nil {
		value.Rules = []ResponseInterceptionRule{}
	}
	for index := range value.Rules {
		value.Rules[index].Contains = strings.TrimSpace(value.Rules[index].Contains)
		value.Rules[index].Replace = strings.TrimSpace(value.Rules[index].Replace)
	}
	return value
}

func validateResponseInterceptionSetting(value ResponseInterceptionSetting) error {
	if len(value.Rules) > maxResponseInterceptionRules {
		return fmt.Errorf("模型响应拦截规则不能超过 %d 条", maxResponseInterceptionRules)
	}
	for index, rule := range value.Rules {
		if rule.Contains == "" {
			return fmt.Errorf("第 %d 条拦截规则的匹配文案不能为空", index+1)
		}
		if len([]rune(rule.Contains)) > maxResponseInterceptionTextRunes {
			return fmt.Errorf("第 %d 条拦截规则的匹配文案不能超过 %d 个字符", index+1, maxResponseInterceptionTextRunes)
		}
		if rule.Replace == "" {
			return fmt.Errorf("第 %d 条拦截规则的替换文案不能为空", index+1)
		}
		if len([]rune(rule.Replace)) > maxResponseInterceptionReplaceRunes {
			return fmt.Errorf("第 %d 条拦截规则的替换文案不能超过 %d 个字符", index+1, maxResponseInterceptionReplaceRunes)
		}
	}
	return nil
}
