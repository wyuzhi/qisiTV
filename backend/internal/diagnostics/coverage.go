package diagnostics

import (
	"errors"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
)

func (c *collection) setCoverage(name string, records, limit int, err error) {
	coverage := CollectorCoverage{Status: "complete", Records: records, Limit: limit, From: &c.Window.From, To: &c.Window.To, Scope: "window"}
	if err != nil {
		c.recordAuthError(err)
		coverage.Status, coverage.Reason, coverage.Records = "failed", "collection_failed", 0
	} else if limit > 0 && records > limit {
		coverage.Status, coverage.OmittedAtLeast, coverage.Records = "truncated", int64(records-limit), limit
		coverage.Reason, c.Truncated = "record_limit", true
	}
	c.Collectors[name] = coverage
}

func (c *collection) recordAuthError(err error) {
	var denied *kernel.AppError
	if errors.As(err, &denied) && (denied.Status == 401 || denied.Status == 403) {
		c.collectionErr = err
	}
}

func (c *collection) unavailable(name, reason string) {
	c.Collectors[name] = CollectorCoverage{Status: "unavailable", Scope: "window", Reason: reason, From: &c.Window.From, To: &c.Window.To}
}

func (c *collection) collectClientCoverage(input *ClientCoverage, supplied int) {
	c.setCoverage("clientEvents", len(c.ClientEvents), maxClientEvents, nil)
	coverage := c.Collectors["clientEvents"]
	coverage.Status, coverage.Reason = "partial", "client_coverage_unknown"
	if input != nil {
		coverage.Scope = "client_retained_history"
		copy := *input
		copy.LaunchID = sanitizeIdentifier(input.LaunchID)
		switch input.Status {
		case "available", "unavailable", "partial":
		default:
			copy.Status = "partial"
		}
		copy.SessionCount, copy.RetainedCount = max(input.SessionCount, 0), max(input.RetainedCount, 0)
		copy.ExportedCount = len(c.ClientEvents)
		copy.DroppedCount, copy.ExpiredCount = max(input.DroppedCount, 0), max(input.ExpiredCount, 0)
		copy.WriteErrorCount, copy.ReadErrorCount = max(input.WriteErrorCount, 0), max(input.ReadErrorCount, 0)
		copy.MaxAgeHours, copy.MaxEvents, copy.MaxBytes = max(input.MaxAgeHours, 0), max(input.MaxEvents, 0), max(input.MaxBytes, 0)
		c.ClientCoverage = &copy
		coverage.From, coverage.To = input.OldestAt, input.NewestAt
		coverage.Status, coverage.Reason = "complete", ""
		if !input.Persisted {
			coverage.Status, coverage.Reason = "partial", "memory_only"
		}
		if input.Status == "unavailable" {
			coverage.Status, coverage.Reason = "unavailable", "client_storage_unavailable"
		}
		if input.Status != "available" && input.Status != "unavailable" {
			coverage.Status, coverage.Reason = "partial", "client_collection_partial"
		}
		if input.WriteErrorCount > 0 || input.ReadErrorCount > 0 {
			coverage.Status, coverage.Reason = "partial", "client_storage_errors"
		}
		omitted := max(input.DroppedCount, 0) + max(input.ExpiredCount, 0)
		if omitted > 0 {
			coverage.Status, coverage.Reason, coverage.OmittedAtLeast = "truncated", "client_retention", omitted
			c.Truncated = true
		}
	}
	if supplied > maxClientEvents {
		coverage.Status, coverage.Reason = "truncated", "record_limit"
		coverage.OmittedAtLeast += int64(supplied - maxClientEvents)
		c.Truncated = true
	}
	c.Collectors["clientEvents"] = coverage
}

