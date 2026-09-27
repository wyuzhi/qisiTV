package app

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"qisitv/backend/internal/kernel"
	"strconv"
	"strings"
	"time"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

const providerResourceURLTTL = 4 * time.Hour
const directResourceURLTTL = 5 * time.Minute

var errInvalidGeneratedDataURL = errors.New("生成内容 data URL 无效")

type ResourceStream = assets.ResourceStream
type ResourceDeliveryOptions = assets.ResourceDeliveryOptions
type ResourceDelivery = assets.ResourceDelivery

// localResourceUnavailable is the single storage-boundary check used by all
// read and delivery paths. A local workspace must never fall through to a
// historical OSS provider, even if an old database row still contains one.
func (s *Service) localResourceUnavailable(resource *model.Resource) bool {
	return s.localResourceStorage && (resource == nil || resource.Provider != "local")
}

func (s *Service) Resources(userID string, limit int) ([]model.Resource, error) {
	resources, err := s.repo.Resources(userID, limit)
	for index := range resources {
		resources[index].PublicURL = ""
	}
	return resources, err
}

func (s *Service) Resource(userID string, id string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	if resource != nil {
		resource.PublicURL = ""
	}
	return resource, err
}

// DirectResourceURL 仅为本地文件签发短时下载地址。
func (s *Service) DirectResourceURL(userID string, id string) (string, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		return "", err
	}
	return s.directResourceURL(resource, time.Now().Add(directResourceURLTTL))
}

func (s *Service) directResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	if resource.Status != model.ResourceStatusReady {
		return "", BadAuthRequest("资源尚未上传完成")
	}
	if resource.Provider != "local" {
		return "", BadAuthRequest("资源不在本地存储中")
	}
	return s.signedPublicResourceURL(resource, expiresAt)
}

// PrepareResourceDelivery 统一决定浏览器资源出口：配置 CDN 时默认直连 CDN，显式代理仅用于需要同源 Blob 的内部读取。
func (s *Service) PrepareResourceDelivery(userID string, id string, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, NotFound("资源不存在")
		}
		return nil, err
	}
	return s.prepareResourceDelivery(userID, resource, options)
}

func (s *Service) prepareResourceDelivery(userID string, resource *model.Resource, options ResourceDeliveryOptions) (*ResourceDelivery, error) {
	if resource == nil {
		return nil, errors.New("资源不存在")
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, BadAuthRequest("资源尚未上传完成")
	}
	if resource.Provider != "local" {
		return nil, BadAuthRequest("资源不在本地存储中")
	}
	_ = userID
	_ = options
	return &ResourceDelivery{Resource: resource}, nil
}

func (s *Service) signedPublicResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	baseURL, err := s.publicResourceBaseURL()
	if err != nil {
		return "", err
	}
	expires := strconv.FormatInt(expiresAt.UTC().Unix(), 10)
	signature, err := s.signPublicResource(resource.ID, expires)
	if err != nil {
		return "", err
	}
	ext := resourceFileExtension(resource.ObjectKey, resource.MimeType, resource.Kind)
	filename := resource.ID
	if ext != "" {
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		filename += ext
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/") + "/api/public/resources/" + url.PathEscape(resource.ID) + "/file/" + url.PathEscape(filename)
	query := baseURL.Query()
	query.Set("expires", expires)
	query.Set("signature", signature)
	baseURL.RawQuery = query.Encode()
	return baseURL.String(), nil
}

func (s *Service) signedHTTPSPublicResourceURL(resource *model.Resource, expiresAt time.Time) (string, error) {
	baseURL, err := s.publicResourceBaseURL()
	if err != nil {
		return "", err
	}
	if baseURL.Scheme != "https" {
		return "", BadAuthRequest("私网或 HTTP S3 用于上游资源时，服务器公开访问地址必须使用 HTTPS")
	}
	return s.signedPublicResourceURL(resource, expiresAt)
}

func (s *Service) verifyPublicResourceSignature(resourceID string, expires string, signature string) error {
	if strings.TrimSpace(signature) == "" || !decimalDigits(expires) {
		return Forbidden("匿名下载链接无效")
	}
	expiresAt, err := strconv.ParseInt(expires, 10, 64)
	if err != nil || time.Now().UTC().Unix() > expiresAt {
		return Forbidden("匿名下载链接已过期")
	}
	expected, err := s.signPublicResource(resourceID, expires)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return Forbidden("匿名下载链接无效")
	}
	return nil
}

