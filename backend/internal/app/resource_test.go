package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNormalizeSingleByteRange(t *testing.T) {
	tests := map[string]string{
		"bytes=0-1023":       "bytes=0-1023",
		"bytes=1024-":        "bytes=1024-",
		"bytes=-2048":        "bytes=-2048",
		"bytes=0-1,10-20":    "",
		"items=0-10":         "",
		"bytes=invalid-1024": "",
	}
	for input, expected := range tests {
		if actual := normalizeSingleByteRange(input); actual != expected {
			t.Fatalf("normalizeSingleByteRange(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestLocalHydrateRequiredURLRejectsLoopbackResourceURL(t *testing.T) {
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	resource := model.Resource{ID: "resource-local-url-only", UserID: "user-1", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/reference.png", MimeType: "image/png"}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	err := svc.hydrateProviderMedia("user-1", &providerMedia{StorageKey: "resource:resource-local-url-only"}, providerMediaHydrationPolicy{requireURL: true})
	if err == nil || !strings.Contains(err.Error(), "支持内嵌素材") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("local URL-only media error = %v, want a clear local capability error", err)
	}
}

func TestLocalHydrateRejectsLegacyRemoteResourceMetadata(t *testing.T) {
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	resource := model.Resource{
		ID: "resource-legacy-oss", UserID: "user-1", Status: model.ResourceStatusReady,
		Provider: "aliyun", ObjectKey: "users/user-1/image/legacy.png", MimeType: "image/png",
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	err := svc.hydrateProviderMedia("user-1", &providerMedia{StorageKey: "resource:resource-legacy-oss"}, providerMediaHydrationPolicy{preferURL: true})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") || strings.Contains(err.Error(), "对象存储") {
		t.Fatalf("legacy remote resource error = %v, want local-only guidance", err)
	}
}

func TestBeefAPILocalVideoReferenceHydratesInlineForFlatRequest(t *testing.T) {
	svc := newResourceTestService(t)
	localDir := filepath.Join(svc.dataDir, "resources", "users", "user-1", "image")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "reference.png"), []byte("png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "beefapi-local-reference", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/reference.png", MimeType: "image/png",
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := canvasGenerationInput{
		Mode:   "video",
		Prompt: "make the character walk",
		Config: providerConfig{
			BaseURL: "https://enterprise.beefapi.com", InterfaceType: string(model.ChannelInterfaceNewAPIVideo), Model: "seedance-2.5",
		},
		ReferenceImages: []providerMedia{{ID: "image-1", StorageKey: "resource:beefapi-local-reference", MimeType: "image/png"}},
		Metadata:        map[string]interface{}{"videoEditOperation": "image_to_video"},
	}
	if err := svc.hydrateGenerationMedia("user-1", &input, providerMediaHydrationPolicyFor(context.Background(), input)); err != nil {
		t.Fatalf("hydrateGenerationMedia() error = %v", err)
	}
	body, err := beefAPIVideoRequestBody(input)
	if err != nil {
		t.Fatal(err)
	}
	image, _ := body["image"].(map[string]interface{})
	if !strings.HasPrefix(fmt.Sprint(image["url"]), "data:image/png;base64,") {
		t.Fatalf("image = %#v, want inline image data URL", body["image"])
	}
}

func newResourceTestService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.UserDailyUploadUsage{}, &model.Resource{}); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db), dataDir: t.TempDir()}
}