func (c *collection) collectUpdateCoverage() {
	if c.UpdateLog == nil {
		c.unavailable("updateLog", "not_configured")
		return
	}
	c.setCoverage("updateLog", c.UpdateLog.Lines, 0, nil)
	coverage := c.Collectors["updateLog"]
	switch c.UpdateLog.Status {
	case "missing":
		coverage.Status, coverage.Reason = "unavailable", "no_update_log"
	case "unreadable":
		coverage.Status, coverage.Reason = "failed", "update_log_unreadable"
	}
	if c.UpdateLog.Truncated {
		coverage.Status, coverage.Reason, coverage.OmittedAtLeast = "truncated", "byte_limit", 1
	}
	c.Collectors["updateLog"] = coverage
}

func (c *collection) collectBootEvidence(dataDir string, window timeWindow, extra ...BootLogEntry) {
	entries, status, truncated := collectBootLog(dataDir, window)
	for _, item := range extra {
		sanitized, ok := sanitizeBootLogEntry(item)
		if !ok {
			continue
		}
		stamp, err := time.Parse(time.RFC3339Nano, sanitized.Timestamp)
		if err != nil || stamp.Before(window.From) || stamp.After(window.To) {
			continue
		}
		dup := false
		for _, existing := range entries {
			if existing.ID == sanitized.ID {
				dup = true
				break
			}
		}
		if !dup {
			entries = append(entries, sanitized)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		ti, ei := time.Parse(time.RFC3339Nano, entries[i].Timestamp)
		tj, ej := time.Parse(time.RFC3339Nano, entries[j].Timestamp)
		if ei == nil && ej == nil && !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return false
	})
	if len(entries) > maxBootLogEntries {
		entries = entries[len(entries)-maxBootLogEntries:]
		truncated = true
	}
	if len(entries) == 0 {
		switch status {
		case "not_configured":
			c.unavailable("bootLog", "not_configured")
			return
		case "missing":
			c.unavailable("bootLog", "no_boot_log")
			return
		case "unreadable":
			c.Collectors["bootLog"] = CollectorCoverage{Status: "failed", Scope: "window", Reason: "boot_log_unreadable", From: &c.Window.From, To: &c.Window.To}
			return
		}
	}
	c.BootEvents = entries
	c.setCoverage("bootLog", len(entries), 0, nil)
	if truncated {
		coverage := c.Collectors["bootLog"]
		coverage.Status, coverage.Reason, coverage.OmittedAtLeast = "truncated", "byte_limit", 1
		c.Collectors["bootLog"] = coverage
		c.Truncated = true
	}
}

func clientEventInScope(event ClientEvent, window timeWindow, taskID, canvasID string) bool {
	// Legacy clients supplied events without a timestamp. Preserve them only in
	// an unscoped bundle; they cannot prove an event occurred in the window.
	if event.Timestamp != "" {
		stamp, err := time.Parse(time.RFC3339Nano, event.Timestamp)
		if err != nil || stamp.Before(window.From) || stamp.After(window.To) {
			return false
		}
	}
	if taskID != "" {
		return event.TaskID == taskID
	}
	return canvasID == "" || event.CanvasID == canvasID || event.ProjectID == canvasID
}

func unknownBuild(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "unknown", "undefined", "null":
		return true
	}
	return false
}

func (c *collection) counts() counts {
	return counts{BootEvents: len(c.BootEvents), BackendEvents: len(c.BackendEvents), AssistantTurns: len(c.AssistantTurns), AssistantEvidence: len(c.AssistantEvidence), Resources: len(c.Resources), CanvasBindings: len(c.CanvasBindings), ClientEvents: len(c.ClientEvents), Tasks: len(c.Tasks), TaskLogs: len(c.TaskLogs), APICalls: len(c.APICalls)}
}

func sanitizeMedia(input *MediaEvidence) *MediaEvidence {
	if input == nil {
		return nil
	}
	result := &MediaEvidence{Phase: sanitizeIdentifier(input.Phase)}
	bounded := func(value *int, high int) *int {
		if value == nil {
			return nil
		}
		copy := boundedInt(*value, 0, high)
		return &copy
	}
	result.ReadyState, result.NetworkState, result.ErrorCode = bounded(input.ReadyState, 4), bounded(input.NetworkState, 3), bounded(input.ErrorCode, 4)
	result.Width, result.Height = bounded(input.Width, 65535), bounded(input.Height, 65535)
	return result
}