func (s *Service) signPublicResource(resourceID string, expires string) (string, error) {
	key, err := s.settingsEncryptionKey()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(resourceID + "\n" + expires))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *Service) publicResourceBaseURL() (*url.URL, error) {
	raw := strings.TrimSpace(os.Getenv("CANVAS_PUBLIC_BASE_URL"))
	if raw == "" {
		return nil, BadAuthRequest("本地资源尚未配置上游可访问地址，请设置 CANVAS_PUBLIC_BASE_URL")
	}
	return validatePublicResourceBaseURL(raw)
}

func validatePublicResourceBaseURL(raw string) (*url.URL, error) {
	parsed, err := ValidateOutboundURL(raw)
	if err != nil {
		return nil, err
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, BadAuthRequest("服务器访问地址不能包含查询参数或片段")
	}
	if strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/api") {
		return nil, BadAuthRequest("服务器访问地址请填写根地址，不要包含 /api")
	}
	return parsed, nil
}

func (s *Service) UploadResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadResource(userID, header, kind, width, height, durationMs, s.IsLocalMode(), uploadIdentity...)
}

// UploadLocalResource is the desktop boundary: local uploads must never consult
// historical OSS settings, even if a database was previously used by the hosted
// profile.
func (s *Service) UploadLocalResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadResource(userID, header, kind, width, height, durationMs, true, uploadIdentity...)
}

// uploadLocalResource keeps small system-owned assets on the server even when
// the uploader or platform has enabled object storage. The resource still uses
// the normal database record and persistent data directory lifecycle.
func (s *Service) uploadLocalResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadResource(userID, header, kind, width, height, durationMs, true, uploadIdentity...)
}

func (s *Service) uploadResource(userID string, header *multipart.FileHeader, kind string, width int, height int, durationMs int64, forceLocal bool, uploadIdentity ...string) (*model.Resource, error) {
	if header == nil {
		return nil, BadAuthRequest("请选择要上传的文件")
	}
	uploadKey := normalizedResourceUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	if existing != nil && existing.Status == model.ResourceStatusPending {
		return nil, resourceUploadInProgress()
	}
	file, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer file.Close()

	mimeType := strings.TrimSpace(header.Header.Get("Content-Type"))
	mimeType = detectUploadedMimeType(file, header.Filename, mimeType)
	if existing != nil {
		return s.retryStoredResource(userID, existing, kind, mimeType, header.Size, file, forceLocal)
	}
	day, err := s.reserveUserUploadQuota(userID, header.Size)
	if err != nil {
		return nil, err
	}
	resource, stored, err := s.storeResource(userID, kind, header.Filename, mimeType, header.Size, width, height, durationMs, file, uploadKey, forceLocal)
	if err != nil {
		s.releaseUserUploadQuota(userID, day, header.Size)
	} else if stored {
		s.commitUserUploadQuota(userID, header.Size)
	} else {
		s.releaseUserUploadQuota(userID, day, header.Size)
	}
	return resource, err
}

// UploadResourceFile 接收已完整落盘的本地文件（分片上传合并后调用）。
// 它与 UploadResource 共享资源幂等、媒体探测、配额和持久化语义，唯一差异是分片会话已在 handler 校验单文件上限，
// 因而此处不再重复该上限检查；uploadIdentity 用于跨请求重试时复用同一逻辑资源，避免重复对象。
func (s *Service) UploadResourceFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadResourceFile(userID, fileName, size, kind, width, height, durationMs, file, s.IsLocalMode(), uploadIdentity...)
}

// UploadLocalResourceFile is the chunked-upload equivalent of UploadLocalResource.
func (s *Service) UploadLocalResourceFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, uploadIdentity ...string) (*model.Resource, error) {
	return s.uploadResourceFile(userID, fileName, size, kind, width, height, durationMs, file, true, uploadIdentity...)
}

