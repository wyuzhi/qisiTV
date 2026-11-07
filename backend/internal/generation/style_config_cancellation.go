package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/prompts"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

type StyleExecutionPlanDocument struct {
	SchemaVersion   int    `json:"schemaVersion"`
	ProfilePresetID string `json:"profilePresetId"`
	ProfileRevision int    `json:"profileRevision"`
	Mode            string `json:"mode"`
	Model           string `json:"model"`
	InterfaceType   string `json:"interfaceType"`
	Status          string `json:"status"`
	Prompt          string `json:"prompt"`
}

func ApplyGenerationStyleProfile(repo *repository.Repository, userID string, taskProjectID string, input *Input) error {
	styleProfileJSON := metadataString(input.Metadata, "styleProfileJson")
	if strings.TrimSpace(styleProfileJSON) == "" {
		return nil
	}
	if _, err := prompts.ValidateStyleProfileJSON(styleProfileJSON); err != nil {
		return fmt.Errorf("项目画风执行配置无效：%w", err)
	}
	var profile prompts.StyleProfileDocument
	if err := json.Unmarshal([]byte(styleProfileJSON), &profile); err != nil {
		return fmt.Errorf("项目画风执行配置解析失败：%w", err)
	}
	storedProfileJSON, storedPresetID, belongsToProject, err := TaskProjectStyleProfile(repo, userID, taskProjectID)
	if err != nil {
		return fmt.Errorf("读取项目画风失败：%w", err)
	}
	if belongsToProject {
		if strings.TrimSpace(storedProfileJSON) == "" {
			if strings.TrimSpace(storedPresetID) == "" || strings.TrimSpace(profile.PresetID) != strings.TrimSpace(storedPresetID) {
				return errors.New("项目画风已发生变化，请返回项目列表后重新打开当前项目再生成")
			}
		} else {
			matches, compareErr := EquivalentStyleProfileJSON(styleProfileJSON, storedProfileJSON)
			if compareErr != nil {
				return errors.New("项目画风配置暂时无法读取，请在项目设置中重新保存画风后重试")
			}
			if !matches {
				validatedStoredProfileJSON, validateErr := prompts.ValidateStyleProfileJSON(storedProfileJSON)
				if validateErr != nil || json.Unmarshal([]byte(validatedStoredProfileJSON), &profile) != nil {
					return errors.New("项目画风配置暂时无法读取，请在项目设置中重新保存画风后重试")
				}
			}
		}
	}
	plan, _ := DecodeStyleExecutionPlan(input.Metadata["styleExecutionPlan"])
	stylePrompt, expectedStatus, warnings := ResolveGenerationStyleExecution(profile, input.Config.Model, firstNonEmpty(input.Config.InterfaceType, input.Config.APIFormat))
	input.Prompt = ReconcileGenerationStylePrompt(input.Prompt, plan.Prompt, stylePrompt)
	if expectedStatus == "blocked" {
		return fmt.Errorf("当前图片模型无法完整执行项目画风：%s。请切换图片模型，或在项目设置中停用对应画风资产", strings.Join(warnings, "；"))
	}
	return nil
}

func ReconcileGenerationStylePrompt(prompt string, previousStylePrompt string, currentStylePrompt string) string {
	content := strings.TrimSpace(prompt)
	previous := strings.TrimSpace(previousStylePrompt)
	if previous != "" {
		previousBlock := "【项目画风执行规范】\n" + previous
		if strings.HasSuffix(content, previousBlock) {
			content = strings.TrimSpace(strings.TrimSuffix(content, previousBlock))
		}
	}
	current := strings.TrimSpace(currentStylePrompt)
	if current == "" || strings.HasSuffix(content, "【项目画风执行规范】\n"+current) {
		return content
	}
	return strings.TrimSpace(content + "\n\n【项目画风执行规范】\n" + current)
}

