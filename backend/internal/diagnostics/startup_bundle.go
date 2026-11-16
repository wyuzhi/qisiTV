package diagnostics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/environment"
	"infinite-canvas/backend/internal/kernel"
)

type StartupExportOptions struct {
	DataDir         string
	UpdateLogDir    string
	OwnsDataDir     bool
	Brand           Brand
	Config          ModelConfigProvider
	Request         ExportRequest
	ExtraBootEvents []BootLogEntry
	Now             func() time.Time
	NewID           func() string
}

// ExportStartupBundle builds a Schema v3 diagnostic ZIP without requiring an
// initialized SQLite database or authenticated workspace owner. It is used when
// desktop startup fails or before workspace bootstrap completes.
func ExportStartupBundle(ctx context.Context, opts StartupExportOptions) (*Bundle, error) {
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = func() time.Time { return time.Now().UTC() }
	}
	newID := opts.NewID
	if newID == nil {
		newID = kernel.NewID
	}
	brand := opts.Brand
	if brand == nil {
		brand = staticBrand{name: defaultBrandName, slug: defaultBrandSlug}
	}
	now := nowFn().UTC()
	window := normalizeStartupWindow(now, opts.Request.From, opts.Request.To)

	clientEvents := opts.Request.ClientEvents
	truncated := false
	if len(clientEvents) > maxClientEvents {
		clientEvents = clientEvents[len(clientEvents)-maxClientEvents:]
		truncated = true
	}

	inspectDir := ""
	if opts.OwnsDataDir {
		inspectDir = opts.DataDir
	}
	collected := &collection{
		Collectors:  map[string]CollectorCoverage{},
		Environment: environment.Inspect(ctx, inspectDir, false),
		Window:      window,
		Description: redactText(opts.Request.Description, maxDescription),
		Truncated:   truncated,
		Runtime: runtimeRecord{
			AppVersion:   redactText(opts.Request.Runtime.AppVersion, 120),
			BuildCommit:  redactText(opts.Request.Runtime.BuildCommit, 120),
			Browser:      redactText(opts.Request.Runtime.Browser, 240),
			OS:           redactText(opts.Request.Runtime.OS, 120),
			Timezone:     redactText(opts.Request.Runtime.Timezone, 80),
			Capabilities: opts.Request.Runtime.Capabilities,
		},
	}

	build := buildinfo.Current()
	if unknownBuild(collected.Runtime.AppVersion) {
		collected.Runtime.AppVersion = build.Version
	}
	if unknownBuild(collected.Runtime.BuildCommit) {
		collected.Runtime.BuildCommit = build.Commit
	}

	for _, event := range clientEvents {
		if !clientEventInScope(event, window, "", "") {
			continue
		}
		collected.ClientEvents = append(collected.ClientEvents, sanitizeClientEvent(event))
	}
	collected.collectClientCoverage(opts.Request.ClientCoverage, len(opts.Request.ClientEvents))

	for _, name := range []string{"tasks", "taskLogs", "upstreamCalls", "canvasBindings", "assistantTurns", "assistantRuntime", "backendEvents", "resources"} {
		collected.unavailable(name, "workspace_not_initialized")
	}

	if opts.Config != nil {
		body, readErr := opts.Config.ReadLocalModelConfig()
		if errors.Is(readErr, os.ErrNotExist) {
			collected.unavailable("modelConfig", "not_configured")
		} else {
			collected.setCoverage("modelConfig", 0, 0, readErr)
			if readErr == nil {
				collected.ModelConfig = buildModelConfigSummary(body)
				if collected.ModelConfig == nil {
					collected.setCoverage("modelConfig", 0, 0, errors.New("invalid config"))
				} else {
					collected.setCoverage("modelConfig", 1, 0, nil)
				}
			}
		}
	} else {
		collected.unavailable("modelConfig", "not_configured")
	}

	updateLogDir := strings.TrimSpace(opts.UpdateLogDir)
	if updateLogDir == "" {
		updateLogDir = strings.TrimSpace(opts.DataDir)
	}
	collected.UpdateLog = collectUpdateLog(updateLogDir, window)
	if collected.UpdateLog != nil && collected.UpdateLog.Truncated {
		collected.Truncated = true
	}
	collected.collectUpdateCoverage()

	collected.collectBootEvidence(opts.DataDir, window, opts.ExtraBootEvents...)
	collected.setCoverage("environment", 1, 0, nil)
	collected.Findings = analyze(collected)

	bundleID := "DIAG_" + strings.ToUpper(newID()[:8])
	manifestRecord := manifest{
		SchemaVersion:    SchemaVersion,
		BundleID:         bundleID,
		GeneratedAt:      now,
		AppVersion:       collected.Runtime.AppVersion,
		BuildCommit:      collected.Runtime.BuildCommit,
		TimeRange:        timeRange{From: window.From, To: window.To},
		Description:      collected.Description,
		RedactionVersion: RedactionVersion,
		Truncated:        collected.Truncated,
		Collectors:       collected.Collectors,
		Counts:           collected.counts(),
	}
	brandName, brandSlug := brand.NameAndSlug()
	if strings.TrimSpace(brandName) == "" {
		brandName = defaultBrandName
	}
	if strings.TrimSpace(brandSlug) == "" {
		brandSlug = defaultBrandSlug
	}
	data, err := buildBoundedZIP(brandName, bundleID, manifestRecord, collected, maxBundleBytes)
	if err != nil {
		return nil, err
	}
	fileName := fmt.Sprintf("%s-startup-diagnostics-%s-%s.zip", brandSlug, now.Format("20060102-150405"), bundleID)
	return &Bundle{BundleID: bundleID, FileName: fileName, Data: data}, nil
}

func normalizeStartupWindow(now time.Time, fromRaw, toRaw string) timeWindow {
	from, to := now.Add(-DefaultWindow), now
	if parsedFrom, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(fromRaw)); err == nil {
		from = parsedFrom.UTC()
	}
	if parsedTo, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(toRaw)); err == nil {
		to = parsedTo.UTC()
	}
	if to.After(now) {
		to = now
	}
	if !to.After(from) || to.Sub(from) > maxWindow {
		from, to = now.Add(-DefaultWindow), now
	}
	return timeWindow{From: from, To: to}
}