func (s *Service) uploadResourceFile(userID string, fileName string, size int64, kind string, width int, height int, durationMs int64, file io.ReadSeeker, forceLocal bool, uploadIdentity ...string) (*model.Resource, error) {
	if file == nil || size <= 0 {
		return nil, BadAuthRequest("请选择要上传的文件")
	}
	uploadKey := normalizedResourceUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	if existing != nil && existing.Status == model.ResourceStatusPending {
		return nil, resourceUploadInProgress()
	}
	mimeType := detectUploadedMimeType(file, fileName, "")
	if existing != nil {
		return s.retryStoredResource(userID, existing, kind, mimeType, size, file, forceLocal)
	}
	day, err := s.reserveChunkedUploadQuota(userID, size)
	if err != nil {
		return nil, err
	}
	resource, stored, err := s.storeResource(userID, kind, fileName, mimeType, size, width, height, durationMs, file, uploadKey, forceLocal)
	if err != nil {
		s.releaseUserUploadQuota(userID, day, size)
	} else if stored {
		s.commitUserUploadQuota(userID, size)
	} else {
		s.releaseUserUploadQuota(userID, day, size)
	}
	return resource, err
}

func detectUploadedMimeType(file io.ReadSeeker, fileName string, declared string) string {
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	buffer := make([]byte, 512)
	read, _ := file.Read(buffer)
	_, _ = file.Seek(0, io.SeekStart)
	if detected := http.DetectContentType(buffer[:read]); detected != "" && detected != "application/octet-stream" {
		return strings.TrimSpace(strings.Split(detected, ";")[0])
	}
	if fromExtension := mime.TypeByExtension(filepath.Ext(fileName)); fromExtension != "" {
		return strings.TrimSpace(strings.Split(fromExtension, ";")[0])
	}
	return "application/octet-stream"
}

func (s *Service) ImportResourceURL(userID string, rawURL string, kind string, width int, height int, durationMs int64, uploadIdentity ...string) (*model.Resource, error) {
	if s.IsLocalMode() {
		return nil, Forbidden("本地工作区不支持通过 URL 导入素材，请先下载到本机后上传")
	}
	uploadKey := normalizedResourceUploadKey(uploadIdentity)
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		return existing, nil
	}
	if existing != nil && existing.Status == model.ResourceStatusPending {
		return nil, resourceUploadInProgress()
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	payload, err := downloadRemoteResource(rawURL, megabytes(policy.Resource.ResourceUploadMB))
	if err != nil {
		return nil, err
	}
	kind = normalizeResourceKind(kind, payload.mimeType)
	if kind == "image" && (width <= 0 || height <= 0) {
		if decodedWidth, decodedHeight := imageDimensions(payload.data); decodedWidth > 0 && decodedHeight > 0 {
			width = decodedWidth
			height = decodedHeight
		}
	}
	size := int64(len(payload.data))
	if existing != nil {
		return s.retryStoredResource(userID, existing, kind, payload.mimeType, size, bytes.NewReader(payload.data))
	}
	day, err := s.reserveUserUploadQuota(userID, size)
	if err != nil {
		return nil, err
	}
	resource, stored, err := s.storeResource(userID, kind, payload.fileName, payload.mimeType, size, width, height, durationMs, bytes.NewReader(payload.data), uploadKey, s.localResourceStorage)
	if err != nil {
		s.releaseUserUploadQuota(userID, day, size)
	} else if stored {
		s.commitUserUploadQuota(userID, size)
	} else {
		s.releaseUserUploadQuota(userID, day, size)
	}
	return resource, err
}

func normalizedResourceUploadKey(values []string) *string {
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return nil
	}
	digest := sha256.Sum256([]byte(strings.TrimSpace(values[0])))
	value := hex.EncodeToString(digest[:])
	return &value
}