func TaskProjectStyleProfile(repo *repository.Repository, userID string, canvasOrProjectID string) (string, string, bool, error) {
	id := strings.TrimSpace(canvasOrProjectID)
	if id == "" || repo == nil {
		return "", "", false, nil
	}
	if canvas, err := repo.CanvasProjectForUser(userID, id); err == nil {
		if strings.TrimSpace(canvas.ProjectID) == "" {
			return "", "", false, nil
		}
		project, projectErr := repo.ProjectForUser(userID, canvas.ProjectID)
		if projectErr != nil {
			return "", "", true, projectErr
		}
		return project.StyleProfileJSON, project.StylePresetID, true, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", "", false, err
	}
	project, err := repo.ProjectForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	return project.StyleProfileJSON, project.StylePresetID, true, nil
}

func EquivalentStyleProfileJSON(left string, right string) (bool, error) {
	var leftValue interface{}
	if err := json.Unmarshal([]byte(left), &leftValue); err != nil {
		return false, err
	}
	var rightValue interface{}
	if err := json.Unmarshal([]byte(right), &rightValue); err != nil {
		return false, err
	}
	leftCanonical, err := json.Marshal(leftValue)
	if err != nil {
		return false, err
	}
	rightCanonical, err := json.Marshal(rightValue)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftCanonical, rightCanonical), nil
}

func DecodeStyleExecutionPlan(value interface{}) (StyleExecutionPlanDocument, error) {
	if value == nil {
		return StyleExecutionPlanDocument{}, errors.New("项目画风执行计划缺失")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return StyleExecutionPlanDocument{}, errors.New("项目画风执行计划格式无效")
	}
	var plan StyleExecutionPlanDocument
	if err := json.Unmarshal(raw, &plan); err != nil {
		return StyleExecutionPlanDocument{}, errors.New("项目画风执行计划格式无效")
	}
	return plan, nil
}

func ResolveGenerationStyleExecution(profile prompts.StyleProfileDocument, generationModel string, interfaceType string) (string, string, []string) {
	fragments := []string{strings.TrimSpace(profile.Prompt)}
	if negative := strings.TrimSpace(profile.NegativePrompt); negative != "" {
		fragments = append(fragments, "【全局负面 Prompt】\n"+negative)
	}
	warnings := make([]string, 0)
	for _, asset := range profile.Assets {
		if asset.Enabled != nil && !*asset.Enabled {
			continue
		}
		if asset.Status != "validated" {
			reason := "资产尚未验证"
			if asset.Status == "unavailable" {
				reason = "资产当前不可用"
			}
			warnings = append(warnings, asset.Title+"："+reason)
			continue
		}
		if len(asset.BaseModels) > 0 && !StyleAssetSupportsModel(asset.BaseModels, generationModel) {
			warnings = append(warnings, asset.Title+"：仅兼容 "+strings.Join(asset.BaseModels, "、"))
			continue
		}
		switch asset.Kind {
		case "prompt", "template":
			fragments = append(fragments, strings.TrimSpace(asset.PromptFragment))
			fragments = append(fragments, prompts.NonEmptyStyleProfileStrings(asset.TriggerWords)...)
		case "reference":
			warnings = append(warnings, asset.Title+"：项目参考图自动注入适配器尚未启用")
		case "lora":
			warnings = append(warnings, asset.Title+"：当前 "+firstNonEmpty(interfaceType, "图片")+" 协议未启用 LoRA 适配器")
		}
	}
	normalizedFragments := prompts.NonEmptyStyleProfileStrings(fragments)
	status := "ready"
	if len(warnings) > 0 {
		status = "degraded"
		if profile.ExecutionPolicy == "strict-assets" {
			status = "blocked"
		}
	}
	return strings.Join(normalizedFragments, "\n"), status, warnings
}

func StyleAssetSupportsModel(baseModels []string, generationModel string) bool {
	for _, baseModel := range baseModels {
		if strings.EqualFold(strings.TrimSpace(baseModel), strings.TrimSpace(generationModel)) {
			return true
		}
	}
	return false
}

