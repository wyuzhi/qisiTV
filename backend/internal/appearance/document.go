package appearance

import (
	"encoding/json"
	"errors"
	"strings"

	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

func (s *Service) read() (*model.SystemSetting, Setting, error) {
	if s == nil || s.settings == nil {
		return nil, Setting{}, errors.New("外观配置尚未初始化")
	}
	setting, err := s.settings.SystemSetting(SettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, DefaultSetting(), nil
	}
	if err != nil {
		return nil, Setting{}, err
	}
	value := DefaultSetting()
	if strings.TrimSpace(setting.ValueJSON) == "" || json.Unmarshal([]byte(setting.ValueJSON), &value) != nil {
		return nil, Setting{}, errors.New("外观配置格式无效")
	}
	return setting, normalizeDocument(value), nil
}

func normalizeDocument(value Setting) Setting {
	value = migrateLegacyBrand(value)
	value.SchemaVersion = SchemaVersion
	value.BrandName = strings.TrimSpace(value.BrandName)
	if value.BrandName == "" {
		value.BrandName = DefaultBrandName
	}
	value.BrandSlug = strings.ToLower(strings.TrimSpace(value.BrandSlug))
	if value.BrandSlug == "" {
		value.BrandSlug = DefaultBrandSlug
	}
	value.AuthHeroTitle = normalizeCopy(value.AuthHeroTitle)
	if value.AuthHeroTitle == "" {
		value.AuthHeroTitle = DefaultHeroTitle
	}
	value.AuthHeroDescription = normalizeCopy(value.AuthHeroDescription)
	value.SkinID = strings.TrimSpace(value.SkinID)
	if value.SkinID == "" {
		value.SkinID = DefaultSkinID
	}
	if len(value.SkinThemes) == 0 {
		value.SkinThemes = DefaultSkinThemes()
	}
	value.SkinThemes = NormalizeSkinThemes(value.SkinThemes)
	value.SEOTitle = normalizeSingleLine(value.SEOTitle)
	value.SEODescription = normalizeCopy(value.SEODescription)
	value.SEOKeywords = normalizeSingleLine(value.SEOKeywords)
	value.FooterCopyright = normalizeSingleLine(value.FooterCopyright)
	value.ICPFilingNumber = normalizeSingleLine(value.ICPFilingNumber)
	return value
}

func migrateLegacyBrand(value Setting) Setting {
	// Translate only the old product identity, preserving custom workspace brands.
	if strings.TrimSpace(value.BrandName) == "BeefTV" {
		value.BrandName = DefaultBrandName
		value.SEOTitle = strings.ReplaceAll(value.SEOTitle, "BeefTV", DefaultBrandName)
		value.SEODescription = strings.ReplaceAll(value.SEODescription, "BeefTV", DefaultBrandName)
		value.FooterCopyright = strings.ReplaceAll(value.FooterCopyright, "BeefTV", DefaultBrandName)
	}
	if strings.EqualFold(strings.TrimSpace(value.BrandSlug), "beeftv") {
		value.BrandSlug = DefaultBrandSlug
	}
	return value
}

func normalizeCopy(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
}

func normalizeSingleLine(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", " "), "\r", " "))
}

func resourceID(value Setting, slot string) string {
	switch slot {
	case AssetLogo:
		return value.LogoResourceID
	case AssetDarkLogo:
		return value.DarkLogoResourceID
	case AssetVideo:
		return value.AuthVideoResourceID
	case AssetPoster:
		return value.AuthVideoPosterResourceID
	default:
		return ""
	}
}

func referencedIDs(value Setting) []string {
	return []string{
		value.LogoResourceID,
		value.DarkLogoResourceID,
		value.AuthVideoResourceID,
		value.AuthVideoPosterResourceID,
	}
}