func (s *Service) resourceForUploadKey(userID string, uploadKey *string) (*model.Resource, error) {
	if uploadKey == nil {
		return nil, nil
	}
	resource, err := s.repo.ResourceByUploadKey(userID, *uploadKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return resource, err
}

func resourceUploadInProgress() *AppError {
	err := NewAppError(http.StatusConflict, "相同素材正在上传，请稍后重试")
	err.Retryable = true
	return err
}

func (s *Service) OpenResource(userID string, id string) (*model.Resource, io.ReadCloser, error) {
	stream, err := s.OpenResourceRange(userID, id, "")
	if err != nil {
		return nil, nil, err
	}
	return stream.Resource, stream.Body, nil
}

func (s *Service) OpenResourceRange(userID string, id string, rangeHeader string) (*ResourceStream, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return s.openResourceRange(userID, resource, rangeHeader)
}

func (s *Service) OpenPublicResourceRange(id string, expires string, signature string, rangeHeader string) (*ResourceStream, error) {
	resource, err := s.repo.Resource(id)
	if err != nil {
		return nil, Forbidden("匿名下载链接无效")
	}
	if resource.Provider != "local" {
		return nil, Forbidden("匿名下载链接无效")
	}
	if err := s.verifyPublicResourceSignature(resource.ID, expires, signature); err != nil {
		return nil, err
	}
	return s.openResourceRange(resource.UserID, resource, rangeHeader)
}

func (s *Service) openResourceRange(userID string, resource *model.Resource, rangeHeader string) (*ResourceStream, error) {
	if resource.Status != model.ResourceStatusReady {
		return nil, BadAuthRequest("资源尚未上传完成")
	}
	if resource == nil || resource.Provider != "local" {
		return nil, BadAuthRequest("资源不在本地存储中")
	}
	body, err := localasset.NewFileStore(s.dataDir).Open(resource.ObjectKey)
	if err != nil {
		return nil, err
	}
	_ = userID
	_ = rangeHeader
	return &ResourceStream{Resource: resource, Body: body, StatusCode: http.StatusOK, ContentLength: resource.Size, AcceptRanges: "bytes"}, nil
}

func (s *Service) storeResource(userID string, kind string, fileName string, mimeType string, size int64, width int, height int, durationMs int64, body io.Reader, uploadKey *string, forceLocal bool) (*model.Resource, bool, error) {
	_ = forceLocal
	if existing, err := s.resourceForUploadKey(userID, uploadKey); err != nil {
		return nil, false, err
	} else if existing != nil {
		if existing.Status == model.ResourceStatusReady {
			return existing, false, nil
		}
		return nil, false, resourceUploadInProgress()
	}
	now := time.Now()
	kind = normalizeResourceKind(kind, mimeType)
	objectKey := localObjectKey(userID, kind, fileName, mimeType, now)
	resource := model.Resource{ID: newID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending, Provider: "local", ObjectKey: objectKey, MimeType: mimeType, Size: size, Width: width, Height: height, DurationMs: durationMs, UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now}
	if err := s.repo.CreateResource(&resource); err != nil {
		if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && existing != nil {
			if existing.Status == model.ResourceStatusReady {
				return existing, false, nil
			}
			return nil, false, resourceUploadInProgress()
		}
		return nil, false, err
	}
	etag, err := s.storeResourceObject(&resource, fileName, body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		if saveErr := s.repo.SaveResource(&resource); saveErr != nil {
			return nil, true, errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", saveErr))
		}
		return nil, true, err
	}
	resource.Status = model.ResourceStatusReady
	resource.ETag = etag
	if err := s.repo.SaveResource(&resource); err != nil {
		cleanupErr := s.deleteStoredResourceObject(userID, &resource)
		if cleanupErr == nil {
			if deleteErr := s.repo.DeleteResource(userID, resource.ID); deleteErr != nil {
				return nil, true, errors.Join(err, fmt.Errorf("清理资源记录失败：%w", deleteErr))
			}
			return nil, true, fmt.Errorf("保存资源就绪状态失败：%w", err)
		}

		resource.Status = model.ResourceStatusFailed
		resource.Error = fmt.Sprintf("保存资源就绪状态失败，物理对象清理失败：%v", cleanupErr)
		statusErr := s.repo.SaveResource(&resource)
		if statusErr != nil {
			return nil, true, errors.Join(err, cleanupErr, fmt.Errorf("记录资源失败状态失败：%w", statusErr))
		}
		return nil, true, errors.Join(err, fmt.Errorf("清理已上传资源对象失败：%w", cleanupErr))
	}
	s.recordActivity(userID, "resource", 1)
	s.maybeStartPlaybackTranscode(&resource)
	return &resource, true, nil
}

// storeResourceObject is the single local persistence boundary.
func (s *Service) storeResourceObject(resource *model.Resource, fileName string, body io.Reader) (string, error) {
	if resource == nil {
		return "", errors.New("资源不存在")
	}
	resource.Provider = "local"
	resource.Endpoint = ""
	resource.Bucket = ""
	resource.StorageSettingID = ""
	resource.ETag = ""
	if strings.TrimSpace(resource.ObjectKey) == "" {
		resource.ObjectKey = localObjectKey(resource.UserID, resource.Kind, fileName, resource.MimeType, time.Now())
	}
	return "", localasset.NewFileStore(s.dataDir).Write(resource.ObjectKey, body)
}

func (s *Service) retryStoredResource(userID string, resource *model.Resource, kind string, mimeType string, size int64, body io.Reader, forceLocalFlag ...bool) (*model.Resource, error) {
	_ = forceLocalFlag
	if resource == nil {
		return nil, errors.New("资源不存在")
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status != model.ResourceStatusFailed {
		return nil, resourceUploadInProgress()
	}
	kind = normalizeResourceKind(kind, mimeType)
	if resource.Size != size || resource.Kind != kind || (resource.MimeType != "" && mimeType != "" && resource.MimeType != mimeType) {
		return nil, NewAppError(http.StatusConflict, "上传幂等标识已用于其他文件")
	}
	claimed, err := s.repo.ClaimFailedResourceUpload(userID, resource.ID)
	if err != nil {
		return nil, err
	}
	if !claimed {
		latest, latestErr := s.repo.ResourceForUser(userID, resource.ID)
		if latestErr == nil && latest.Status == model.ResourceStatusReady {
			return latest, nil
		}
		return nil, resourceUploadInProgress()
	}
	if resource.Provider != "local" {
		resource.Provider = "local"
		resource.Endpoint = ""
		resource.Bucket = ""
		resource.StorageSettingID = ""
		resource.ObjectKey = localObjectKey(userID, kind, "", mimeType, time.Now())
	}
	resource.Status = model.ResourceStatusPending
	resource.Error = ""
	resource.UpdatedAt = time.Now()
	day, err := s.reserveRetryUploadQuota(userID, size)
	if err != nil {
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		resource.UpdatedAt = time.Now()
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("恢复资源重试失败状态失败：%w", saveErr))
		}
		return nil, err
	}
	var etag string
	etag, err = s.storeResourceObject(resource, "", body)
	resource.UpdatedAt = time.Now()
	if err != nil {
		s.releaseRetryUploadQuota(userID, day, size)
		resource.Status = model.ResourceStatusFailed
		resource.Error = err.Error()
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("记录资源重试失败状态失败：%w", saveErr))
		}
		return nil, err
	}
	resource.Status = model.ResourceStatusReady
	resource.ETag = etag
	if err := s.repo.SaveResource(resource); err != nil {
		s.releaseRetryUploadQuota(userID, day, size)
		resource.Status = model.ResourceStatusFailed
		resource.Error = "保存资源重试就绪状态失败"
		if saveErr := s.repo.SaveResource(resource); saveErr != nil {
			return nil, errors.Join(err, fmt.Errorf("记录资源重试失败状态失败：%w", saveErr))
		}
		return nil, fmt.Errorf("保存资源重试就绪状态失败：%w", err)
	}
	s.recordActivity(userID, "resource", 1)
	return resource, nil
}