func ValidateResolvedImageCapability(repo *repository.Repository, readLocalConfig func() ([]byte, error), input *Input) error {
	if err := ResolveImageCapability(repo, readLocalConfig, input); err != nil {
		return err
	}
	if strings.TrimSpace(input.Config.ChannelID) == "" || input.ImageCapability == nil {
		return nil
	}
	return validateImageTask(input.ImageCapability, *input)
}

func ResolveImageCapability(repo *repository.Repository, readLocalConfig func() ([]byte, error), input *Input) error {
	if input.Config.CredentialRef == beefapi.CredentialRef {
		body, err := readLocalConfig()
		if err != nil {
			return err
		}
		for _, item := range modelcatalog.ParseLocalChannelModels(body) {
			if item.ChannelID != "beeftv" || item.Model != input.Config.Model || item.ImageCapabilitiesVersion == nil || strings.TrimSpace(*item.ImageCapabilitiesVersion) == "" {
				continue
			}
			raw, err := json.Marshal(item.CapabilityConfig)
			if err != nil {
				return err
			}
			input.Config.CapabilityConfig, err = modelcatalog.DecodeModelCapabilityConfig(string(raw))
			if err != nil {
				return err
			}
			input.Config.ImageCapabilitiesVersion = item.ImageCapabilitiesVersion
			break
		}
	}
	if input.Config.ImageCapabilitiesVersion != nil && strings.TrimSpace(*input.Config.ImageCapabilitiesVersion) != "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Image == nil || !ValidVersionedImageCapability(profile.Image) {
			input.ImageCapability = nil
			return nil
		}
		input.ImageCapability = profile.Image
		return nil
	}
	fallback := modelcatalog.DefaultImageCapabilityConfig(input.Config.InterfaceType, input.Config.Model)
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		if input.Config.CapabilityConfig != nil && input.Config.CapabilityConfig.Image != nil {
			input.ImageCapability = input.Config.CapabilityConfig.Image
		} else {
			fallback.References.MaxImageBytes = 0
			input.ImageCapability = fallback
		}
		return nil
	}
	item, err := repo.ChannelModelByKey(channelID, ProviderChannelModelKey(input.Config))
	if err != nil {
		return errors.New("当前系统渠道模型未配置或已停用")
	}
	profile, err := modelcatalog.DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		return errors.New("当前图片模型能力参数无效")
	}
	if profile != nil && profile.Image != nil {
		input.ImageCapability = profile.Image
	} else {
		input.ImageCapability = fallback
	}
	return nil
}

func ValidVersionedImageCapability(image *ImageCapabilityConfig) bool {
	if image == nil {
		return false
	}
	copied := *image
	if modelcatalog.ValidateImageCapabilityConfig(&copied) == nil {
		return true
	}
	raw, err := json.Marshal(image)
	if err != nil {
		return false
	}
	_, ok := modelcatalog.NormalizeCatalogImageCapability(raw)
	return ok
}

func ValidateResolvedVideoCapabilityContext(ctx context.Context, repo *repository.Repository, readLocalConfig func() ([]byte, error), input *Input) error {
	if err := ResolveVideoCapability(ctx, repo, readLocalConfig, input); err != nil {
		return err
	}
	if strings.TrimSpace(input.Config.ChannelID) == "" || input.VideoCapability == nil {
		return nil
	}
	return validateVideoTask(input.VideoCapability, *input)
}

