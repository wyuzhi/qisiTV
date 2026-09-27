package app

import (
	"context"
	"strings"
	"testing"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/protocol"
)

func TestNativeArkLimitMeasuresSerializedBodyOnly(t *testing.T) {
	const limit = 64 * 1024 * 1024
	for _, iface := range []string{"volcengine-ark-video", "volcengine-ark-agent-plan-video", "newapi-channel-2"} {
		for _, size := range []int{limit - 2, limit - 1} {
			_, _, err := protocolRequestBody(context.Background(), providerConfig{InterfaceType: iface}, protocol.RequestSpec{ContentType: "application/json", Body: strings.Repeat("x", size)})
			wantReject := iface != "newapi-channel-2" && size+2 > limit
			if wantReject {
				if err == nil || generation.ClassifyError(err).Category != generation.CategoryInputTooLarge {
					t.Fatalf("%s expected actionable request limit: %v", iface, err)
				}
			} else if err != nil {
				t.Fatalf("%s unexpected local request cap: %v", iface, err)
			}
		}
	}
}

func TestNativeArkUnconfiguredReferencesStillPreflight(t *testing.T) {
	for _, protocol := range []string{"volcengine-ark-video", "volcengine-ark-agent-plan-video"} {
		input := canvasGenerationInput{Prompt: "test", Config: providerConfig{InterfaceType: protocol, Model: "doubao-seedance-2-5-260528", VideoSeconds: "5"}, ReferenceImages: []providerMedia{{Width: 384, Height: 216}}}
		if err := (&Service{}).validateResolvedVideoCapability(&input); err == nil || !strings.Contains(err.Error(), "高度为 216") {
			t.Fatalf("native preflight skipped: %v", err)
		}
	}
}

func TestReferenceDurationIndependentBounds(t *testing.T) {
	for _, tc := range []struct {
		duration int64
		min, max float64
		want     string
	}{
		{16000, 0, 15, "不超过 15"}, {1000, 2, 0, "至少 2"}, {0, 0, 0, ""}, {15000, 0, 15, ""}, {2000, 2, 0, ""},
	} {
		err := validateReferenceDuration("音频", 0, tc.duration, tc.min, tc.max)
		if tc.want == "" {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("bounds %+v: %v", tc, err)
		}
	}
}
