package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// BeefAPIImageSettlement holds the raw settlement fields from GET /v1/images/jobs/{job_id}.
// HasBillingState distinguishes a response that explicitly returned `"billing_state": ""`
// (settlement pending) from a response that omitted `billing_state` entirely.
type BeefAPIImageSettlement struct {
	BillingState      *string
	ReconcileDeadline *string
	HasBillingState   bool
}

// ExtractBeefAPIImageJobID extracts BeefAPI's image job ID from X-Image-Job-Id header,
// Location: .../images/jobs/{job_id} header, or response/error body task_id / job_id.
func ExtractBeefAPIImageJobID(headers http.Header, body []byte) string {
	if headers != nil {
		if id := strings.TrimSpace(headers.Get("X-Image-Job-Id")); id != "" {
			return id
		}
		if loc := strings.TrimSpace(headers.Get("Location")); loc != "" {
			if idx := strings.Index(loc, "/images/jobs/"); idx >= 0 {
				rest := strings.TrimPrefix(loc[idx:], "/images/jobs/")
				if slash := strings.IndexByte(rest, '/'); slash >= 0 {
					rest = rest[:slash]
				}
				if q := strings.IndexByte(rest, '?'); q >= 0 {
					rest = rest[:q]
				}
				if id := strings.TrimSpace(rest); id != "" {
					return id
				}
			}
		}
	}
	if len(body) == 0 {
		return ""
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	dataMap, _ := payload["data"].(map[string]interface{})
	errMap, _ := payload["error"].(map[string]interface{})
	for _, m := range []map[string]interface{}{
		payload,
		dataMap,
		errMap,
	} {
		if m == nil {
			continue
		}
		for _, key := range []string{"task_id", "job_id"} {
			if val, ok := m[key].(string); ok {
				if trimmed := strings.TrimSpace(val); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

// ExtractBeefAPIImageSettlement inspects the raw map from GET /v1/images/jobs/{job_id}.
// Only when the "billing_state" key is present in the JSON map (or nested data map)
// does it set HasBillingState = true and BillingState to the string value (including "").
func ExtractBeefAPIImageSettlement(state map[string]interface{}) BeefAPIImageSettlement {
	var out BeefAPIImageSettlement
	curr := state
	for curr != nil {
		if !out.HasBillingState {
			if raw, exists := curr["billing_state"]; exists {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.BillingState = &trimmed
					out.HasBillingState = true
				}
			}
		}
		if out.ReconcileDeadline == nil {
			if raw, exists := curr["reconcile_deadline"]; exists && raw != nil {
				if v, ok := raw.(string); ok {
					trimmed := strings.TrimSpace(v)
					out.ReconcileDeadline = &trimmed
				}
			}
		}
		nested, ok := curr["data"].(map[string]interface{})
		if !ok {
			break
		}
		curr = nested
	}
	return out
}

// QueryBeefAPIImageJob queries GET /v1/images/jobs/{job_id} and returns the raw
// settlement fields even if the job payload carries an error envelope.
func QueryBeefAPIImageJob(ctx context.Context, config Config, jobID string) (BeefAPIImageSettlement, map[string]interface{}, error) {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return BeefAPIImageSettlement{}, nil, fmt.Errorf("图片任务缺少上游 job_id")
	}
	state, err := managedMediaClient(WithRequestKind(ctx, "poll"), config).LegacyImageJob(ctx, jobID)
	settlement := ExtractBeefAPIImageSettlement(state)
	if err != nil {
		if len(state) > 0 && (settlement.HasBillingState || settlement.ReconcileDeadline != nil) {
			return settlement, state, nil
		}
		return settlement, state, err
	}
	return settlement, state, nil
}