func ResolveVideoCapability(ctx context.Context, repo *repository.Repository, readLocalConfig func() ([]byte, error), input *Input) error {
	if input.Config.CredentialRef == beefapi.CredentialRef {
		body, err := readLocalConfig()
		if err != nil {
			return err
		}
		input.Config.VideoCapabilitiesVersion = nil
		input.Config.CapabilityConfig = nil
		for _, item := range modelcatalog.ParseLocalChannelModels(body) {
			if item.ChannelID != "beeftv" || !item.Enabled || item.Model != input.Config.Model || item.VideoCapabilitiesVersion == nil || strings.TrimSpace(*item.VideoCapabilitiesVersion) == "" {
				continue
			}
			config, _ := item.CapabilityConfig.(map[string]any)
			rawVideo, _ := json.Marshal(config["video"])
			video, valid := beefapi.NormalizeVersionedVideoCapability(rawVideo, *item.VideoCapabilitiesVersion)
			if !valid {
				continue
			}
			raw, err := json.Marshal(map[string]any{"version": 1, "video": video})
			if err != nil {
				return err
			}
			input.Config.CapabilityConfig, err = modelcatalog.DecodeModelCapabilityConfig(string(raw))
			if err != nil {
				return err
			}
			input.Config.VideoCapabilitiesVersion = item.VideoCapabilitiesVersion
			break
		}
		if input.Config.VideoCapabilitiesVersion == nil {
			return nil
		}
	}
	if input.Config.VideoCapabilitiesVersion != nil && strings.TrimSpace(*input.Config.VideoCapabilitiesVersion) != "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil || modelcatalog.ValidateVideoCapabilityConfig(profile.Video) != nil {
			input.VideoCapability = nil
			return nil
		}
		input.VideoCapability = profile.Video
		applyFixedVideoResolution(input, profile.Video)
		return nil
	}
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil {
			seedance2 := modelcatalog.IsSeedance2Family(input.Config.InterfaceType, input.Config.Model)
			if input.Config.InterfaceType != string(model.ChannelInterfaceAgnesVideo) && !seedance2 {
				return nil
			}
			profile = modelcatalog.DefaultModelCapabilityConfigForModel(input.Config.InterfaceType, input.Config.Model)
		}
		normalized, err := modelcatalog.NormalizeModelCapabilityConfigForModel("video", input.Config.InterfaceType, input.Config.Model, profile)
		if err != nil || normalized == nil || normalized.Video == nil {
			return nil
		}
		input.Config.CapabilityConfig = normalized
		RestoreBeefAPISeedanceAudioControl(ctx, input.Config, normalized.Video)
		input.VideoCapability = normalized.Video
		applyFixedVideoResolution(input, normalized.Video)
		return nil
	}
	item, err := repo.ChannelModelByKey(channelID, ProviderChannelModelKey(input.Config))
	if err != nil {
		return errors.New("当前系统渠道模型未配置或已停用")
	}
	profile, err := modelcatalog.DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil || profile == nil || profile.Video == nil {
		return errors.New("当前视频模型尚未配置能力参数")
	}
	normalized, err := modelcatalog.NormalizeModelCapabilityConfigForModel("video", string(item.Protocol), firstNonEmpty(item.ProviderModelKey, item.ModelKey), profile)
	if err != nil || normalized == nil || normalized.Video == nil {
		return errors.New("当前视频模型能力参数无效")
	}
	input.VideoCapability = normalized.Video
	RestoreBeefAPISeedanceAudioControl(ctx, input.Config, normalized.Video)
	applyFixedVideoResolution(input, normalized.Video)
	return nil
}