func localObjectKey(userID string, kind string, fileName string, mimeType string, now time.Time) string {
	ext := resourceFileExtension(fileName, mimeType, kind)
	return path.Join("users", safeObjectSegment(userID), kind, now.Format("2006/01/02"), newID()+ext)
}

func (s *Service) persistGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, false, true)
}

func (s *Service) persistLegacyGeneratedMediaResult(userID string, result map[string]interface{}) (map[string]interface{}, error) {
	return s.persistGeneratedMediaResultMode(userID, result, true, false)
}

func (s *Service) persistGeneratedMediaResultMode(userID string, result map[string]interface{}, skipInvalidDataURL bool, enforceQuota bool) (map[string]interface{}, error) {
	if result == nil {
		return map[string]interface{}{}, nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var normalized map[string]interface{}
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	value, err := s.persistGeneratedMediaValueMode(userID, normalized, skipInvalidDataURL, enforceQuota)
	if err != nil {
		return nil, err
	}
	return value.(map[string]interface{}), nil
}

func (s *Service) persistGeneratedMediaValue(userID string, value interface{}) (interface{}, error) {
	return s.persistGeneratedMediaValueMode(userID, value, false, true)
}

func (s *Service) persistGeneratedMediaValueMode(userID string, value interface{}, skipInvalidDataURL bool, enforceQuota bool) (interface{}, error) {
	switch item := value.(type) {
	case []interface{}:
		for index, child := range item {
			stored, err := s.persistGeneratedMediaValueMode(userID, child, skipInvalidDataURL, enforceQuota)
			if err != nil {
				return nil, err
			}
			item[index] = stored
		}
		return item, nil
	case map[string]interface{}:
		if raw := inlineMediaValue(item); raw != "" {
			mimeType, data, err := s.decodeDataURL(raw)
			if err != nil && !skipInvalidDataURL {
				return nil, err
			}
			if err == nil {
				kind := normalizeResourceKind("", mimeType)
				width, height := intValue(item["width"]), intValue(item["height"])
				durationMs := int64(intValue(item["durationMs"]))
				if kind == "image" && (width <= 0 || height <= 0) {
					width, height = imageDimensions(data)
				}
				if kind == "video" {
					probedWidth, probedHeight, probedDurationMs := probeGeneratedVideoMedia(data)
					if width <= 0 {
						width = probedWidth
					}
					if height <= 0 {
						height = probedHeight
					}
					if durationMs <= 0 {
						durationMs = probedDurationMs
					}
				}
				quotaDay := ""
				if enforceQuota {
					quotaDay, err = s.reserveGeneratedResourceQuota(userID, int64(len(data)))
					if err != nil {
						return nil, err
					}
				}
				resource, _, err := s.storeResource(userID, kind, "generated."+extensionFromMimeType(mimeType), mimeType, int64(len(data)), width, height, durationMs, bytes.NewReader(data), nil, s.localResourceStorage)
				if err != nil {
					if enforceQuota {
						s.releaseUserUploadQuota(userID, quotaDay, int64(len(data)))
					}
					return nil, fmt.Errorf("生成内容写入资源存储失败：%w", err)
				}
				if enforceQuota {
					s.commitUserUploadQuota(userID, int64(len(data)))
				}
				resourceURL := resourceFileURL(resource.ID)
				for _, key := range []string{"dataUrl", "content", "url", "coverUrl"} {
					if text, ok := item[key].(string); ok && (text == raw || strings.HasPrefix(text, "blob:")) {
						item[key] = resourceURL
					}
				}
				if _, ok := item["dataUrl"]; ok {
					item["dataUrl"] = resourceURL
				}
				item["url"] = resourceURL
				item["storageKey"] = "resource:" + resource.ID
				item["resourceId"] = resource.ID
				item["bytes"] = resource.Size
				item["mimeType"] = resource.MimeType
				item["width"] = resource.Width
				item["height"] = resource.Height
				if kind == "video" || resource.DurationMs > 0 {
					item["durationMs"] = resource.DurationMs
				}
			}
		}
		for key, child := range item {
			stored, err := s.persistGeneratedMediaValueMode(userID, child, skipInvalidDataURL, enforceQuota)
			if err != nil {
				return nil, err
			}
			item[key] = stored
		}
		return item, nil
	default:
		return value, nil
	}
}

func inlineMediaValue(item map[string]interface{}) string {
	for _, key := range []string{"dataUrl", "content", "url", "coverUrl"} {
		if text, ok := item[key].(string); ok && (strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/")) {
			return text
		}
	}
	return ""
}

func (s *Service) decodeDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, fmt.Errorf("%w：格式无效", errInvalidGeneratedDataURL)
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", nil, fmt.Errorf("%w：base64 解码失败：%v", errInvalidGeneratedDataURL, err)
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", nil, err
	}
	if int64(len(data)) > megabytes(policy.Resource.GeneratedFileMB) {
		return "", nil, fmt.Errorf("单个生成资源超过 %dMB", policy.Resource.GeneratedFileMB)
	}
	return mimeType, data, nil
}

