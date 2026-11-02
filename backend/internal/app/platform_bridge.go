package app

import (
	"context"
	"net/http"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/platform"
	"qisitv/backend/internal/repository"
)

type (
	RuntimeResourcePolicy      = platform.RuntimeResourcePolicy
	RuntimeTaskPolicy          = platform.RuntimeTaskPolicy
	RuntimeRequestPolicy       = platform.RuntimeRequestPolicy
	RuntimePolicySetting       = platform.RuntimePolicySetting
	PublicRuntimePolicySetting = platform.PublicRuntimePolicySetting
	PublicRuntimeLimits        = platform.PublicRuntimeLimits
	FeatureAvailability        = platform.FeatureAvailability
	PublicFeatureAvailability  = platform.PublicFeatureAvailability
)

const (
	FeatureShortDrama             = platform.FeatureShortDrama
	FeatureTaskCenter             = platform.FeatureTaskCenter
	FeatureCustomChannels         = platform.FeatureCustomChannels
	FeatureFrontendModels         = platform.FeatureFrontendModels
	FeaturePluginCenter           = platform.FeaturePluginCenter
	FeatureSystemPlugins          = platform.FeatureSystemPlugins
	FeatureTimelineTranscription  = platform.FeatureTimelineTranscription
	featureAvailabilitySettingKey = "feature_availability"
	runtimePolicySettingKey       = "runtime_policy"
	maxChannelConcurrencyLimit    = platform.MaxChannelConcurrencyLimit
	runtimeCoordinationTimeout    = platform.CoordinationTimeout
)

func newPlatformHost(s *Service) platform.Host {
	if s == nil {
		return platform.NewHost(platform.HostConfig{})
	}
	return platform.NewHost(platform.HostConfig{Repo: s.repo, RequireAdmin: s.RequireAdmin, AppendAudit: s.appendAdminAudit})
}
func (s *Service) platformDomain() *platform.Service {
	if s == nil {
		return platform.New(nil, nil, nil)
	}
	s.platformOnce.Do(func() {
		if s.platform == nil {
			s.platform = platform.NewForMode(s.repo, s.coordinator, newPlatformHost(s), s.IsLocalMode())
		}
	})
	return s.platform
}
func (s *Service) RuntimePolicy() (RuntimePolicySetting, error)                                                   { return s.platformDomain().RuntimePolicy() }
func (s *Service) runtimePolicyWithRepo(repo *repository.Repository) (RuntimePolicySetting, error)                { return platform.RuntimePolicyWithRepo(repo, s.IsLocalMode()) }
func (s *Service) runtimeConcurrencySetting() (RuntimeTaskPolicy, error)                                          { return s.platformDomain().RuntimeConcurrencySetting() }
func (s *Service) PublicRuntimeLimits() (*PublicRuntimeLimits, error)                                             { return s.platformDomain().PublicRuntimeLimits() }
func (s *Service) AdminRuntimePolicySetting(actor *model.User) (*PublicRuntimePolicySetting, error)               { return s.platformDomain().AdminRuntimePolicySetting(actor) }
func (s *Service) AdminSelfUseRuntimePolicy(actor *model.User) (*PublicRuntimePolicySetting, error)               { return s.platformDomain().AdminSelfUseRuntimePolicy(actor) }
func (s *Service) UpdateRuntimePolicySetting(actor *model.User, v RuntimePolicySetting) (*PublicRuntimePolicySetting, error) { return s.platformDomain().UpdateRuntimePolicySetting(actor, v) }
func (s *Service) ResetRuntimePolicySetting(actor *model.User) (*PublicRuntimePolicySetting, error)               { return s.platformDomain().ResetRuntimePolicySetting(actor) }
func (s *Service) FeatureAvailability() (*PublicFeatureAvailability, error)                                       { return s.platformDomain().FeatureAvailability() }
func (s *Service) AdminFeatureAvailability(actor *model.User) (*PublicFeatureAvailability, error)                 { return s.platformDomain().AdminFeatureAvailability(actor) }
func (s *Service) UpdateFeatureAvailability(actor *model.User, v FeatureAvailability) (*PublicFeatureAvailability, error) { return s.platformDomain().UpdateFeatureAvailability(actor, v) }
func (s *Service) FeatureEnabled(feature string) (bool, error)                                                    { return s.platformDomain().FeatureEnabled(feature) }
func (s *Service) RequireFeature(feature string) error                                                            { return s.platformDomain().RequireFeature(feature) }
func (s *Service) AcquireChannelSlot(ctx context.Context, cid, scope string, ttl time.Duration) (func(), int, error) { return s.platformDomain().AcquireChannelSlot(ctx, cid, scope, ttl) }
func (s *Service) AllowRequest(ctx context.Context, key string, limit int, win time.Duration) (bool, error)       { return s.platformDomain().AllowRequest(ctx, key, limit, win) }
func (s *Service) RequestRetryAfter(ctx context.Context, key string, win time.Duration) time.Duration             { return s.platformDomain().RequestRetryAfter(ctx, key, win) }
func (s *Service) AcquireCustomRelaySlot(ctx context.Context, u string, limit int, ttl time.Duration) (func(), bool, error) { return s.platformDomain().AcquireCustomRelaySlot(ctx, u, limit, ttl) }
func (s *Service) RecordChannelResult(ctx context.Context, cid string, failed bool) error                         { return s.platformDomain().RecordChannelResult(ctx, cid, failed) }
func (s *Service) Close() error                                                                                   { s.stopGenerationDownloads(); s.closeSupportTrace(); return nil }
func (s *Service) ValidateRuntime() error                                                                         { if s == nil { return nil }; if s.pluginRuntimeErr != nil { return s.pluginRuntimeErr }; return s.runtimeErr }
func ChannelSlotFailureDetails(err error) (string, string)                                                        { return platform.ChannelSlotFailureDetails(err) }
func SanitizeAPICallPayload(data []byte, contentType string) string                                               { return platform.SanitizeAPICallPayload(data, contentType) }
func optionalJSONString(p map[string]any, key string) (string, error)                                             { return platform.OptionalJSONString(p, key) }
func firstJSONString(p map[string]any, keys ...string) (string, error)                                            { return platform.FirstJSONString(p, keys...) }
func megabytes(value int64) int64                                                                                 { return kernel.Megabytes(value) }
func gigabytes(value int64) int64                                                                                 { return kernel.Gigabytes(value) }
func requestPayloadForLog(req *http.Request) string                                                               { return platform.RequestPayloadForLog(req) }
func selfUseRuntimePolicy() RuntimePolicySetting                                                                  { return platform.SelfUseRuntimePolicy() }
func validateRuntimePolicy(value RuntimePolicySetting) error                                                      { return platform.ValidateRuntimePolicy(value) }
func defaultRuntimePolicy() RuntimePolicySetting                                                                  { return platform.DefaultRuntimePolicy() }
