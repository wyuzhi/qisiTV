package projectfolder

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"qisitv/backend/internal/model"
)

type fixture struct {
	service    *Service
	db         *gorm.DB
	root, data string
}

func setup(t *testing.T) fixture {
	t.Helper()
	root, data := t.TempDir(), t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(data, "test.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.CanvasProject{}, &model.Resource{}, &model.Asset{}, &model.CanvasDrawing{}, &model.Task{}); err != nil {
		t.Fatal(err)
	}
	service, err := Open(db, Options{DataDir: data, RootDirectory: root, WorkspaceID: "workspace-test"})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	t.Cleanup(func() { sql.Close() })
	return fixture{service, db, root, data}
}
func (f fixture) source(t *testing.T, id string, withTask bool) ImportRequest {
	t.Helper()
	directory := "old-" + id
	if err := os.MkdirAll(filepath.Join(f.root, directory, "references"), 0700); err != nil {
		t.Fatal(err)
	}
	media := []byte("real unchanged image bytes")
	if err := os.WriteFile(filepath.Join(f.root, directory, "references", "original.png"), media, 0600); err != nil {
		t.Fatal(err)
	}
	node := map[string]any{"id": "node-1", "type": "image", "data": map[string]any{"storageKey": "legacy-image", "url": "references/original.png", "apiKey": "never-export-this"}}
	request := ImportRequest{Directory: directory, ReceiptsComplete: true, ExpectedWorkspaceID: "workspace-test"}
	if withTask {
		node["taskId"] = "browser-receipt-1"
		request.Receipts = []json.RawMessage{json.RawMessage(`{"task":{"id":"browser-receipt-1","projectId":"` + id + `","status":"succeeded","providerRequestId":"provider-original","inputJson":"{\"apiKey\":\"secret\",\"prompt\":\"keep prompt\"}"},"apiKey":"secret"}`)}
	}
	manifest := Manifest{Format: "qisitv-project", FormatVersion: 1, Revision: 7, Project: map[string]any{"id": id, "title": "Existing project", "nodes": []any{node}, "connections": []any{}, "createdAt": "2026-01-01T00:00:00Z"}, Media: map[string]MediaEntry{"legacy-image": {Path: "references/original.png", MimeType: "image/png", Bytes: int64(len(media)), SHA256: digestBytes(media), Kind: "image"}}}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.root, directory, ManifestName), raw, 0600); err != nil {
		t.Fatal(err)
	}
	request.ExpectedManifestSHA256 = digestBytes(raw)
	return request
}
func manifestOnDisk(t *testing.T, f fixture, directory string) Manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.root, directory, ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	m, err := parseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestImportPreservesIdentityMediaReceiptAndIdempotence(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", true)
	status, err := f.service.Import(context.Background(), "owner", req)
	if err != nil {
		t.Fatal(err)
	}
	if status.CanvasID != "canvas-one" || status.Revision != 7 || status.Pending || status.State != "ready" || status.LegacyReceipts != 1 {
		t.Fatalf("unexpected status: %+v", status)
	}
	manifest := manifestOnDisk(t, f, req.Directory)
	if manifest.FormatVersion != 2 || manifest.EngineAuthority.WorkspaceID != "workspace-test" || len(manifest.Media) != 1 {
		t.Fatalf("bad migrated manifest: %+v", manifest)
	}
	if _, err = os.Stat(filepath.Join(f.root, req.Directory, ".qisitv", "migration-"+req.ExpectedManifestSHA256+".json")); err != nil {
		t.Fatal("missing original backup", err)
	}
	for key, media := range manifest.Media {
		if !strings.HasPrefix(key, "resource:") {
			t.Fatal("resource identity missing")
		}
		root, _ := openProject(f.root, req.Directory)
		if err = verifyFile(root, media.Path, media.Bytes, media.SHA256); err != nil {
			t.Fatal(err)
		}
		root.Close()
	}
	var taskCount, assetCount int64
	f.db.Model(&model.Task{}).Count(&taskCount)
	f.db.Model(&model.Asset{}).Count(&assetCount)
	if taskCount != 0 || assetCount != 1 {
		t.Fatalf("migration submitted a runnable task or lost asset: tasks=%d assets=%d", taskCount, assetCount)
	}
	receipts, err := f.service.Receipts(context.Background(), "owner", "canvas-one")
	if err != nil || len(receipts) != 1 {
		t.Fatal(receipts, err)
	}
	if strings.Contains(string(receipts[0]), "secret") || !strings.Contains(string(receipts[0]), "provider-original") {
		t.Fatal("receipt secret leak or provider identity lost")
	}
	if _, err = f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal("idempotent retry failed", err)
	}
	var asset model.Asset
	f.db.First(&asset)
	var payload map[string]any
	json.Unmarshal([]byte(asset.PayloadJSON), &payload)
	if payload["kind"] != "image" || payload["data"] == nil || asset.Status != model.AssetVersionStatusConfirmed {
		t.Fatal("asset not in native shape")
	}
}