func ResolveProviderConfig(repo *repository.Repository, localMode bool, systemChannel func(string) (*model.ModelChannel, error), config Config) (Config, error) {
	headers, err := outbound.NormalizeOutboundHeaders(config.Headers)
	if err != nil {
		return Config{}, err
	}
	config.Headers = headers
	if localMode && strings.TrimSpace(config.ChannelID) != "" {
		return Config{}, errors.New("本地工作区不支持系统渠道配置")
	}
	channelID := strings.TrimSpace(config.ChannelID)
	if channelID == "" {
		channelID = modelcatalog.SystemChannelIDFromBaseURL(config.BaseURL)
	}
	if channelID == "" {
		if _, err := outbound.ValidateOutboundURL(config.BaseURL); err != nil {
			return Config{}, err
		}
		return config, nil
	}
	channel, err := systemChannel(channelID)
	if err != nil {
		return Config{}, errors.New("系统渠道不存在或已停用")
	}
	modelKey := strings.TrimPrefix(strings.TrimSpace(config.ChannelModelKey), "models/")
	requestedModel := strings.TrimPrefix(strings.TrimSpace(config.Model), "models/")
	if modelKey == "" {
		modelKey = requestedModel
	}
	if modelKey == "" {
		channelModels, listErr := repo.ChannelModels(channel.ID, false)
		if listErr != nil {
			return Config{}, listErr
		}
		if len(channelModels) > 0 {
			modelKey = channelModels[0].ModelKey
		} else {
			models := modelcatalog.ChannelModelNames(*channel)
			if len(models) == 0 {
				return Config{}, errors.New("系统渠道未配置可用模型")
			}
			modelKey = models[0]
		}
	}
	if _, err := outbound.ValidateOutboundURL(channel.BaseURL); err != nil {
		return Config{}, err
	}
	config.ChannelID = channel.ID
	config.APIFormat = channel.APIFormat
	channelModel, modelErr := repo.ChannelModelByKey(channel.ID, modelKey)
	if modelErr != nil {
		return Config{}, errors.New("当前系统渠道未授权该模型")
	}
	if channelModel.Protocol == "" {
		return Config{}, errors.New("当前模型尚未配置请求协议")
	}
	providerModelKey := strings.TrimPrefix(strings.TrimSpace(config.ProviderModelKey), "models/")
	authorizedUpstream := strings.TrimPrefix(strings.TrimSpace(channelModel.ProviderModelKey), "models/")
	if config.VariantID != "" {
		matched := false
		for _, tier := range channelModel.Variants {
			if tier.ID == config.VariantID && tier.Enabled {
				providerModelKey = firstNonEmpty(providerModelKey, tier.ProviderModelKey)
				matched = true
				break
			}
		}
		if !matched {
			return Config{}, errors.New("当前模型规格已更新，请重新创建任务")
		}
	} else if !TrustedSystemModelIdentity(modelKey, requestedModel, providerModelKey, authorizedUpstream) {
		return Config{}, errors.New("系统渠道模型标识不一致")
	}
	config.InterfaceType = string(channelModel.Protocol)
	config.APIFormat = ChannelAPIFormatForProtocol(channel.APIFormat, channelModel.Protocol)
	config.BaseURL = channel.BaseURL
	config.APIKey = channel.APIKey
	config.SecretKey = channel.SecretKey
	config.Headers, err = outbound.ParseOutboundHeadersJSON(channel.HeadersJSON)
	if err != nil {
		return Config{}, err
	}
	config.ChannelModelKey = modelKey
	config.ProviderModelKey = providerModelKey
	config.Model = firstNonEmpty(providerModelKey, channelModel.ProviderModelKey, modelKey)
	return config, nil
}

func ChannelAPIFormatForProtocol(channelDefault string, protocol model.ChannelInterfaceType) string {
	switch protocol {
	case model.ChannelInterfaceGeminiVeo, model.ChannelInterfaceGeminiImage:
		return "gemini"
	case model.ChannelInterfaceClaudeAPI:
		return "claude"
	case "":
		return strings.TrimSpace(channelDefault)
	default:
		return "openai"
	}
}

func ProviderChannelModelKey(config Config) string {
	return strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(config.ChannelModelKey, config.Model)), "models/")
}

func TrustedSystemModelIdentity(sku, requestedModel, requestedProviderKey, authorizedUpstream string) bool {
	return AllowedSystemModelKey(requestedModel, sku, authorizedUpstream) && AllowedSystemModelKey(requestedProviderKey, sku, authorizedUpstream)
}

func AllowedSystemModelKey(value, sku, authorizedUpstream string) bool {
	value = strings.TrimSpace(value)
	return value == "" || value == sku || (authorizedUpstream != "" && value == authorizedUpstream)
}

func TaskMediaFromProvider(media Media) modelcatalog.MediaRef {
	return taskMediaFromProvider(media)
}

func TaskMediaListFromProvider(items []Media) []modelcatalog.MediaRef {
	return taskMediaListFromProvider(items)
}

func TaskInputFromCanvas(input Input) modelcatalog.TaskInput {
	return taskInputFromCanvas(input)
}

func ApplyTaskConfigToCanvas(input *Input, task modelcatalog.TaskInput) {
	applyTaskConfigToCanvas(input, task)
}
