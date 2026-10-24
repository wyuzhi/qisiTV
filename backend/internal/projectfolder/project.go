package projectfolder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"
	"qisitv/backend/internal/model"
)

func (s *Service) flush(ctx context.Context, userID, canvasID string) (status Status, returnErr error) {
	var b binding
	if err := s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", canvasID, userID).First(&b).Error; err != nil {
		return status, err
	}
	if b.WorkspaceID != s.options.WorkspaceID {
		return status, ErrUnbound
	}
	defer func() {
		if returnErr != nil {
			state := "error"
			if errors.Is(returnErr, ErrConflict) {
				state = "conflict"
			}
			_ = s.db.Model(&binding{}).Where("canvas_id=? AND user_id=?", canvasID, userID).Updates(map[string]any{"state": state, "last_error": returnErr.Error()}).Error
			var failed binding
			if s.db.Where("canvas_id=? AND user_id=?", canvasID, userID).First(&failed).Error == nil {
				status, _ = s.status(context.Background(), failed)
			}
		}
	}()
	if b.State == "conflict" {
		return status, ErrConflict
	}
	directory, err := openProject(s.options.RootDirectory, b.Directory)
	if err != nil {
		return status, err
	}
	defer directory.Close()
	current, err := readBounded(directory, ManifestName, MaxManifestBytes)
	if errors.Is(err, os.ErrNotExist) && b.ManifestSHA256 == "" {
		current = nil
	} else if err != nil {
		return status, err
	}
	currentDigest := ""
	if current != nil {
		currentDigest = digestBytes(current)
	}
	// A durable witness bridges rename and SQLite acknowledgement. If the
	// process died after rename, acknowledge that exact file before advancing.
	if b.PendingManifestSHA256 != "" && currentDigest == b.PendingManifestSHA256 {
		if err = s.acknowledge(ctx, &b); err != nil {
			return status, err
		}
	}
	if currentDigest != b.ManifestSHA256 {
		return status, ErrConflict
	}
	var job projection
	if err = s.db.WithContext(ctx).Where("canvas_id=? AND user_id=?", canvasID, userID).First(&job).Error; err != nil {
		return status, err
	}
	if job.Generation <= b.ExportedGeneration {
		return s.status(ctx, b)
	}
	var manifest Manifest
	if job.Deleted {
		if len(current) == 0 {
			return status, fmt.Errorf("deleted project has no recoverable manifest")
		}
		manifest, err = parseManifest(current)
		if err != nil {
			return status, err
		}
		manifest.DeletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	} else {
		manifest, err = s.buildManifest(ctx, b, job, directory)
		if err != nil {
			return status, err
		}
	}
	manifest.Format = "qisitv-project"
	manifest.FormatVersion = 2
	manifest.Revision = job.Revision
	manifest.EngineAuthority = &Authority{Kind: "local-engine", WorkspaceID: b.WorkspaceID, CanvasID: b.CanvasID, Generation: job.Generation}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return status, err
	}
	if len(raw) > MaxManifestBytes {
		return status, fmt.Errorf("project projection exceeds manifest limit")
	}
	if len(current) > 0 {
		if err = atomicWrite(directory, path.Join(".qisitv", fmt.Sprintf("engine-revision-%d-g%d.json", b.ExportedRevision, b.ExportedGeneration)), current); err != nil {
			return status, err
		}
	}
	// Persist the expected file digest before touching the authoritative-looking
	// manifest. Other files are immutable content-addressed projections.
	b.PendingManifestSHA256 = digestBytes(raw)
	b.PendingGeneration = job.Generation
	b.PendingRevision = job.Revision
	if err = s.db.WithContext(ctx).Model(&binding{}).Where("canvas_id=? AND user_id=?", canvasID, userID).Updates(map[string]any{"pending_manifest_sha256": b.PendingManifestSHA256, "pending_generation": job.Generation, "pending_revision": job.Revision, "state": "pending", "last_error": ""}).Error; err != nil {
		return status, err
	}
	latest, readErr := readBounded(directory, ManifestName, MaxManifestBytes)
	if b.ManifestSHA256 == "" && errors.Is(readErr, os.ErrNotExist) {
		latest = nil
	} else if readErr != nil {
		return status, readErr
	}
	latestDigest := ""
	if latest != nil {
		latestDigest = digestBytes(latest)
	}
	if latestDigest != b.ManifestSHA256 {
		return status, ErrConflict
	}
	if err = atomicWrite(directory, ManifestName, raw); err != nil {
		return status, err
	}
	if err = s.acknowledge(ctx, &b); err != nil {
		return status, err
	}
	return s.status(ctx, b)
}