func TestAtomicOutboxRollbackAndCanonicalUpdates(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	before, _ := f.service.Status(context.Background(), "owner", "canvas-one")
	fail := errors.New("rollback")
	err := f.db.Transaction(func(tx *gorm.DB) error {
		if e := tx.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"title": "discarded", "revision": 8}).Error; e != nil {
			return e
		}
		return fail
	})
	if !errors.Is(err, fail) {
		t.Fatal(err)
	}
	after, _ := f.service.Status(context.Background(), "owner", "canvas-one")
	if after != before {
		t.Fatalf("outbox survived rollback: %+v %+v", before, after)
	}
	if err = f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"title": "Saved by assistant", "revision": 8}).Error; err != nil {
		t.Fatal(err)
	}
	after, _ = f.service.Status(context.Background(), "owner", "canvas-one")
	if !after.Pending || after.ExportedRevision != 7 {
		t.Fatal("claimed saved before disk ack")
	}
	if err = f.service.FlushPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	manifest := manifestOnDisk(t, f, req.Directory)
	if manifest.Revision != 8 || manifest.Project["title"] != "Saved by assistant" {
		t.Fatal("projection did not reflect canonical edit")
	}
	if err = f.db.Create(&model.Task{ID: "native-task", ProjectID: "canvas-one", UserID: "owner", Status: model.TaskStatusSucceeded, ProviderRequestID: "native-provider"}).Error; err != nil {
		t.Fatal(err)
	}
	after, _ = f.service.Status(context.Background(), "owner", "canvas-one")
	if !after.Pending || after.Revision != 8 {
		t.Fatal("task update not queued independently of canvas revision")
	}
	if err = f.service.FlushPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	next := manifestOnDisk(t, f, req.Directory)
	if next.EngineAuthority.Generation <= manifest.EngineAuthority.Generation {
		t.Fatal("outbox generation did not advance")
	}
	receiptBytes, err := os.ReadFile(filepath.Join(f.root, req.Directory, next.ReceiptsPath))
	if err != nil || !strings.Contains(string(receiptBytes), "native-provider") {
		t.Fatal("native receipt missing", err)
	}
}