func TestStoreResourceReusesReadyUploadIdentity(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:logical-upload"})
	first, stored, err := svc.storeResource("user-1", "image", "first.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey, false)
	if err != nil {
		t.Fatal(err)
	}
	if !stored {
		t.Fatal("first upload was not stored")
	}
	second, stored, err := svc.storeResource("user-1", "image", "second.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey, false)
	if err != nil {
		t.Fatal(err)
	}
	if stored || second.ID != first.ID || second.ObjectKey != first.ObjectKey {
		t.Fatalf("idempotent upload = %#v, stored=%v; first=%#v", second, stored, first)
	}
	resources, err := svc.repo.Resources("user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 1 {
		t.Fatalf("resource count = %d, want 1", len(resources))
	}
}

func TestRetryStoredResourceKeepsOriginalObjectKey(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:retry-upload"})
	failed := &model.Resource{
		ID: "resource-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/fixed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := svc.repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	retried, err := svc.retryStoredResource("user-1", failed, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != failed.ID || retried.ObjectKey != "users/user-1/image/fixed.png" || retried.Status != model.ResourceStatusReady {
		t.Fatalf("retried resource = %#v", retried)
	}
	resources, err := svc.repo.Resources("user-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 1 {
		t.Fatalf("resource count = %d, want 1", len(resources))
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, err := svc.repo.DailyUploadBytes("user-1", day)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 7 {
		t.Fatalf("daily upload usage = %d, want 7", usage)
	}
}

func TestRetryStoredResourceReleasesDailyQuotaAfterFailure(t *testing.T) {
	svc := newResourceTestService(t)
	uploadKey := normalizedResourceUploadKey([]string{"image:user-1:failed-retry"})
	failed := &model.Resource{
		ID: "resource-failed-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := svc.repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	_, err := svc.retryStoredResource("user-1", failed, "image", "image/png", 7, iotest.ErrReader(errors.New("write failed")))
	if err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("retryStoredResource() error = %v", err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	usage, usageErr := svc.repo.DailyUploadBytes("user-1", day)
	if usageErr != nil {
		t.Fatal(usageErr)
	}
	if usage != 0 {
		t.Fatalf("daily upload usage = %d, want 0", usage)
	}
}

func TestLegacyMediaMigrationSkipsInvalidDataURL(t *testing.T) {
	svc := &Service{}
	input := map[string]interface{}{
		"history": []interface{}{
			map[string]interface{}{"content": "data:video/mp4;base64,broken"},
		},
	}

	result, err := svc.persistLegacyGeneratedMediaResult("user-1", input)
	if err != nil {
		t.Fatalf("persistLegacyGeneratedMediaResult() error = %v", err)
	}
	history := result["history"].([]interface{})
	content := history[0].(map[string]interface{})["content"]
	if content != "data:video/mp4;base64,broken" {
		t.Fatalf("invalid legacy content changed to %v", content)
	}
}

func TestLocalProviderMediaUsesLocalStorageGuidance(t *testing.T) {
	svc := &Service{mode: serviceModeLocal, localResourceStorage: true}
	err := svc.hydrateProviderMedia("user-1", &providerMedia{DataURL: "data:video/mp4;base64,AAAA"}, providerMediaHydrationPolicy{requireURL: true})
	if err == nil || !strings.Contains(err.Error(), "本地资源目录") || strings.Contains(err.Error(), "对象存储") {
		t.Fatalf("local inline reference error = %v", err)
	}
}

func TestGeneratedMediaRejectsInvalidDataURL(t *testing.T) {
	svc := &Service{}
	_, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"content": "data:video/mp4;base64,broken",
	})
	if err == nil {
		t.Fatal("persistGeneratedMediaResult() error = nil, want invalid data URL error")
	}
}

func TestPersistGeneratedMediaAppliesStoredFileQuota(t *testing.T) {
	svc := newResourceTestService(t)
	if err := svc.repo.Create(&model.Resource{
		ID:     "existing",
		UserID: "user-1",
		Status: model.ResourceStatusReady,
		Size:   gigabytes(defaultRuntimePolicy().Resource.StoredFileGB) - 1,
	}); err != nil {
		t.Fatal(err)
	}

	_, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": "data:image/png;base64,YQ=="},
	})
	if err == nil || !strings.Contains(err.Error(), "20GB 上限") {
		t.Fatalf("persistGeneratedMediaResult() error = %v", err)
	}
}

func TestLocalGeneratedMediaIsPersistedAsLocalResource(t *testing.T) {
	svc := newResourceTestService(t)
	svc.localResourceStorage = true
	result, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"image": map[string]interface{}{"dataUrl": "data:image/png;base64,YQ=="},
	})
	if err != nil {
		t.Fatal(err)
	}
	imageValue, ok := result["image"].(map[string]interface{})
	if !ok || !strings.HasPrefix(stringField(imageValue, "storageKey"), "resource:") {
		t.Fatalf("stored image = %#v", result["image"])
	}
	resourceID := strings.TrimPrefix(stringField(imageValue, "storageKey"), "resource:")
	resource, err := svc.repo.ResourceForUser("user-1", resourceID)
	if err != nil {
		t.Fatal(err)
	}
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		t.Fatalf("generated resource = %#v, want ready local resource", resource)
	}
	if _, err := os.Stat(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); err != nil {
		t.Fatalf("local generated file missing: %v", err)
	}
}

func TestPersistGeneratedVideoRepairsMissingDimensionsAndDuration(t *testing.T) {
	svc := newResourceTestService(t)
	svc.localResourceStorage = true
	clip := syntheticVideoMP4(1280, 720, 5042)
	result, err := svc.persistGeneratedMediaResult("user-1", map[string]interface{}{
		"mode": "video",
		"video": map[string]interface{}{
			"dataUrl":  "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(clip),
			"mimeType": "video/mp4",
			"width":    0,
			"height":   0,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok {
		t.Fatalf("video = %#v", result["video"])
	}
	if intValue(video["width"]) != 1280 || intValue(video["height"]) != 720 {
		t.Fatalf("result dimensions = %#v", video)
	}
	if int64(intValue(video["durationMs"])) != 5042 {
		t.Fatalf("result durationMs = %#v, want 5042", video["durationMs"])
	}
	resourceID := strings.TrimPrefix(stringField(video, "storageKey"), "resource:")
	resource, err := svc.repo.ResourceForUser("user-1", resourceID)
	if err != nil {
		t.Fatal(err)
	}
	if resource.Width != 1280 || resource.Height != 720 || resource.DurationMs != 5042 {
		t.Fatalf("resource media = %#v", resource)
	}
}

func TestResourceFileExtensionMapsWaveMIMEAliasesToWav(t *testing.T) {
	for _, mimeType := range []string{"audio/wave", "audio/wav", "audio/x-wav", "audio/vnd.wave"} {
		if got := resourceFileExtension("", mimeType, "audio"); got != ".wav" {
			t.Fatalf("resourceFileExtension(%q) = %q, want .wav", mimeType, got)
		}
	}
}
