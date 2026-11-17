package app

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

const arkPrivateAssetSettingKey = "ark_private_assets"

type arkPrivateAssetSettingValue = generation.ArkPrivateAssetSettingValue

func (s *Service) readArkPrivateAssetSetting() (*model.SystemSetting, arkPrivateAssetSettingValue, error) {
	setting, err := s.repo.SystemSetting(arkPrivateAssetSettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, defaultArkPrivateAssetSetting(), nil
	}
	if err != nil {
		return nil, arkPrivateAssetSettingValue{}, err
	}
	value := defaultArkPrivateAssetSetting()
	if strings.TrimSpace(setting.ValueJSON) != "" {
		if err := json.Unmarshal([]byte(setting.ValueJSON), &value); err != nil {
			return nil, arkPrivateAssetSettingValue{}, errors.New("方舟素材库配置格式无效")
		}
	}
	needsMigration := value.AccessKeySecret != "" && !strings.HasPrefix(value.AccessKeySecret, encryptedSettingPrefix)
	secret, err := s.decryptSettingSecret(value.AccessKeySecret)
	if err != nil {
		return nil, arkPrivateAssetSettingValue{}, err
	}
	value.AccessKeySecret = secret
	value = normalizeArkPrivateAssetSetting(value)
	if needsMigration {
		if err := s.saveArkPrivateAssetSetting(setting, value); err != nil {
			return nil, arkPrivateAssetSettingValue{}, err
		}
	}
	return setting, value, nil
}

func (s *Service) saveArkPrivateAssetSetting(setting *model.SystemSetting, value arkPrivateAssetSettingValue) error {
	stored := normalizeArkPrivateAssetSetting(value)
	var err error
	stored.AccessKeySecret, err = s.encryptSettingSecret(stored.AccessKeySecret)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	setting.ValueJSON = string(encoded)
	return s.repo.SaveSystemSetting(setting)
}

func normalizeArkPrivateAssetSetting(value arkPrivateAssetSettingValue) arkPrivateAssetSettingValue {
	value.Region = strings.TrimSpace(value.Region)
	value.ProjectName = strings.TrimSpace(value.ProjectName)
	value.AccessKeyID = strings.TrimSpace(value.AccessKeyID)
	value.AccessKeySecret = strings.TrimSpace(value.AccessKeySecret)
	value.DefaultGroupID = strings.TrimSpace(value.DefaultGroupID)
	return value
}

func defaultArkPrivateAssetSetting() arkPrivateAssetSettingValue {
	return arkPrivateAssetSettingValue{}
}
