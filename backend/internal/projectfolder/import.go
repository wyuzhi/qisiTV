package projectfolder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
	"qisitv/backend/internal/model"
)

// Import is explicit and idempotent for one unchanged source manifest. It
// validates every byte before publishing DB identities, never overwrites an
// existing canvas, and never creates runnable generation tasks.
func (s *Service) Import(ctx context.Context, userID string, request ImportRequest) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if userID == "" || !digestPattern.MatchString(request.ExpectedManifestSHA256) || !request.ReceiptsComplete {
		return Status{}, fmt.Errorf("migration requires owner, manifest digest and complete browser task receipts")
	}
	if request.ExpectedWorkspaceID != s.options.WorkspaceID {
		return Status{}, fmt.Errorf("project root differs from the browser's selected original directory")
	}
	directory, err := openProject(s.options.RootDirectory, request.Directory)
	if err != nil {
		return Status{}, err
	}
	defer directory.Close()
	raw, err := readBounded(directory, ManifestName, MaxManifestBytes)
	if err != nil {
		return Status{}, err
	}
	manifest, err := parseManifest(raw)
	if err != nil {
		return Status{}, err
	}
	canvasID := stringValue(manifest.Project, "id")
	var existing binding
	if err = s.db.WithContext(ctx).Where("canvas_id=?", canvasID).First(&existing).Error; err == nil {
		if existing.UserID != userID || existing.Directory != request.Directory || existing.WorkspaceID != s.options.WorkspaceID || existing.SourceSHA256 != request.ExpectedManifestSHA256 {
			return Status{}, ErrConflict
		}
		return s.flush(ctx, userID, canvasID)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return Status{}, err
	}
	if digestBytes(raw) != request.ExpectedManifestSHA256 || manifest.EngineAuthority != nil || manifest.FormatVersion != 1 || manifest.DeletedAt != "" {
		return Status{}, ErrConflict
	}
	legacyReceipts, err := validateReceipts(request.Receipts, manifest.Project, userID, canvasID)
	if err != nil {
		return Status{}, err
	}
	resourceRoot, err := os.OpenRoot(filepath.Join(s.options.DataDir, "resources"))
	if err != nil {
		return Status{}, err
	}
	defer resourceRoot.Close()
	resources := map[string]model.Resource{}
	replacements := map[string]string{}
	for key, entry := range manifest.Media {
		if err = ctx.Err(); err != nil {
			return Status{}, err
		}
		if err = verifyFile(directory, entry.Path, entry.Bytes, entry.SHA256); err != nil {
			return Status{}, err
		}
		id := stableID(s.options.WorkspaceID, userID, entry.SHA256, entry.MimeType)
		objectKey := path.Join("qisitv-import", entry.SHA256+extension(entry.MimeType))
		if err = verifyFile(resourceRoot, objectKey, entry.Bytes, entry.SHA256); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return Status{}, err
			}
			input, openErr := directory.Open(entry.Path)
			if openErr != nil {
				return Status{}, openErr
			}
			err = atomicCopy(resourceRoot, objectKey, input, entry.Bytes, entry.SHA256)
			_ = input.Close()
			if err != nil {
				return Status{}, err
			}
		}
		resources[id] = model.Resource{ID: id, UserID: userID, Provider: "local", Kind: entry.Kind, Status: model.ResourceStatusReady, ObjectKey: objectKey, MimeType: entry.MimeType, Size: entry.Bytes, ETag: entry.SHA256, CreatedAt: time.Now(), UpdatedAt: time.Now()}
		replacements[key] = "resource:" + id
		replacements[entry.Path] = "/api/resources/" + id + "/file"
	}
	project := remap(clean(manifest.Project), replacements).(map[string]any)
	if err := normalizeDurableMedia(project, false, "project"); err != nil {
		return Status{}, err
	}
	assets, err := prepareAssets(project, userID, resources)
	if err != nil {
		return Status{}, err
	}
	project["revision"] = manifest.Revision
	cleaned, err := json.Marshal(project)
	if err != nil {
		return Status{}, err
	}
	drawings, err := prepareDrawings(manifest, resources, replacements, userID, canvasID)
	if err != nil {
		return Status{}, err
	}
	backup := path.Join(".qisitv", "migration-"+request.ExpectedManifestSHA256+".json")
	if err = atomicWrite(directory, backup, raw); err != nil {
		return Status{}, err
	}
	// Recheck after large-media copying. A browser save during preparation wins;
	// the migration must not silently import its earlier snapshot.
	latest, err := readBounded(directory, ManifestName, MaxManifestBytes)
	if err != nil {
		return Status{}, err
	}
	if digestBytes(latest) != request.ExpectedManifestSHA256 {
		return Status{}, ErrConflict
	}
	if err = ensureMigrationFence(directory, migrationFence{WorkspaceID: s.options.WorkspaceID, CanvasID: canvasID, SourceSHA256: request.ExpectedManifestSHA256}); err != nil {
		return Status{}, err
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.CanvasProject{}).Where("id=?", canvasID).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return ErrConflict
		}
		for _, resource := range resources {
			var old model.Resource
			err := tx.Where("id=?", resource.ID).First(&old).Error
			if err == nil {
				if old.UserID != userID || old.ObjectKey != resource.ObjectKey || old.Status != model.ResourceStatusReady || old.Size != resource.Size {
					return ErrConflict
				}
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err = tx.Create(&resource).Error; err != nil {
				return err
			}
		}
		for _, item := range assets {
			var old model.Asset
			if lookup := tx.Where("id=?", item.ID).First(&old).Error; lookup == nil {
				var oldPayload, newPayload any
				if old.UserID != userID || old.Kind != item.Kind || json.Unmarshal([]byte(old.PayloadJSON), &oldPayload) != nil || json.Unmarshal([]byte(item.PayloadJSON), &newPayload) != nil {
					return ErrConflict
				}
				oldIDs, newIDs := map[string]bool{}, map[string]bool{}
				collectResourceIDs(oldPayload, oldIDs)
				collectResourceIDs(newPayload, newIDs)
				for id := range newIDs {
					if !oldIDs[id] {
						return fmt.Errorf("asset identity has different media; migration stopped")
					}
				}
				continue
			} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
				return lookup
			}
			if err := tx.Create(&item).Error; err != nil {
				return err
			}
		}
		b := binding{CanvasID: canvasID, UserID: userID, WorkspaceID: s.options.WorkspaceID, Directory: request.Directory, SourceSHA256: request.ExpectedManifestSHA256, ManifestSHA256: request.ExpectedManifestSHA256, State: "pending"}
		if err := tx.Create(&b).Error; err != nil {
			return err
		}
		row := model.CanvasProject{ID: canvasID, UserID: userID, Title: stringValue(project, "title"), PayloadJSON: string(cleaned), Revision: manifest.Revision, CreatedAt: clientTime(project["createdAt"]), UpdatedAt: clientTime(project["updatedAt"])}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		for _, item := range drawings {
			if err := tx.Create(&item).Error; err != nil {
				return err
			}
		}
		for _, item := range legacyReceipts {
			if err := tx.Create(&item).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Status{}, err
	}
	return s.flush(ctx, userID, canvasID)
}

