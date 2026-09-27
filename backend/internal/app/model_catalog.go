package app

import (
	"encoding/json"
	"fmt"
	"log"

	"qisitv/backend/internal/model"
)

// ModelCatalogSource 决定 ModelCatalogResponse 中哪一个集合具有语义。
// frontend 与 system 的数据形状互斥，调用方不能把缺失集合解释成空目录。
type ModelCatalogSource string

const (
	// ModelCatalogSourceFrontend 表示目录由前台逻辑模型组成。
	ModelCatalogSourceFrontend ModelCatalogSource = "frontend"
	// ModelCatalogSourceSystem 表示目录由脱敏后的系统渠道与渠道模型组成。
	ModelCatalogSourceSystem ModelCatalogSource = "system"
)

// ModelCatalogResponse 是创作端模型选择的统一读模型。
// Source=frontend 时读取 Models；Source=system 时读取 Channels。
// 两个集合都始终序列化为数组：空目录必须发 []，缺字段会被前端判成畸形响应。
type ModelCatalogResponse struct {
	Source   ModelCatalogSource     `json:"source"`
	Models   []PublicLogicalModel   `json:"models"`
	Channels []PublicChannelCatalog `json:"channels"`
}

// PublicChannelCatalog 公开的渠道目录信息（脱敏）
type PublicChannelCatalog struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	DisplayName string               `json:"displayName"`
	SortOrder   int                  `json:"sortOrder"`
	Models      []PublicChannelModel `json:"models"`
}

// PublicChannelModel 公开的渠道模型信息（脱敏）
type PublicChannelModel struct {
	ID               string                     `json:"id"`
	ModelKey         string                     `json:"modelKey"`
	DisplayName      string                     `json:"displayName"`
	SortOrder        int                        `json:"sortOrder"`
	Icon             string                     `json:"icon"`
	Capability       string                     `json:"capability"`
	Protocol         model.ChannelInterfaceType `json:"protocol"`
	CapabilityConfig map[string]any             `json:"capabilityConfig,omitempty"`
	Available        bool                       `json:"available"`
}

// ModelCatalog 按功能开关返回互斥的数据形状：frontend 使用 Models，system 使用 Channels。
// 系统渠道目录只负责安全发布可解释的读模型。
func (s *Service) ModelCatalog(intent *ModelRequestIntent) (*ModelCatalogResponse, error) {
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return nil, err
	}

	// 两个集合都初始化成非 nil 空切片：空目录要发 []，不能因为“没有模型”而丢掉字段。
	response := &ModelCatalogResponse{Models: []PublicLogicalModel{}, Channels: []PublicChannelCatalog{}}
	if frontendEnabled {
		models, err := s.PublicLogicalModels(intent)
		if err != nil {
			return nil, err
		}
		response.Source = ModelCatalogSourceFrontend
		response.Models = append(response.Models, models...)
		return response, nil
	}

	channels, err := s.publicSystemChannelCatalog(intent)
	if err != nil {
		return nil, err
	}
	response.Source = ModelCatalogSourceSystem
	response.Channels = append(response.Channels, channels...)
	return response, nil
}

// publicSystemChannelCatalog 组装普通用户可见的系统渠道读模型，不暴露密钥、Base URL 等执行凭证。
// 这是读展示路径：单个损坏模型被隔离并记录诊断；仓储查询失败仍整体返回错误，避免伪装成空目录。
func (s *Service) publicSystemChannelCatalog(intent *ModelRequestIntent) ([]PublicChannelCatalog, error) {
	channels, err := s.repo.SystemChannels(true)
	if err != nil {
		return nil, err
	}

	result := make([]PublicChannelCatalog, 0, len(channels))
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}

		channelModels, err := s.repo.ChannelModels(channel.ID, false)
		if err != nil {
			return nil, err
		}

		publicModels := make([]PublicChannelModel, 0, len(channelModels))
		for _, cm := range channelModels {
			if !cm.Enabled {
				continue
			}

			// 目录是读路径：单个损坏模型应被隔离并记录诊断，不能拖垮其余可用模型；
			// 同一记录进入任务创建写路径时会失败关闭，不会绕过能力合同。
			if intent != nil {
				matched, matchErr := s.channelModelMatchesIntent(&cm, intent)
				if matchErr != nil {
					log.Printf("system channel model omitted from catalog id=%s: invalid capability: %v", cm.ID, matchErr)
					continue
				}
				if !matched {
					continue
				}
			}

			publicModel, sanitizeErr := s.sanitizeChannelModel(&cm)
			if sanitizeErr != nil {
				log.Printf("system channel model omitted from catalog id=%s: %v", cm.ID, sanitizeErr)
				continue
			}
			publicModels = append(publicModels, publicModel)
		}

		if len(publicModels) > 0 {
			result = append(result, PublicChannelCatalog{
				ID:          channel.ID,
				Name:        channel.PublicName(),
				DisplayName: channel.PublicName(),
				SortOrder:   channel.SortOrder,
				Models:      publicModels,
			})
		}
	}

	return result, nil
}

// sanitizeChannelModel 脱敏渠道模型，只保留用户可见且可执行的信息。
// 能力 JSON 无效时返回错误，由目录聚合层执行“隔离 + 告警”，禁止发布缺失能力合同的模型。
func (s *Service) sanitizeChannelModel(cm *model.ChannelModel) (PublicChannelModel, error) {
	if cm == nil {
		return PublicChannelModel{}, fmt.Errorf("渠道模型为空")
	}
	var capabilityConfig map[string]any
	normalized, err := normalizedChannelModelCapability(cm)
	if err != nil {
		return PublicChannelModel{}, err
	}
	if normalized != nil {
		capabilityConfig, err = modelCapabilityConfigToMap(normalized)
		if err != nil {
			return PublicChannelModel{}, fmt.Errorf("投影渠道模型能力配置失败：%w", err)
		}
	}

	return PublicChannelModel{
		ID:               cm.ID,
		ModelKey:         cm.ModelKey,
		DisplayName:      cm.DisplayName,
		SortOrder:        cm.SortOrder,
		Icon:             cm.Icon,
		Capability:       cm.Capability,
		Protocol:         cm.Protocol,
		CapabilityConfig: capabilityConfig,
		Available:        cm.Enabled,
	}, nil
}

// channelModelMatchesIntent 使用与任务 admission 相同的服务端能力合同过滤目录。
// 音频能力当前没有可编辑的细分能力 JSON，只校验能力类型；其参数仍由 provider 专用校验负责。
func (s *Service) channelModelMatchesIntent(cm *model.ChannelModel, intent *ModelRequestIntent) (bool, error) {
	if cm == nil || intent == nil {
		return true, nil
	}
	if normalizeCapability(intent.Capability) != "" && normalizeCapability(cm.Capability) != normalizeCapability(intent.Capability) {
		return false, nil
	}
	if normalizeCapability(cm.Capability) == "audio" {
		return true, nil
	}
	config, err := normalizedChannelModelCapability(cm)
	if err != nil {
		return false, err
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(config, cm.Capability)
	if err != nil {
		return false, err
	}
	match := MatchCapability(spec, *intent)
	return match.Matched, nil
}

// modelCapabilityConfigToMap 将 ModelCapabilityConfig 转换为 map[string]any
func modelCapabilityConfigToMap(config *ModelCapabilityConfig) (map[string]any, error) {
	if config == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
}
