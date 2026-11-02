package app

import (
	"qisitv/backend/internal/admin"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
)

type (
	AdminListQuery        = admin.ListQuery
	AdminChannelReference = admin.ChannelReference
)

func (s *Service) adminHost() admin.Host {
	return admin.Host{
		Repo: s.repo, EncryptSecret: s.encryptSettingSecret, DecryptSecret: s.decryptSettingSecret,
		SyncInitialModels: s.syncInitialChannelModels, UpdatePresentation: s.updateChannelPresentation, InvalidateRoutes: s.invalidateRouteCatalog,
	}
}
func (s *Service) RequireAdmin(user *model.User) error                                              { return admin.RequireAdmin(user) }
func (s *Service) PublicSystemChannels() ([]PublicModelChannel, error)                              { return admin.PublicSystemChannels(s.repo) }
func (s *Service) SystemChannel(id string) (*model.ModelChannel, error)                             { return admin.SystemChannel(s.repo, s.decryptSettingSecret, id) }
func (s *Service) adminSystemChannel(id string) (*model.ModelChannel, error)                        { return admin.AdminSystemChannel(s.repo, s.decryptSettingSecret, id) }
func (s *Service) AdminSystemChannelPage(actor *model.User, q AdminListQuery) (*AdminChannelPage, error) { return admin.AdminSystemChannelPage(s.repo, actor, q) }
func (s *Service) CreateSystemChannel(actor *model.User, req ChannelRequest) (*PublicModelChannel, error) { return admin.CreateSystemChannel(s.adminHost(), actor, req) }
func (s *Service) DuplicateSystemChannel(actor *model.User, id string) (*PublicModelChannel, error) { return admin.DuplicateSystemChannel(s.adminHost(), actor, id) }
func (s *Service) UpdateSystemChannel(actor *model.User, id string, req ChannelRequest) (*PublicModelChannel, error) { return admin.UpdateSystemChannel(s.adminHost(), actor, id, req) }
func (s *Service) encryptSystemChannelSecrets(channel *model.ModelChannel) error                    { return admin.EncryptSystemChannelSecrets(s.encryptSettingSecret, channel) }
func (s *Service) decryptSystemChannelSecrets(channel *model.ModelChannel) error                    { return admin.DecryptSystemChannelSecrets(s.decryptSettingSecret, channel) }
func (s *Service) DeleteSystemChannel(actor *model.User, id string) error                           { return admin.DeleteSystemChannel(s.repo, s.invalidateRouteCatalog, actor, id) }
func (s *Service) LogAPICall(log model.ApiCallLog) error                                            { return admin.LogAPICall(s.repo, &s.storageMu, s.RuntimePolicy, defaultVideoPollInterval, log) }
func (s *Service) APICallLogs(actor *model.User, limit int) ([]model.ApiCallLog, error)             { return admin.APICallLogs(s.repo, actor, limit) }
func uniqueNonEmpty(values []string) []string                                                       { return kernel.UniqueNonEmpty(values) }
