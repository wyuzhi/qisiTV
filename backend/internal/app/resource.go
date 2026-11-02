package app

import (
	"context"
	"io"
	"mime/multipart"
	"time"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/assets"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/resource"
)

const directResourceURLTTL = 5 * time.Minute

type (
	ResourceStream          = assets.ResourceStream
	ResourceDeliveryOptions = assets.ResourceDeliveryOptions
	ResourceDelivery        = assets.ResourceDelivery
)

func (s *Service) resourceDomain() *localasset.Service {
	if s == nil {
		return localasset.NewService(localasset.Dependencies{})
	}
	s.assetsOnce.Do(func() {
		if s.assets == nil {
			s.assets = localasset.NewService(localasset.Dependencies{Repository: localasset.NewRepository(s.repo), Blobs: localasset.NewFileStore(s.dataDir), Quota: s.fileQuota(), Lifecycle: resourceLifecycle{svc: s}, LocalStorage: s.localResourceStorage || s.IsLocalMode(), DataDir: s.dataDir})
		}
	})
	return s.assets
}
func (s *Service) Resources(u string, limit int) ([]model.Resource, error)                               { return s.resourceDomain().Resources(u, limit) }
func (s *Service) Resource(u, id string) (*model.Resource, error)                                        { return s.resourceDomain().Resource(u, id) }
func (s *Service) EnsureResourceMediaMetadata(ctx context.Context, u, id string) (*model.Resource, error) { return s.resourceDomain().EnsureMediaMetadata(ctx, u, id) }
func (s *Service) DirectResourceURL(u, id string) (string, error)                                        { return resource.DirectURLByID(s.resourceDomain(), u, id, directResourceURLTTL, s.settingsEncryptionKey) }
func (s *Service) directResourceURL(item *model.Resource, exp time.Time) (string, error)                 { return resource.DirectURL(item, exp, s.settingsEncryptionKey) }
func (s *Service) prepareResourceDelivery(u string, item *model.Resource, opts ResourceDeliveryOptions) (*ResourceDelivery, error) { return s.resourceDomain().PrepareOwnedDelivery(u, item, opts) }
func (s *Service) signedHTTPSPublicResourceURL(item *model.Resource, exp time.Time) (string, error)      { return resource.SignedHTTPSPublicURL(item, exp, s.settingsEncryptionKey) }
func (s *Service) UploadResource(u string, h *multipart.FileHeader, kind string, w, ht int, dur int64, id ...string) (*model.Resource, error) { return s.resourceDomain().Upload(u, h, kind, w, ht, dur, id...) }
func (s *Service) UploadLocalResource(u string, h *multipart.FileHeader, kind string, w, ht int, dur int64, id ...string) (*model.Resource, error) { return s.resourceDomain().UploadLocal(u, h, kind, w, ht, dur, id...) }
func (s *Service) uploadLocalResource(u string, h *multipart.FileHeader, kind string, w, ht int, dur int64, id ...string) (*model.Resource, error) { return s.resourceDomain().UploadLocal(u, h, kind, w, ht, dur, id...) }
func (s *Service) UploadResourceFile(u, name string, sz int64, kind string, w, ht int, dur int64, f io.ReadSeeker, id ...string) (*model.Resource, error) { return s.resourceDomain().UploadFile(u, name, sz, kind, w, ht, dur, f, id...) }
func (s *Service) UploadLocalResourceFile(u, name string, sz int64, kind string, w, ht int, dur int64, f io.ReadSeeker, id ...string) (*model.Resource, error) { return s.resourceDomain().UploadLocalFile(u, name, sz, kind, w, ht, dur, f, id...) }
func (s *Service) StartChunkedResourceUpload(u string, req localasset.ChunkedUploadStart) (localasset.ChunkedUploadSessionInfo, error) { return s.resourceDomain().StartChunkedUpload(u, req) }
func (s *Service) PutChunkedResourceUpload(u, uploadID string, index int, body io.Reader) error          { return s.resourceDomain().PutChunkedUpload(u, uploadID, index, body) }
func (s *Service) CompleteChunkedResourceUpload(u, uploadID string) (*model.Resource, error)             { return s.resourceDomain().CompleteChunkedUpload(u, uploadID) }
func (s *Service) ImportResourceURL(u, rawURL, kind string, w, ht int, dur int64, id ...string) (*model.Resource, error) { return resource.ImportURLWithPolicy(s.resourceDomain(), s.IsLocalMode(), s.RuntimePolicy, u, rawURL, kind, w, ht, dur, id...) }
func normalizedResourceUploadKey(values []string) *string                                                { return localasset.NormalizedUploadKey(values) }
func resourceUploadInProgress() *AppError                                                                { return resource.UploadInProgress() }
func (s *Service) OpenResource(u, id string) (*model.Resource, io.ReadCloser, error)                     { return s.resourceDomain().Open(u, id) }
func (s *Service) OpenPublicResourceRange(id, exp, sig, rng string) (*ResourceStream, error)             { return resource.OpenPublicRange(s.repo, s.resourceDomain(), id, exp, sig, rng, s.settingsEncryptionKey) }
func (s *Service) openResourceRange(u string, item *model.Resource, rng string) (*ResourceStream, error) { return s.resourceDomain().OpenOwnedRange(u, item, rng) }
func (s *Service) storeResource(u, kind, name, mime string, sz int64, w, ht int, dur int64, body io.Reader, key *string, _ bool) (*model.Resource, bool, error) { return s.resourceDomain().Store(u, kind, name, mime, sz, w, ht, dur, body, key) }
func (s *Service) storeResourceObject(item *model.Resource, name string, body io.Reader) (string, error) { return s.resourceDomain().WriteObject(item, name, body) }
func (s *Service) retryStoredResource(u string, item *model.Resource, kind, mime string, sz int64, body io.Reader, _ ...bool) (*model.Resource, error) { return resource.RetryOwnedItem(s.resourceDomain(), u, item, kind, mime, sz, body) }
func intValue(value any) int                                                                             { return resource.IntValue(value) }
func extensionFromMimeType(mimeType string) string                                                       { return localasset.ExtensionFromMimeType(mimeType) }
func resourceFileExtension(fileName, mimeType, kind string) string                                       { return localasset.FileExtension(fileName, mimeType, kind) }
func imageDimensions(data []byte) (int, int)                                                             { return resource.ImageDimensions(data) }
func normalizeResourceKind(kind, mimeType string) string                                                 { return localasset.NormalizeKind(kind, mimeType) }
func normalizeSingleByteRange(value string) string                                                       { return localasset.NormalizeSingleByteRange(value) }
func firstNonEmpty(values ...string) string                                                              { return kernel.FirstNonEmpty(values...) }