func TestConflictNeverOverwritesExternalManifestAndRejectsWrites(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	external := []byte(`{"external":"user changes to retain"}`)
	target := filepath.Join(f.root, req.Directory, ManifestName)
	confirmed, _ := os.ReadFile(target)
	os.WriteFile(target, external, 0600)
	if err := f.service.CheckWritable(context.Background(), "owner"); !errors.Is(err, ErrConflict) {
		t.Fatal("external change not rejected", err)
	}
	if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Update("title", "must not save").Error; err == nil {
		t.Fatal("conflict trigger allowed canonical write")
	}
	if _, err := f.service.Flush(context.Background(), "owner", "canvas-one"); !errors.Is(err, ErrConflict) {
		t.Fatal("conflict projection allowed", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(external) {
		t.Fatal("external manifest overwritten")
	}
	if _, err := f.service.Recheck(context.Background(), "owner", "canvas-one"); !errors.Is(err, ErrConflict) {
		t.Fatal("recheck accepted changed file", err)
	}
	if err := os.WriteFile(target, confirmed, 0600); err != nil {
		t.Fatal(err)
	}
	if status, err := f.service.Recheck(context.Background(), "owner", "canvas-one"); err != nil || status.State != "ready" {
		t.Fatal("exact recovery not acknowledged", status, err)
	}
	if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Update("title", "recovered").Error; err != nil {
		t.Fatal("recovered project remains blocked", err)
	}
}

func TestImportRejectsCorruptionEscapeAndIncompleteReceipts(t *testing.T) {
	for _, which := range []string{"hash", "escape", "symlink", "missing-receipt", "running-receipt"} {
		t.Run(which, func(t *testing.T) {
			f := setup(t)
			req := f.source(t, "canvas-one", true)
			target := filepath.Join(f.root, req.Directory, ManifestName)
			original, _ := os.ReadFile(target)
			switch which {
			case "hash":
				os.WriteFile(filepath.Join(f.root, req.Directory, "references", "original.png"), []byte("wrong"), 0600)
			case "escape":
				req.Directory = "../outside"
			case "symlink":
				outside := filepath.Join(t.TempDir(), "media")
				os.WriteFile(outside, []byte("real unchanged image bytes"), 0600)
				os.Remove(filepath.Join(f.root, req.Directory, "references", "original.png"))
				if err := os.Symlink(outside, filepath.Join(f.root, req.Directory, "references", "original.png")); err != nil {
					t.Skip(err)
				}
			case "missing-receipt":
				req.Receipts = nil
			case "running-receipt":
				req.Receipts[0] = json.RawMessage(strings.Replace(string(req.Receipts[0]), "succeeded", "running", 1))
			}
			if _, err := f.service.Import(context.Background(), "owner", req); err == nil {
				t.Fatal("invalid import succeeded")
			}
			var count int64
			f.db.Model(&model.CanvasProject{}).Count(&count)
			if count != 0 {
				t.Fatal("partial canonical project committed")
			}
			got, _ := os.ReadFile(target)
			if string(got) != string(original) {
				t.Fatal("source overwritten on failed import")
			}
		})
	}
}

func TestProjectionRecoversRenameBeforeAcknowledgement(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	var original binding
	f.db.First(&original)
	if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"title": "next", "revision": 8}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Flush(context.Background(), "owner", "canvas-one"); err != nil {
		t.Fatal(err)
	}
	var completed binding
	f.db.First(&completed)
	// Recreate precisely the durable state after manifest rename and before ack.
	err := f.db.Model(&binding{}).Where("canvas_id=?", "canvas-one").Updates(map[string]any{"manifest_sha256": original.ManifestSHA256, "exported_generation": original.ExportedGeneration, "exported_revision": original.ExportedRevision, "pending_manifest_sha256": completed.ManifestSHA256, "pending_generation": completed.ExportedGeneration, "pending_revision": completed.ExportedRevision, "state": "pending"}).Error
	if err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Flush(context.Background(), "owner", "canvas-one")
	if err != nil || status.Pending || status.ExportedRevision != 8 {
		t.Fatal("rename witness did not recover", status, err)
	}
}

func TestNewNativeProjectGetsOneRealFolderAndOwnerFence(t *testing.T) {
	f := setup(t)
	payload := `{"id":"new-canvas","title":"native","nodes":[],"connections":[]}`
	if err := f.db.Create(&model.CanvasProject{ID: "new-canvas", UserID: "owner", Title: "native", PayloadJSON: payload, Revision: 1, CreatedAt: time.Now(), UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Flush(context.Background(), "owner", "new-canvas")
	if err != nil || status.Pending || status.Directory != "qisitv-new-canvas" {
		t.Fatal(status, err)
	}
	manifest := manifestOnDisk(t, f, status.Directory)
	if manifest.EngineAuthority.CanvasID != "new-canvas" {
		t.Fatal("wrong canvas folder")
	}
	if _, err = Open(f.db, Options{DataDir: f.data, RootDirectory: f.root, WorkspaceID: "different-workspace"}); err == nil {
		t.Fatal("different installation stole project root")
	}
}

func TestEngineMediaURLsArePortableAndNeverRetainTickets(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	var resource model.Resource
	f.db.First(&resource)
	payload, _ := json.Marshal(map[string]any{"id": "canvas-one", "nodes": []any{map[string]any{"id": "video", "metadata": map[string]any{"content": "http://127.0.0.1:17372/engine/api/resources/" + resource.ID + "/file?ticket=must-not-export", "storageKey": "resource:" + resource.ID}}}, "connections": []any{}})
	if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"payload_json": string(payload), "revision": 8}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Flush(context.Background(), "owner", "canvas-one"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "must-not-export") || strings.Contains(string(raw), "127.0.0.1") {
		t.Fatal("ephemeral engine ticket leaked to portable manifest")
	}
	if !strings.Contains(string(raw), "images/") {
		t.Fatal("portable media path missing")
	}
}

func TestProjectionRejectsBrowserOnlyMediaAndKeepsConfirmedManifest(t *testing.T) {
	for _, preview := range []string{"blob:http://localhost/temporary", "data:image/png;base64,YQ==", "image:old-scope:blob", "video:old-scope:blob", "audio:old-scope:blob"} {
		t.Run(strings.Split(preview, ":")[0], func(t *testing.T) {
			f := setup(t)
			req := f.source(t, "canvas-one", false)
			if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
			payload, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "image", "type": "image", "metadata": map[string]any{"content": preview, "storageKey": "image:old-scope:blob"}}}})
			if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"payload_json": string(payload), "revision": 8}).Error; err != nil {
				t.Fatal(err)
			}
			status, err := f.service.Flush(context.Background(), "owner", "canvas-one")
			if err == nil || status.State != "error" || !status.Pending || status.ExportedRevision != 7 {
				t.Fatal("browser-only media claimed durable", status, err)
			}
			after, _ := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
			if string(before) != string(after) {
				t.Fatal("last confirmed manifest was replaced")
			}
		})
	}
}

