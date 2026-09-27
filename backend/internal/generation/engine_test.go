package generation_test

import (
	"testing"

	"qisitv/backend/internal/generation"
)

func TestGenerationPackageHasEngineAndOfficialRegistry(t *testing.T) {
	engine := generation.NewEngine(generation.Deps{})
	if engine == nil {
		t.Fatal("NewEngine returned nil")
	}
	if name, ok := generation.OfficialDeclarativeImageInterface("openai-image"); !ok || name == "" {
		t.Fatalf("openai-image whitelist = %q %v", name, ok)
	}
	registry := generation.LoadOfficialFallbackRegistry()
	if registry == nil {
		t.Fatal("LoadOfficialFallbackRegistry returned nil")
	}
	if _, ok := registry.Resolve("xai-video"); !ok {
		t.Fatal("official generation registry lost xai-video when non-generation packages are present")
	}
}
