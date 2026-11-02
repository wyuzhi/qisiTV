package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/protocol"
)

func normalizeCapability(value string) string         { return modelcatalog.NormalizeCapability(value) }
func capabilityFromTaskType(taskType string) string   { return modelcatalog.CapabilityFromTaskType(taskType) }
func DefaultModelCapabilityConfig(p string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfig(p)
}
func DefaultImageCapabilityConfig(p, m string) *ImageCapabilityConfig {
	return modelcatalog.DefaultImageCapabilityConfig(p, m)
}
func DefaultModelCapabilityConfigForModel(p, m string) *ModelCapabilityConfig {
	return modelcatalog.DefaultModelCapabilityConfigForModel(p, m)
}
func DecodeModelCapabilityConfig(raw string) (*ModelCapabilityConfig, error) {
	return modelcatalog.DecodeModelCapabilityConfig(raw)
}
func NormalizeModelCapabilityConfig(c, p string, in *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfig(c, p, in)
}
func NormalizeModelCapabilityConfigForModel(c, p, m string, in *ModelCapabilityConfig) (*ModelCapabilityConfig, error) {
	return modelcatalog.NormalizeModelCapabilityConfigForModel(c, p, m, in)
}
func CapabilitySpecFromModelCapabilityConfig(c *ModelCapabilityConfig, cap string) (CapabilitySpec, error) {
	return modelcatalog.CapabilitySpecFromModelCapabilityConfig(c, cap)
}
func applyFixedVideoResolution(input *canvasGenerationInput, profile *VideoCapabilityConfig) {
	if input != nil {
		task := taskInputFromCanvas(*input)
		modelcatalog.ApplyFixedVideoResolution(&task, profile)
		applyTaskConfigToCanvas(input, task)
	}
}
func validateVideoTask(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTask(profile, taskInputFromCanvas(input))
}
func validateVideoTaskParameters(profile *VideoCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateVideoTaskParameters(profile, taskInputFromCanvas(input))
}
func validateImageTask(profile *ImageCapabilityConfig, input canvasGenerationInput) error {
	return modelcatalog.ValidateImageTask(profile, taskInputFromCanvas(input))
}
func ModelRequestIntentFromTaskInput(input map[string]any, taskType, op string) ModelRequestIntent {
	return modelcatalog.ModelRequestIntentFromTaskInput(input, taskType, op)
}
func DecodeCapabilitySpec(raw string) (CapabilitySpec, error) {
	return modelcatalog.DecodeCapabilitySpec(raw)
}
func ValidateCapabilitySpec(spec CapabilitySpec) error {
	return modelcatalog.ValidateCapabilitySpec(spec)
}
func NormalizeCapabilitySpec(spec CapabilitySpec) (CapabilitySpec, error) {
	return modelcatalog.NormalizeCapabilitySpec(spec)
}
func MatchCapability(spec CapabilitySpec, intent ModelRequestIntent) CapabilityMatch {
	return modelcatalog.MatchCapability(spec, intent)
}
func normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(protocol.Builtins(), channel, req)
}
func (s *Service) normalizeChannelModelContract(channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return normalizeChannelModelContractWithRegistry(s.protocolRegistry(), channel, req)
}
func normalizeChannelModelContractWithRegistry(registry *protocol.Registry, channel *model.ModelChannel, req ChannelModelRequest) (string, string, string, model.ChannelInterfaceType, error) {
	return modelcatalog.NormalizeChannelModelContract(modelcatalog.LookupFromRegistry(registry), channel, req)
}
func videoTestDefaults(profile *VideoCapabilityConfig) (string, string) {
	return modelcatalog.VideoTestDefaults(profile)
}
func imageTestDefaults(profile *ImageCapabilityConfig) (string, string) {
	return modelcatalog.ImageTestDefaults(profile)
}
func normalizeAdminChannelModelDeleteIDs(values []string) ([]string, error) {
	return modelcatalog.NormalizeAdminChannelModelDeleteIDs(values)
}
func retiredChannelModelKeys(raw string) map[string]bool {
	return modelcatalog.RetiredChannelModelKeys(raw)
}
func protocolCapabilityFromMetadata(metadata protocol.Metadata) string {
	primary := ""
	if len(metadata.Categories) > 0 {
		primary = string(metadata.Categories[0])
	}
	return modelcatalog.ProtocolCapabilityFromMetadata(modelcatalog.ProtocolMeta{ID: metadata.ID, Enabled: metadata.Enabled, UnavailableReason: metadata.UnavailableReason, PrimaryCapability: primary})
}
func isRouteDispatchUncertain(err error) bool            { return modelcatalog.IsDispatchUncertain(err) }
func channelModelNames(c model.ModelChannel) []string    { return modelcatalog.ChannelModelNames(c) }
func mergeChannelRequest(req ChannelRequest, c model.ModelChannel) ChannelRequest {
	return modelcatalog.MergeChannelRequest(req, c)
}
func publicChannel(c model.ModelChannel, admin bool, models []model.ChannelModel) PublicModelChannel {
	return modelcatalog.PublicChannel(c, admin, models)
}
func validateChannelSortOrder(value int) error         { return modelcatalog.ValidateChannelSortOrder(value) }
func normalizeAdminPage(page, limit int) (int, int)    { return modelcatalog.NormalizeAdminPage(page, limit) }
func channelFromRequest(req ChannelRequest, c model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, c)
}
func (s *Service) channelFromRequest(req ChannelRequest, c model.ModelChannel) (model.ModelChannel, error) {
	return modelcatalog.ApplyChannelRequest(req, c)
}
