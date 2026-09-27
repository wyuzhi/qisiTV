package task

import (
	"time"

	"qisitv/backend/internal/model"
)

// CreateRequest is the transport-neutral command accepted by the local task
// application boundary. Provider-specific input remains opaque so protocol
// adapters can evolve without coupling HTTP or desktop composition to them.
type CreateRequest struct {
	ProjectID      string         `json:"projectId"`
	Type           string         `json:"type"`
	Operation      string         `json:"operation"`
	Prompt         string         `json:"prompt"`
	Provider       string         `json:"provider"`
	Model          string         `json:"model"`
	LogicalModelID string         `json:"logicalModelId"`
	Input          map[string]any `json:"input"`
	TraceID        string         `json:"-"`
	RequestID      string         `json:"-"`
}

type ListOptions struct {
	Limit      int
	ProjectID  string
	ActiveOnly bool
}

// Summary is the stable local read model. It deliberately excludes protected
// provider input and credentials while retaining recovery and preview fields.
type Summary struct {
	ID                        string                     `json:"id"`
	ProjectID                 string                     `json:"projectId,omitempty"`
	Type                      string                     `json:"type"`
	Status                    model.TaskStatus           `json:"status"`
	Stage                     string                     `json:"stage"`
	Progress                  int                        `json:"progress"`
	Prompt                    string                     `json:"prompt"`
	Operation                 string                     `json:"operation,omitempty"`
	Provider                  string                     `json:"provider,omitempty"`
	Model                     string                     `json:"model,omitempty"`
	ProviderRequestID         string                     `json:"providerRequestId,omitempty"`
	ProviderCancelStatus      model.ProviderCancelStatus `json:"providerCancelStatus,omitempty"`
	ProviderCancelError       string                     `json:"providerCancelError,omitempty"`
	ProviderCancelAttempts    int                        `json:"providerCancelAttempts,omitempty"`
	ProviderCancelRequestedAt *time.Time                 `json:"providerCancelRequestedAt,omitempty"`
	ProviderCancelledAt       *time.Time                 `json:"providerCancelledAt,omitempty"`
	Error                     string                     `json:"error,omitempty"`
	ErrorCode                 string                     `json:"errorCode,omitempty"`
	PreviewURL                string                     `json:"previewUrl,omitempty"`
	PreviewKind               string                     `json:"previewKind,omitempty"`
	PreviewPosterURL          string                     `json:"previewPosterUrl,omitempty"`
	Attempts                  int                        `json:"attempts"`
	StartedAt                 *time.Time                 `json:"startedAt"`
	CompletedAt               *time.Time                 `json:"completedAt"`
	CreatedAt                 time.Time                  `json:"createdAt"`
	UpdatedAt                 time.Time                  `json:"updatedAt"`
	ClientContext             *ClientContext             `json:"clientContext,omitempty"`
}

type ClientContext struct {
	ExternalAgent    bool   `json:"externalAgent,omitempty"`
	NodeID           string `json:"nodeId,omitempty"`
	ConversationID   string `json:"conversationId,omitempty"`
	MessageID        string `json:"messageId,omitempty"`
	BatchIndex       int    `json:"batchIndex,omitempty"`
	BatchCount       int    `json:"batchCount,omitempty"`
	DomainProjectID  string `json:"domainProjectId,omitempty"`
	ChapterID        string `json:"chapterId,omitempty"`
	ChapterOperation string `json:"chapterOperation,omitempty"`
	ShotID           string `json:"shotId,omitempty"`
	WorkflowStepID   string `json:"workflowStepId,omitempty"`
	ArtifactType     string `json:"artifactType,omitempty"`
}