func intValue(value interface{}) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}

type remoteResourcePayload struct {
	url      string
	endpoint string
	fileName string
	mimeType string
	data     []byte
}

func downloadRemoteResource(rawURL string, maxBytes int64) (remoteResourcePayload, error) {
	parsed, err := validateRemoteResourceURL(rawURL)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	client := OutboundHTTPClient(90 * time.Second)
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return remoteResourcePayload{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return remoteResourcePayload{}, fmt.Errorf("远程资源下载失败：%s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	if err != nil {
		return remoteResourcePayload{}, err
	}
	if int64(len(data)) >= maxBytes {
		return remoteResourcePayload{}, BadAuthRequest(fmt.Sprintf("远程资源必须小于 %s", formatStorageLimit(maxBytes)))
	}
	mimeType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if idx := strings.Index(mimeType, ";"); idx >= 0 {
		mimeType = strings.TrimSpace(mimeType[:idx])
	}
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = http.DetectContentType(data)
	}
	fileName := path.Base(parsed.Path)
	if fileName == "" || fileName == "." || !strings.Contains(fileName, ".") {
		fileName = "resource." + extensionFromMimeType(mimeType)
	}
	return remoteResourcePayload{url: parsed.String(), endpoint: parsed.Host, fileName: fileName, mimeType: mimeType, data: data}, nil
}

