package generation

import (
	"context"
	"errors"
	"testing"

	"qisitv/backend/internal/protocol"
)

func TestLikeAIProtocolPreservesAutoDurationAfterRequestSplit(t *testing.T) {
	for _, model := range []string{"doubao_seedance_2_5", "wan_video_3_prime"} {
		request := ProtocolRequestFromInput(Input{Mode: "video", Config: Config{Model: model, InterfaceType: "likeai-video", VideoSeconds: "-1"}})
		if request.Duration != -1 || request.Output.Duration != -1 {
			t.Fatalf("%s lost Auto duration: %+v", model, request)
		}
	}
}

func TestLikeAIRejectedEndpointIsNotAnUncertainPaidSubmission(t *testing.T) {
	capture := &likeAICapturePort{}
	ctx := WithRuntime(context.Background(), Runtime{Images: capture})
	_, err := ExecuteProtocolRequest(ctx, Config{InterfaceType: "likeai-image", BaseURL: "https://example.com/task-api", APIKey: "synthetic-preflight"}, protocol.RequestSpec{Method: "POST", Path: "/task/create_task", Body: map[string]any{"prompt": "scene"}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) || capture.request != nil {
		t.Fatalf("invalid fixed service was sent or not classified as preflight: %v", err)
	}
	var unknown SubmissionUnknownError
	if errors.As(UncertainVideoSubmission(ctx, err), &unknown) {
		t.Fatal("unsent fixed-service request was marked as an uncertain paid task")
	}
}
