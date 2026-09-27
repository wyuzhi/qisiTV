package app

import (
	"context"
	"strings"
	"testing"

	"qisitv/backend/internal/model"
)

func TestRunningHubWorkflowRejectsMediaUploadInLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	input := canvasGenerationInput{
		Mode: "video",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceRunningHubVideo),
			BaseURL:       "https://example.com",
		},
		ReferenceImages: []providerMedia{{ID: "ref-1", DataURL: "data:image/png;base64,AAAA"}},
	}
	_, err := svc.runRunningHubWorkflow(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub media upload error = %v, want local-workspace rejection", err)
	}
}

func TestUploadRunningHubMediaRejectsLocalMode(t *testing.T) {
	svc := &Service{mode: serviceModeLocal}
	_, err := svc.uploadRunningHubMedia(context.Background(), "https://example.com", providerConfig{}, providerMedia{
		ID:      "ref-1",
		DataURL: "data:image/png;base64,AAAA",
	})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("local RunningHub upload error = %v, want local-workspace rejection", err)
	}
}