func (s *Service) acknowledge(ctx context.Context, b *binding) error {
	updates := map[string]any{"manifest_sha256": b.PendingManifestSHA256, "exported_revision": b.PendingRevision, "exported_generation": b.PendingGeneration, "pending_manifest_sha256": "", "pending_revision": 0, "pending_generation": 0, "state": "ready", "last_error": ""}
	if err := s.db.WithContext(ctx).Model(&binding{}).Where("canvas_id=? AND user_id=?", b.CanvasID, b.UserID).Updates(updates).Error; err != nil {
		return err
	}
	b.ManifestSHA256 = b.PendingManifestSHA256
	b.ExportedRevision = b.PendingRevision
	b.ExportedGeneration = b.PendingGeneration
	b.PendingManifestSHA256 = ""
	b.PendingRevision = 0
	b.PendingGeneration = 0
	b.State = "ready"
	b.LastError = ""
	return nil
}

func (s *Service) buildManifest(ctx context.Context, b binding, job projection, directory *os.Root) (Manifest, error) {
	var row model.CanvasProject
	var drawings []model.CanvasDrawing
	var legacy []receipt
	var tasks []model.Task
	// A single snapshot contains the canvas, drawings and receipt identities.
	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id=? AND user_id=?", b.CanvasID, b.UserID).First(&row).Error; err != nil {
			return err
		}
		if row.Revision != job.Revision {
			return fmt.Errorf("project changed before projection; retry pending revision")
		}
		if tx.Migrator().HasTable("canvas_drawings") {
			if err := tx.Where("canvas_id=? AND user_id=? AND deleted_at IS NULL", b.CanvasID, b.UserID).Find(&drawings).Error; err != nil {
				return err
			}
		}
		if tx.Migrator().HasTable("tasks") {
			if err := tx.Where("project_id=? AND user_id=?", b.CanvasID, b.UserID).Find(&tasks).Error; err != nil {
				return err
			}
		}
		return tx.Where("canvas_id=? AND user_id=?", b.CanvasID, b.UserID).Find(&legacy).Error
	}); err != nil {
		return Manifest{}, err
	}
	var document map[string]any
	if json.Unmarshal([]byte(row.PayloadJSON), &document) != nil || document == nil {
		return Manifest{}, fmt.Errorf("canonical canvas JSON invalid")
	}
	document["id"] = row.ID
	document["title"] = row.Title
	document["revision"] = row.Revision
	document["createdAt"] = row.CreatedAt
	document["updatedAt"] = row.UpdatedAt
	document["projectId"] = row.ProjectID
	document["folderId"] = row.LibraryFolderID
	document = normalizeResourceURLs(document).(map[string]any)
	if err := normalizeDurableMedia(document, false, "project"); err != nil {
		return Manifest{}, err
	}
	resourceIDs := map[string]bool{}
	collectResourceIDs(document, resourceIDs)
	drawingPayload := map[string]json.RawMessage{}
	for _, drawing := range drawings {
		var snapshot any
		if json.Unmarshal([]byte(drawing.SnapshotJSON), &snapshot) != nil {
			return Manifest{}, fmt.Errorf("canonical drawing JSON invalid")
		}
		value := map[string]any{"document": map[string]any{"version": 2, "engine": drawing.Engine, "snapshot": snapshot, "revision": drawing.Revision, "updatedAt": drawing.UpdatedAt, "shapeCount": drawing.ShapeCount, "pageCount": drawing.PageCount}}
		if drawing.PreviewResourceID != "" {
			resourceIDs[drawing.PreviewResourceID] = true
			value["previewKey"] = "resource:" + drawing.PreviewResourceID
		}
		if drawing.RenderResourceID != "" {
			resourceIDs[drawing.RenderResourceID] = true
			value["render"] = map[string]any{"blobKey": "resource:" + drawing.RenderResourceID, "pageId": drawing.RenderPageID, "width": drawing.RenderWidth, "height": drawing.RenderHeight, "mimeType": drawing.RenderMimeType, "background": drawing.RenderBackground, "revision": drawing.Revision, "version": 1}
		}
		drawingPayload[drawing.DrawingID], _ = json.Marshal(value)
	}
	media := map[string]MediaEntry{}
	replacements := map[string]string{}
	resourceRoot, err := os.OpenRoot(filepath.Join(s.options.DataDir, "resources"))
	if err != nil {
		return Manifest{}, err
	}
	defer resourceRoot.Close()
	for id := range resourceIDs {
		if err = ctx.Err(); err != nil {
			return Manifest{}, err
		}
		var resource model.Resource
		if err = s.db.WithContext(ctx).Where("id=? AND user_id=? AND status=?", id, b.UserID, model.ResourceStatusReady).First(&resource).Error; err != nil {
			return Manifest{}, fmt.Errorf("project media not ready: %s: %w", id, err)
		}
		if resource.Provider != "local" {
			return Manifest{}, fmt.Errorf("project media is not stored locally: %s", id)
		}
		if err = validateRelative(resource.ObjectKey); err != nil {
			return Manifest{}, err
		}
		input, openErr := resourceRoot.Open(resource.ObjectKey)
		if openErr != nil {
			return Manifest{}, openErr
		}
		digest, size, hashErr := hashRegularFile(input)
		if hashErr != nil {
			_ = input.Close()
			return Manifest{}, hashErr
		}
		if size != resource.Size {
			_ = input.Close()
			return Manifest{}, fmt.Errorf("canonical media size mismatch")
		}
		if expected := strings.Trim(resource.ETag, "\""); digestPattern.MatchString(expected) && expected != digest {
			_ = input.Close()
			return Manifest{}, fmt.Errorf("canonical media SHA256 mismatch: %s", id)
		}
		folder := "references"
		switch resource.Kind {
		case "image":
			folder = "images"
		case "video":
			folder = "videos"
		case "audio":
			folder = "audio"
		}
		target := path.Join(folder, digest+extension(resource.MimeType))
		if verifyErr := verifyFile(directory, target, size, digest); verifyErr != nil {
			if !errors.Is(verifyErr, os.ErrNotExist) {
				_ = input.Close()
				return Manifest{}, verifyErr
			}
			if _, err = input.Seek(0, 0); err == nil {
				err = atomicCopy(directory, target, input, size, digest)
			}
			if err != nil {
				_ = input.Close()
				return Manifest{}, err
			}
		}
		_ = input.Close()
		media["resource:"+id] = MediaEntry{Path: target, MimeType: resource.MimeType, Bytes: size, SHA256: digest, Kind: resource.Kind}
		replacements["/api/resources/"+id+"/file"] = target
	}
	project := remap(clean(document), replacements).(map[string]any)
	allReceipts := make([]json.RawMessage, 0, len(tasks)+len(legacy))
	for _, old := range legacy {
		allReceipts = append(allReceipts, json.RawMessage(old.PayloadJSON))
	}
	for _, task := range tasks {
		// Task input may contain encrypted/internal settings in DB. Export only
		// receipts, never an executable recipe or credentials.
		value := map[string]any{"task": map[string]any{"id": task.ID, "projectId": task.ProjectID, "providerRequestId": task.ProviderRequestID, "clientOperationId": task.ClientOperationID, "type": task.Type, "status": task.Status, "stage": task.Stage, "model": task.Model, "provider": task.Provider, "prompt": task.Prompt, "createdAt": task.CreatedAt, "updatedAt": task.UpdatedAt}}
		raw, _ := json.Marshal(value)
		allReceipts = append(allReceipts, raw)
	}
	receiptsPath := path.Join(".qisitv", fmt.Sprintf("task-receipts-g%d.json", job.Generation))
	receiptBytes, err := json.MarshalIndent(allReceipts, "", "  ")
	if err != nil {
		return Manifest{}, err
	}
	if len(receiptBytes) > MaxReceiptBytes {
		return Manifest{}, fmt.Errorf("project receipt export exceeds limit")
	}
	if err = atomicWrite(directory, receiptsPath, receiptBytes); err != nil {
		return Manifest{}, err
	}
	return Manifest{Project: project, Media: media, Drawings: drawingPayload, ReceiptsPath: receiptsPath}, nil
}
func collectResourceIDs(value any, ids map[string]bool) {
	switch v := value.(type) {
	case string:
		if strings.HasPrefix(v, "resource:") {
			id := strings.TrimPrefix(v, "resource:")
			if safeID.MatchString(id) {
				ids[id] = true
			}
		}
		if strings.HasPrefix(v, "/api/resources/") && strings.HasSuffix(v, "/file") {
			id := strings.TrimSuffix(strings.TrimPrefix(v, "/api/resources/"), "/file")
			if safeID.MatchString(id) {
				ids[id] = true
			}
		}
	case map[string]any:
		for key, child := range v {
			if key == "resourceId" {
				if id, ok := child.(string); ok && safeID.MatchString(id) {
					ids[id] = true
				}
			}
			collectResourceIDs(child, ids)
		}
	case []any:
		for _, child := range v {
			collectResourceIDs(child, ids)
		}
	}
}

// The canonical identity is a Resource ID. Ephemeral engine ports and media
// tickets must never survive into a portable project manifest.
func normalizeResourceURLs(value any) any {
	switch v := value.(type) {
	case string:
		parsed, err := url.Parse(v)
		if err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "") {
			resourcePath := strings.TrimPrefix(parsed.Path, "/engine")
			if !strings.HasPrefix(resourcePath, "/api/resources/") || (!strings.HasSuffix(resourcePath, "/file") && !strings.HasSuffix(resourcePath, "/playback")) {
				return v
			}
			id := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(resourcePath, "/api/resources/"), "/file"), "/playback")
			if safeID.MatchString(id) {
				return "/api/resources/" + id + "/file"
			}
		}
		return v
	case map[string]any:
		for key, item := range v {
			v[key] = normalizeResourceURLs(item)
		}
		return v
	case []any:
		for i, item := range v {
			v[i] = normalizeResourceURLs(item)
		}
		return v
	default:
		return value
	}
}
func extension(mime string) string {
	if ext := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a", "audio/ogg": ".ogg"}[mime]; ext != "" {
		return ext
	}
	return ".bin"
}