func clientTime(value any) time.Time {
	if text, ok := value.(string); ok {
		if result, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return result
		}
	}
	return time.Now().UTC()
}
func validateReceipts(raws []json.RawMessage, project map[string]any, userID, canvasID string) ([]receipt, error) {
	known := map[string]bool{}
	out := make([]receipt, 0, len(raws))
	total := 0
	for _, raw := range raws {
		total += len(raw)
		if total > MaxReceiptBytes {
			return nil, fmt.Errorf("browser task receipts exceed migration limit")
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return nil, fmt.Errorf("invalid browser task receipt")
		}
		task, ok := value["task"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("browser receipt has no task")
		}
		id := stringValue(task, "id")
		if !safeID.MatchString(id) || known[id] || stringValue(task, "projectId") != canvasID {
			return nil, fmt.Errorf("browser receipt identity or project mismatch")
		}
		if status := stringValue(task, "status"); status == "queued" || status == "running" {
			return nil, fmt.Errorf("browser task %s is still running; finish or stop local waiting before migration", id)
		}
		// inputJson/resultJson are JSON strings and must not bypass key redaction.
		for _, field := range []string{"inputJson", "resultJson"} {
			if encoded := stringValue(task, field); encoded != "" {
				var decoded any
				if json.Unmarshal([]byte(encoded), &decoded) != nil {
					return nil, fmt.Errorf("invalid browser task JSON")
				}
				safe, _ := json.Marshal(clean(decoded))
				task[field] = string(safe)
			}
		}
		safe, err := json.Marshal(clean(value))
		if err != nil {
			return nil, err
		}
		out = append(out, receipt{TaskID: id, CanvasID: canvasID, UserID: userID, PayloadJSON: string(safe)})
		known[id] = true
	}
	var missing string
	visit(project, func(item map[string]any) {
		id := stringValue(item, "taskId")
		if strings.HasPrefix(id, "browser-") && !known[id] {
			missing = id
		}
	})
	if missing != "" {
		return nil, fmt.Errorf("browser task receipt missing: %s; original project retained", missing)
	}
	return out, nil
}
func visit(value any, fn func(map[string]any)) {
	switch v := value.(type) {
	case map[string]any:
		fn(v)
		for _, child := range v {
			visit(child, fn)
		}
	case []any:
		for _, child := range v {
			visit(child, fn)
		}
	}
}
func prepareAssets(project map[string]any, userID string, resources map[string]model.Resource) ([]model.Asset, error) {
	items := map[string]*model.Asset{}
	refs := map[string]map[string]bool{}
	var failure error
	visit(project, func(item map[string]any) {
		key := stringValue(item, "storageKey")
		if !strings.HasPrefix(key, "resource:") {
			return
		}
		rid := strings.TrimPrefix(key, "resource:")
		resource, exists := resources[rid]
		if !exists {
			failure = fmt.Errorf("unresolved project resource %s", rid)
			return
		}
		id := stringValue(item, "assetId")
		if id == "" {
			id = stableID(userID, "asset", rid)
			item["assetId"] = id
		}
		if !safeID.MatchString(id) || len(id) > 80 {
			failure = fmt.Errorf("invalid asset identity")
			return
		}
		if items[id] == nil {
			kind := resource.Kind
			if kind == "file" {
				kind = "model"
			}
			items[id] = &model.Asset{ID: id, UserID: userID, Kind: kind, Category: model.AssetCategoryOther, Status: model.AssetVersionStatusConfirmed, Title: stringValue(item, "title"), CreatedAt: time.Now(), UpdatedAt: time.Now()}
			refs[id] = map[string]bool{}
		}
		refs[id][rid] = true
	})
	if failure != nil {
		return nil, failure
	}
	result := make([]model.Asset, 0, len(items))
	for id, item := range items {
		keys := []string{}
		for rid := range refs[id] {
			keys = append(keys, "resource:"+rid)
		}
		sort.Strings(keys)
		resource := resources[strings.TrimPrefix(keys[0], "resource:")]
		url := "/api/resources/" + resource.ID + "/file"
		data := map[string]any{"storageKey": keys[0], "bytes": resource.Size, "mimeType": resource.MimeType, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs}
		if item.Kind == "image" {
			data["dataUrl"] = url
		} else {
			data["url"] = url
		}
		if item.Kind == "model" {
			data["fileName"] = path.Base(resource.ObjectKey)
		}
		payload, _ := json.Marshal(map[string]any{"id": id, "kind": item.Kind, "title": item.Title, "coverUrl": url, "tags": []string{}, "category": item.Category, "status": item.Status, "data": data, "metadata": map[string]any{"resourceReferences": keys, "source": "browser-folder-migration"}, "createdAt": item.CreatedAt, "updatedAt": item.UpdatedAt})
		item.PayloadJSON = string(payload)
		result = append(result, *item)
	}
	return result, nil
}