func openRemoteResource(rawURL string) (io.ReadCloser, error) {
	parsed, err := validateRemoteResourceURL(rawURL)
	if err != nil {
		return nil, err
	}
	client := OutboundHTTPClient(90 * time.Second)
	resp, err := client.Get(parsed.String())
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, fmt.Errorf("远程资源读取失败：%s", resp.Status)
	}
	return resp.Body, nil
}

func validateRemoteResourceURL(rawURL string) (*url.URL, error) {
	return ValidateOutboundURL(rawURL)
}

func extensionFromMimeType(mimeType string) string {
	if strings.Contains(mimeType, "png") {
		return "png"
	}
	if strings.Contains(mimeType, "jpeg") {
		return "jpg"
	}
	if strings.Contains(mimeType, "webp") {
		return "webp"
	}
	if strings.Contains(mimeType, "gif") {
		return "gif"
	}
	if strings.Contains(mimeType, "mp4") {
		return "mp4"
	}
	if strings.Contains(mimeType, "webm") {
		return "webm"
	}
	if strings.Contains(mimeType, "mpeg") {
		return "mp3"
	}
	if strings.Contains(mimeType, "wav") {
		return "wav"
	}
	return "bin"
}

func resourceFileExtension(fileName string, mimeType string, kind string) string {
	if ext := strings.ToLower(filepath.Ext(strings.TrimSpace(fileName))); ext != "" && ext != "." {
		return ext
	}
	cleanMimeType := strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if extensions, err := mime.ExtensionsByType(cleanMimeType); err == nil && len(extensions) > 0 {
		return strings.ToLower(extensions[0])
	}
	if mapped := extensionFromMimeType(cleanMimeType); mapped != "bin" {
		return "." + mapped
	}
	switch kind {
	case "image":
		return ".png"
	case "video":
		return ".mp4"
	case "audio":
		return ".mp3"
	default:
		return ".bin"
	}
}

func imageDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return config.Width, config.Height
}

func normalizeResourceKind(kind string, mimeType string) string {
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "image", "video", "audio", "file":
		return kind
	}
	if strings.HasPrefix(mimeType, "image/") {
		return "image"
	}
	if strings.HasPrefix(mimeType, "video/") {
		return "video"
	}
	if strings.HasPrefix(mimeType, "audio/") {
		return "audio"
	}
	return "file"
}

func normalizeSingleByteRange(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 128 || !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return ""
	}
	start, end, ok := strings.Cut(strings.TrimPrefix(value, "bytes="), "-")
	if !ok || (start == "" && end == "") || !decimalDigits(start) || !decimalDigits(end) {
		return ""
	}
	return "bytes=" + start + "-" + end
}

func decimalDigits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func safeObjectSegment(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, value)
	return strings.Trim(value, "-")
}

func firstNonEmpty(values ...string) string {
	return kernel.FirstNonEmpty(values...)
}