func TestProjectionReplacesPreviewOnlyWithSameObjectVerifiedResource(t *testing.T) {
	f := setup(t)
	req := f.source(t, "canvas-one", false)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	var resource model.Resource
	f.db.First(&resource)
	payload, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "image", "type": "image", "metadata": map[string]any{"resourceId": resource.ID, "content": "blob:http://localhost/preview", "storageKey": "image:old-scope:blob"}}, map[string]any{"type": "text", "metadata": map[string]any{"content": "data: is a literal text note"}}}})
	if err := f.db.Model(&model.CanvasProject{}).Where("id=?", "canvas-one").Updates(map[string]any{"payload_json": string(payload), "revision": 8}).Error; err != nil {
		t.Fatal(err)
	}
	status, err := f.service.Flush(context.Background(), "owner", "canvas-one")
	if err != nil || status.Pending {
		t.Fatal(status, err)
	}
	raw, _ := os.ReadFile(filepath.Join(f.root, req.Directory, ManifestName))
	if strings.Contains(string(raw), "blob:http") || strings.Contains(string(raw), "old-scope") || !strings.Contains(string(raw), "images/") {
		t.Fatal("preview not replaced with durable resource")
	}
}

func TestDrawingDocumentAndRenderSurviveImport(t *testing.T) {
	f := setup(t)
	req := f.source(t, "drawing-canvas", false)
	source := manifestOnDisk(t, f, req.Directory)
	source.Drawings = map[string]json.RawMessage{"drawing-one": json.RawMessage(`{"document":{"version":2,"engine":"excalidraw","snapshot":{"elements":[{"id":"shape-one"}]},"revision":3,"shapeCount":1,"pageCount":1},"previewKey":"legacy-image","render":{"blobKey":"legacy-image","pageId":"page-one","width":100,"height":100,"mimeType":"image/png","background":"white"}}`)}
	raw, _ := json.Marshal(source)
	os.WriteFile(filepath.Join(f.root, req.Directory, ManifestName), raw, 0600)
	req.ExpectedManifestSHA256 = digestBytes(raw)
	if _, err := f.service.Import(context.Background(), "owner", req); err != nil {
		t.Fatal(err)
	}
	var drawing model.CanvasDrawing
	if err := f.db.Where("drawing_id=?", "drawing-one").First(&drawing).Error; err != nil {
		t.Fatal(err)
	}
	if drawing.Revision != 3 || drawing.PreviewResourceID == "" || drawing.RenderResourceID == "" || !strings.Contains(drawing.SnapshotJSON, "shape-one") {
		t.Fatal("drawing import lost document or render", drawing)
	}
	projected := manifestOnDisk(t, f, req.Directory)
	if !strings.Contains(string(projected.Drawings["drawing-one"]), "shape-one") || !strings.Contains(string(projected.Drawings["drawing-one"]), "resource:") {
		t.Fatal("drawing missing from projected folder")
	}
}