func prepareDrawings(manifest Manifest, resources map[string]model.Resource, replacements map[string]string, userID, canvasID string) ([]model.CanvasDrawing, error) {
	result := []model.CanvasDrawing{}
	for id, raw := range manifest.Drawings {
		if !safeID.MatchString(id) || len(id) > 80 {
			return nil, fmt.Errorf("invalid drawing identity")
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			return nil, fmt.Errorf("invalid drawing bundle")
		}
		value = remap(clean(value), replacements).(map[string]any)
		doc, ok := value["document"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("missing drawing document")
		}
		engine := stringValue(doc, "engine")
		if engine != "excalidraw" {
			return nil, fmt.Errorf("unsupported drawing engine %s", engine)
		}
		if snapshot, ok := doc["snapshot"].(map[string]any); !ok || snapshot == nil {
			return nil, fmt.Errorf("missing drawing snapshot")
		}
		snapshot, err := json.Marshal(doc["snapshot"])
		if err != nil {
			return nil, err
		}
		row := model.CanvasDrawing{UserID: userID, CanvasID: canvasID, DrawingID: id, Engine: engine, Revision: number(doc["revision"]), SnapshotJSON: string(snapshot), ShapeCount: int(number(doc["shapeCount"])), PageCount: int(number(doc["pageCount"])), CreatedAt: time.Now(), UpdatedAt: clientTime(doc["updatedAt"])}
		if row.Revision < 1 {
			row.Revision = 1
		}
		row.PreviewResourceID = strings.TrimPrefix(stringValue(value, "previewKey"), "resource:")
		if render, ok := value["render"].(map[string]any); ok {
			row.RenderResourceID = strings.TrimPrefix(stringValue(render, "blobKey"), "resource:")
			row.RenderPageID = stringValue(render, "pageId")
			row.RenderWidth = int(number(render["width"]))
			row.RenderHeight = int(number(render["height"]))
			row.RenderMimeType = stringValue(render, "mimeType")
			row.RenderBackground = stringValue(render, "background")
			if row.RenderResourceID == "" || row.RenderWidth <= 0 || row.RenderHeight <= 0 || row.RenderMimeType == "" {
				return nil, fmt.Errorf("drawing render metadata is incomplete")
			}
			row.RenderStorageKey = "resource:" + row.RenderResourceID
		} else if value["render"] != nil {
			return nil, fmt.Errorf("invalid drawing render metadata")
		}
		for _, rid := range []string{row.PreviewResourceID, row.RenderResourceID} {
			if rid != "" {
				if _, ok := resources[rid]; !ok {
					return nil, fmt.Errorf("drawing media missing")
				}
			}
		}
		result = append(result, row)
	}
	return result, nil
}
func number(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}
