package modelcatalog

import "qisitv/backend/internal/canvas/capability"

func GenerationModeSupported(mode string) bool {
	return capability.BuiltinRegistry().SupportsGenerationMode(normalizeCapability(mode))
}
