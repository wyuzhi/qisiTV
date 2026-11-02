package app

import (
	"mime/multipart"

	"qisitv/backend/internal/appearance"
	"qisitv/backend/internal/model"
)

const (
	appearanceSettingKey       = appearance.SettingKey
	AppearanceAssetLogo        = appearance.AssetLogo
	AppearanceAssetDarkLogo    = appearance.AssetDarkLogo
	AppearanceAssetVideo       = appearance.AssetVideo
	appearanceSchemaVersion    = appearance.SchemaVersion
	defaultAppearanceBrandName = appearance.DefaultBrandName
	defaultAppearanceBrandSlug = appearance.DefaultBrandSlug
	defaultAppearanceSkinID    = appearance.DefaultSkinID
	defaultAppearanceLogoURL   = appearance.DefaultLogoURL
	defaultAppearanceVideoURL  = appearance.DefaultVideoURL
	defaultAppearancePosterURL = appearance.DefaultPosterURL
	defaultAppearanceHeroTitle = appearance.DefaultHeroTitle
)

type (
	AppearanceSetting             = appearance.Setting
	PublicAppearanceSetting       = appearance.PublicSetting
	AdminAppearanceSetting        = appearance.AdminSetting
	AppearanceSkinTheme           = appearance.AppearanceSkinTheme
	AppearanceSkinModeTokens      = appearance.AppearanceSkinModeTokens
	AppearanceSkinTokens          = appearance.AppearanceSkinTokens
	AppearanceSkinComponentTokens = appearance.AppearanceSkinComponentTokens
)

func validateAppearanceUpload(slot string, h *multipart.FileHeader) (string, error) { return appearance.ValidateUpload(slot, h) }
func defaultAppearanceSetting() AppearanceSetting                                   { return appearance.DefaultSetting() }
func (s *Service) AppearanceDomain() *appearance.Service {
	if s == nil {
		return appearance.New(appearance.Dependencies{})
	}
	s.appearanceOnce.Do(func() {
		s.appearance = appearance.NewFromHost(appearance.HostConfig{Settings: s.repo, Resources: s.repo, DataDir: s.dataDir, RequireAdmin: s.RequireAdmin, AppendAudit: s.appendAdminAudit, Mutex: &s.storageMu})
	})
	return s.appearance
}
func (s *Service) Appearance() (*PublicAppearanceSetting, error)                                              { return s.AppearanceDomain().Public() }
func (s *Service) AdminAppearance(actor *model.User) (*AdminAppearanceSetting, error)                         { return s.AppearanceDomain().Admin(actor) }
func (s *Service) UpdateAppearance(actor *model.User, v AppearanceSetting) (*AdminAppearanceSetting, error)   { return s.AppearanceDomain().Update(actor, v) }
func (s *Service) ResetAppearance(actor *model.User) (*AdminAppearanceSetting, error)                         { return s.AppearanceDomain().Reset(actor) }
func (s *Service) UploadAppearanceAsset(actor *model.User, slot string, h *multipart.FileHeader) (*model.Resource, error) { return s.AppearanceDomain().UploadAsset(actor, slot, h, s.uploadLocalResource, s.UploadResource) }
func (s *Service) OpenAppearanceAsset(slot, rng string) (*ResourceStream, error)                              { return s.AppearanceDomain().OpenAsset(slot, rng, s.openResourceRange) }
func (s *Service) appearanceReferencedResourceIDs(ids []string) map[string]struct{}                           { return s.AppearanceDomain().ReferencedIDs(ids) }
func (s *Service) appearanceIdentity() (string, string)                                                       { return s.AppearanceDomain().Identity() }