func TestMalformedDrawingDoesNotCommitOrOverwriteSource(t *testing.T) {
	for _, bundle := range []string{`{"document":{"engine":"excalidraw"}}`, `{"document":{"engine":"excalidraw","snapshot":{}},"render":{}}`} {
		f := setup(t)
		req := f.source(t, "canvas-one", false)
		manifest := manifestOnDisk(t, f, req.Directory)
		manifest.Drawings = map[string]json.RawMessage{"drawing-one": json.RawMessage(bundle)}
		raw, _ := json.Marshal(manifest)
		target := filepath.Join(f.root, req.Directory, ManifestName)
		os.WriteFile(target, raw, 0600)
		req.ExpectedManifestSHA256 = digestBytes(raw)
		if _, err := f.service.Import(context.Background(), "owner", req); err == nil {
			t.Fatal("incomplete drawing falsely imported")
		}
		var count int64
		f.db.Model(&model.CanvasProject{}).Count(&count)
		if count != 0 {
			t.Fatal("failed drawing import left partial project")
		}
		after, _ := os.ReadFile(target)
		if string(after) != string(raw) {
			t.Fatal("failed drawing import changed original manifest")
		}
	}
}

func TestUnrelatedDirectoryCollisionDoesNotStopOtherProjectProjection(t *testing.T) {
	f := setup(t)
	for _, id := range []string{"blocked-canvas", "good-canvas"} {
		payload, _ := json.Marshal(map[string]any{"id": id, "nodes": []any{}, "connections": []any{}})
		if err := f.db.Create(&model.CanvasProject{ID: id, UserID: "owner", PayloadJSON: string(payload), Revision: 1}).Error; err != nil {
			t.Fatal(err)
		}
	}
	collision := filepath.Join(f.root, "qisitv-blocked-canvas")
	os.Mkdir(collision, 0700)
	os.WriteFile(filepath.Join(collision, "unrelated.txt"), []byte("keep this"), 0600)
	pending, err := f.service.List(context.Background(), "owner")
	if err != nil || len(pending) != 2 {
		t.Fatal("unbound projects hidden", pending, err)
	}
	if err = f.service.FlushPending(context.Background()); err == nil {
		t.Fatal("nonempty unrelated directory was claimed")
	}
	good, err := f.service.Status(context.Background(), "owner", "good-canvas")
	if err != nil || good.Pending {
		t.Fatal("unrelated collision blocked valid project", good, err)
	}
	bad, err := f.service.Status(context.Background(), "owner", "blocked-canvas")
	if err != nil || !bad.Pending || bad.ExportedRevision != 0 {
		t.Fatal("unbound project falsely marked saved", bad, err)
	}
	contents, _ := os.ReadFile(filepath.Join(collision, "unrelated.txt"))
	if string(contents) != "keep this" {
		t.Fatal("unrelated folder modified")
	}
}
