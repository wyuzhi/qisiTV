package beefapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/outbound"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

var ErrUploadIncomplete = errors.New("参考素材未能确认，请重新提交")
var ErrUploadRedirect = errors.New("参考素材上传不允许重定向")
var uploadControlTimeout = 30 * time.Second
var uploadCompleteTimeout = 90 * time.Second

type UploadPart struct {
	Number          int               `json:"number"`
	Bytes           int64             `json:"bytes"`
	Received        bool              `json:"received"`
	UploadURL       string            `json:"upload_url"`
	RequiredHeaders map[string]string `json:"required_headers"`
}

type UploadObservation struct {
	Request       *http.Request
	Response      *http.Response
	Err           error
	StartedAt     time.Time
	Dispatched    bool
	Phase, Route  string
	ReceivedBytes int64
}

type uploadContextKey struct{}
type UploadMeta struct {
	Stage   string
	Attempt int
}

func UploadMetaFromContext(ctx context.Context) UploadMeta {
	value, _ := ctx.Value(uploadContextKey{}).(UploadMeta)
	return value
}
func withUploadMeta(ctx context.Context, stage string, attempt int) context.Context {
	return context.WithValue(ctx, uploadContextKey{}, UploadMeta{Stage: stage, Attempt: attempt})
}

type UploadError struct {
	Meta       UploadMeta
	Dispatched bool
	Phase      string
	Cause      error
}

func (e *UploadError) Error() string { return e.Cause.Error() }
func (e *UploadError) Unwrap() error { return e.Cause }
func uploadError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var known *UploadError
	if errors.As(err, &known) {
		return err
	}
	return &UploadError{Meta: UploadMetaFromContext(ctx), Cause: err}
}

type UploadPlan struct {
	PartBytes int64        `json:"part_bytes"`
	Parts     []UploadPart `json:"parts"`
}
type UploadSession struct {
	UploadURL       string            `json:"upload_url"`
	UploadMethod    string            `json:"upload_method"`
	RequiredHeaders map[string]string `json:"required_headers"`
	Ticket          string            `json:"ticket"`
	Multipart       *UploadPlan       `json:"multipart,omitempty"`
}
type UploadRequest struct {
	Resumable bool   `json:"resumable,omitempty"`
	Kind      string `json:"kind"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	Mime      string `json:"mime"`
}
type UploadedMedia struct {
	URL    string `json:"url"`
	Kind   string `json:"kind"`
	Mime   string `json:"mime"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func (c *MediaClient) uploadJSON(ctx context.Context, path string, body, out any) error {
	stage := "create"
	for _, value := range []string{"complete", "resume", "abort"} {
		if strings.HasSuffix(path, "/"+value) {
			stage = value
		}
	}
	meta := UploadMetaFromContext(ctx)
	if meta.Attempt == 0 {
		meta.Attempt = 1
	}
	ctx = withUploadMeta(ctx, stage, meta.Attempt)
	attemptTimeout := uploadControlTimeout
	if stage == "complete" {
		attemptTimeout = uploadCompleteTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	req, err := c.request(reqCtx, http.MethodPost, path, body)
	if err != nil {
		return uploadError(ctx, err)
	}
	data, _, err := c.send(req, 1<<20)
	if err != nil {
		return uploadError(ctx, err)
	}
	return uploadError(ctx, json.Unmarshal(data, out))
}
func (c *MediaClient) CreateUpload(ctx context.Context, request UploadRequest) (UploadSession, error) {
	var session UploadSession
	request.Resumable = true
	err := c.uploadJSON(ctx, "/media/uploads", request, &session)
	if err == nil {
		err = c.validateUpload(ctx, session, request.Bytes)
	}
	return session, uploadError(withUploadMeta(ctx, "create", 1), err)
}
func (c *MediaClient) validateUpload(ctx context.Context, s UploadSession, size int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.Ticket == "" {
		return errors.New("素材上传编号无效")
	}
	if s.Multipart == nil {
		if s.UploadMethod != "" && !strings.EqualFold(s.UploadMethod, http.MethodPut) {
			return errors.New("素材上传方式无效")
		}
		return c.validURLContext(ctx, s.UploadURL)
	}
	if s.Multipart.PartBytes <= 0 || len(s.Multipart.Parts) == 0 {
		return errors.New("素材上传分片无效")
	}
	var total int64
	for index, part := range s.Multipart.Parts {
		if part.Number != index+1 || part.Bytes <= 0 || part.Bytes > s.Multipart.PartBytes || (index < len(s.Multipart.Parts)-1 && part.Bytes != s.Multipart.PartBytes) {
			return errors.New("素材上传分片无效")
		}
		if !part.Received {
			if err := c.validURLContext(ctx, part.UploadURL); err != nil {
				return err
			}
		}
		if part.Bytes > size-total {
			return errors.New("素材上传分片大小不一致")
		}
		total += part.Bytes
	}
	if total != size {
		return errors.New("素材上传分片大小不一致")
	}
	return nil
}

func (c *MediaClient) ValidateUploadSession(ctx context.Context, session UploadSession, size int64) error {
	if size == 0 && session.Multipart != nil {
		for _, part := range session.Multipart.Parts {
			size += part.Bytes
		}
	}
	return c.validateUpload(ctx, session, size)
}
func (c *MediaClient) ValidateUploadURL(ctx context.Context, raw string) error {
	return c.validURLContext(ctx, raw)
}
func (c *MediaClient) PutUploadBytes(ctx context.Context, session UploadSession, data []byte) error {
	return c.putStorage(ctx, session.UploadURL, session.RequiredHeaders, bytes.NewReader(data), int64(len(data)), 0, int64(len(data)), "参考素材")
}
func skipStorageHeader(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "x-api-key", "x-goog-api-key":
		return true
	}
	return strings.HasPrefix(strings.ToLower(key), "x-canvas-")
}

type uploadProgressReader struct {
	io.Reader
	loaded, total int64
	report        func(int64, int64)
}

func (r *uploadProgressReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.loaded += int64(n)
	if r.report != nil {
		r.report(r.loaded, r.total)
	}
	return n, err
}
func (c *MediaClient) putStorage(ctx context.Context, link string, headers map[string]string, source io.Reader, size, offset, total int64, label string) (resultErr error) {
	ctx = c.networkContext(ctx)
	meta := UploadMetaFromContext(ctx)
	if meta.Attempt == 0 {
		meta.Attempt = 1
	}
	ctx = withUploadMeta(ctx, "put", meta.Attempt)
	body := &uploadProgressReader{Reader: source, total: size, report: func(n, _ int64) {
		if c.Progress != nil {
			c.Progress(label, offset+n, total, "transferring")
		}
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, link, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.GetBody = nil
	for key, value := range headers {
		if !skipStorageHeader(key) {
			req.Header.Set(key, value)
		}
	}
	client := *c.httpClient()
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	trace := &outbound.TransportTrace{}
	req = trace.Attach(req)
	observation := UploadObservation{Request: req, StartedAt: time.Now(), Route: "direct"}
	validating := true
	if route := outbound.RequestNetworkRoute(req, client.Transport); route != "" {
		observation.Route = route
	}
	defer func() {
		observation.Dispatched, observation.Phase = trace.Result(resultErr)
		if validating {
			observation.Dispatched = false
			observation.Phase = "dns"
		}
		if resultErr != nil {
			resultErr = &UploadError{Meta: UploadMetaFromContext(ctx), Dispatched: observation.Dispatched, Phase: observation.Phase, Cause: resultErr}
		}
		observation.Err = resultErr
		if c.StorageObserve != nil {
			c.StorageObserve(observation)
		}
	}()
	if err := c.validURLContext(req.Context(), link); err != nil {
		return err
	}
	validating = false
	resp, err := client.Do(req)
	observation.Response = resp
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	errorBody, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	observation.ReceivedBytes = int64(len(errorBody))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return ErrUploadRedirect
		}
		var failure struct {
			Code      string `xml:"Code"`
			RequestID string `xml:"RequestId"`
		}
		_ = xml.Unmarshal(errorBody, &failure)
		if failure.RequestID == "" {
			failure.RequestID = resp.Header.Get("X-Amz-Request-Id")
		}
		if failure.RequestID == "" {
			failure.RequestID = resp.Header.Get("X-Cos-Request-Id")
		}
		if failure.Code == "" {
			failure.Code = "storage_put_failed"
		}
		return &MediaHTTPError{StatusCode: resp.StatusCode, TaskError: MediaTaskError{Code: failure.Code, Message: fmt.Sprintf("素材直传未完成（HTTP %d）", resp.StatusCode)}, RequestID: failure.RequestID}
	}
	if readErr != nil {
		return readErr
	}
	return nil
}
func (c *MediaClient) confirmUpload(ctx context.Context, ticket string) (UploadedMedia, error) {
	var uploaded UploadedMedia
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		err = c.uploadJSON(withUploadMeta(ctx, "complete", attempt+1), "/media/uploads/complete", map[string]string{"ticket": ticket}, &uploaded)
		if err == nil || ctx.Err() != nil || !retryUploadControl(err) || attempt == 3 {
			break
		}
		if err = uploadPause(ctx, attempt); err != nil {
			return uploaded, err
		}
	}
	if err == nil {
		if uploaded.URL == "" {
			err = ErrUploadIncomplete
		} else {
			err = c.validURLContext(ctx, uploaded.URL)
		}
	}
	return uploaded, uploadError(withUploadMeta(ctx, "complete", 1), err)
}

func retryUploadControl(err error) bool {
	var certificate *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.Is(err, context.Canceled) || errors.As(err, &certificate) || errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return false
	}
	var upstream *MediaHTTPError
	if errors.As(err, &upstream) {
		return upstream.StatusCode == 408 || upstream.StatusCode == 429 || upstream.StatusCode >= 500
	}
	var network net.Error
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return dns.Timeout() || dns.Temporary()
	}
	return errors.As(err, &network) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

func RetryUploadError(err error) bool { return retryUploadControl(err) }
func uploadPause(ctx context.Context, attempt int) error {
	timer := time.NewTimer(250 * time.Millisecond * time.Duration(1<<min(attempt, 2)))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// The same ticket survives PUT errors. Complete first checks a lost storage
// acknowledgement; multipart resume refreshes signatures and received parts.
// No upload failure can dispatch a generation or fall back through the API.
func (c *MediaClient) CompleteUpload(ctx context.Context, session UploadSession, data []byte, label string) (result UploadedMedia, resultErr error) {
	return c.CompleteUploadSource(ctx, session, bytes.NewReader(data), int64(len(data)), label)
}

func (c *MediaClient) CompleteUploadSource(ctx context.Context, session UploadSession, source io.ReaderAt, size int64, label string) (result UploadedMedia, resultErr error) {
	defer func() {
		if resultErr != nil && session.Multipart != nil && session.Ticket != "" {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			var ignored map[string]any
			_ = c.uploadJSON(cleanup, "/media/uploads/abort", map[string]string{"ticket": session.Ticket}, &ignored)
		}
	}()
	if err := c.validateUpload(ctx, session, size); err != nil {
		return result, err
	}
	maxAttempts := 4
	if session.Multipart == nil {
		maxAttempts = 3
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		ctx := withUploadMeta(ctx, "put", attempt+1)
		if c.Progress != nil {
			c.Progress(label, 0, size, "resuming")
		}
		var putErr error
		if session.Multipart == nil {
			putErr = c.putStorage(ctx, session.UploadURL, session.RequiredHeaders, io.NewSectionReader(source, 0, size), size, 0, size, label)
		} else {
			var offset int64
			for _, part := range session.Multipart.Parts {
				end := offset + part.Bytes
				if part.Received && c.Progress != nil {
					c.Progress(label, end, size, "resuming")
				}
				if !part.Received {
					putErr = c.putStorage(ctx, part.UploadURL, part.RequiredHeaders, io.NewSectionReader(source, offset, part.Bytes), part.Bytes, offset, size, label)
					if putErr != nil {
						break
					}
				}
				offset = end
			}
		}
		var storageFailure *MediaHTTPError
		if putErr != nil && !retryUploadControl(putErr) && !(session.Multipart != nil && errors.As(putErr, &storageFailure) && storageFailure.StatusCode == 403) {
			return result, putErr
		}
		if putErr == nil {
			if c.Progress != nil {
				c.Progress(label, size, size, "processing")
			}
			return c.confirmUpload(ctx, session.Ticket)
		}
		// A single PUT may have reached storage despite a lost acknowledgement.
		// Multipart resumes its existing part receipts before sending more bytes.
		if session.Multipart == nil {
			completed, confirmErr := c.confirmUpload(ctx, session.Ticket)
			if confirmErr == nil {
				return completed, nil
			}
			var incomplete *MediaHTTPError
			if !errors.As(confirmErr, &incomplete) || incomplete.StatusCode != 400 || (incomplete.TaskError.Code != "video_reference_upload_incomplete" && incomplete.TaskError.Code != "media_upload_incomplete") {
				return result, confirmErr
			}
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		resultErr = putErr
		if attempt == maxAttempts-1 {
			break
		}
		if err := uploadPause(ctx, attempt); err != nil {
			return result, err
		}
		if session.Multipart != nil {
			var resumed UploadSession
			if err := c.uploadJSON(ctx, "/media/uploads/resume", map[string]string{"ticket": session.Ticket}, &resumed); err != nil {
				return result, err
			}
			if resumed.Ticket != session.Ticket || resumed.Multipart == nil || resumed.Multipart.PartBytes != session.Multipart.PartBytes {
				return result, errors.New("恢复上传的素材编号或分片发生变化")
			}
			if err := c.validateUpload(ctx, resumed, size); err != nil {
				return result, err
			}
			session = resumed
		}
	}
	return result, resultErr
}

type mediaReadSeekerAt interface {
	io.Reader
	io.Seeker
	io.ReaderAt
}
type mediaContextReader struct {
	ctx context.Context
	io.Reader
}

func (r mediaContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func (c *MediaClient) UploadReference(ctx context.Context, ref LocalMediaReference) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if ref.StorageKey != "" {
		ref.URL = ""
	}
	if ref.URL != "" && !strings.HasPrefix(ref.URL, "data:") {
		// Forwarded references are validated and fetched by BeefAPI. Do not
		// require this desktop's DNS/network route to fetch the same URL.
		parsed, err := url.Parse(ref.URL)
		if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return "", errors.New("参考素材需要可访问的 HTTPS 链接")
		}
		if ref.Kind == "image" && ref.Role != "source" {
			return ref.URL, nil
		}
		// Measured video/audio and upscale sources must be finalized by the
		// upload-ticket validator.
		body, mime, size, err := c.openRemoteReference(ctx, ref.URL, ref.MaxBytes)
		if err != nil {
			return "", err
		}
		defer body.Close()
		copy := *c
		copy.Open = func(context.Context, string) (io.ReadCloser, string, int64, error) { return body, mime, size, nil }
		ref.URL, ref.StorageKey, ref.MIME = "", "remote-reference", mime
		return copy.UploadReference(ctx, ref)
	}
	mime := ref.MIME
	inline := ref.DataURL
	if inline == "" {
		inline = ref.URL
	}
	var source mediaReadSeekerAt
	if strings.HasPrefix(inline, "data:") {
		parts := strings.SplitN(inline, ",", 2)
		if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
			return "", errors.New("参考素材编码无效")
		}
		data, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil {
			return "", err
		}
		source = bytes.NewReader(data)
		mime = strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
	} else {
		if c.Open == nil || ref.StorageKey == "" {
			return "", errors.New("参考素材无法读取")
		}
		body, contentType, knownBytes, err := c.Open(ctx, ref.StorageKey)
		if err != nil {
			return "", err
		}
		defer body.Close()
		if ref.MaxBytes > 0 && knownBytes > ref.MaxBytes {
			return "", errors.New("参考素材超过当前模型文件大小限制")
		}
		if mime == "" {
			mime = contentType
		}
		if seekable, ok := body.(mediaReadSeekerAt); ok {
			source = seekable
		} else {
			// Some owned resources are remote streams. Spool only these sources; local
			// files are hashed and uploaded directly with bounded buffers.
			file, err := os.CreateTemp("", "beeftv-media-*")
			if err != nil {
				return "", err
			}
			defer os.Remove(file.Name())
			defer file.Close()
			reader := io.Reader(mediaContextReader{ctx, body})
			if ref.MaxBytes > 0 {
				reader = io.LimitReader(reader, ref.MaxBytes+1)
			}
			size, err := io.Copy(file, reader)
			if err != nil {
				return "", err
			}
			if ref.MaxBytes > 0 && size > ref.MaxBytes {
				return "", errors.New("参考素材超过当前模型文件大小限制")
			}
			source = file
		}
	}
	if _, err := source.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	digest := sha256.New()
	reader := io.Reader(mediaContextReader{ctx, source})
	if ref.MaxBytes > 0 {
		reader = io.LimitReader(reader, ref.MaxBytes+1)
	}
	size, err := io.Copy(digest, reader)
	if err != nil {
		return "", err
	}
	if size == 0 {
		return "", errors.New("参考素材为空")
	}
	if ref.MaxBytes > 0 && size > ref.MaxBytes {
		return "", errors.New("参考素材超过当前模型文件大小限制")
	}
	header := make([]byte, min(size, 512))
	if _, err := source.ReadAt(header, 0); err != nil && err != io.EOF {
		return "", err
	}
	detected := detectMediaContentType(header)
	if strings.HasPrefix(detected, ref.Kind+"/") {
		mime = detected
	}
	mime = normalizeReferenceMime(ref.Kind, mime)
	if ref.Kind == "image" && isTranscodableImageMime(mime) {
		pngData, transcodeErr := transcodeImageReferenceToPNG(ctx, source, size)
		if transcodeErr != nil || len(pngData) == 0 {
			label := strings.TrimSpace(ref.Role)
			if label == "" {
				label = "参考图片"
			}
			return "", fmt.Errorf("%s为 AVIF/HEIC 等暂不支持的格式，请转换为 PNG、JPEG 或 WebP 后重试", label)
		}
		source = bytes.NewReader(pngData)
		size = int64(len(pngData))
		if ref.MaxBytes > 0 && size > ref.MaxBytes {
			return "", errors.New("参考素材超过当前模型文件大小限制")
		}
		digest.Reset()
		_, _ = digest.Write(pngData)
		mime = "image/png"
	}
	if !strings.HasPrefix(mime, ref.Kind+"/") {
		return "", errors.New("参考素材格式与类型不一致")
	}
	if c.InspectReference != nil {
		if err := c.InspectReference(ctx, ref, source, size, mime); err != nil {
			return "", err
		}
	}
	hash := hex.EncodeToString(digest.Sum(nil))
	session, err := c.CreateUpload(ctx, UploadRequest{Kind: ref.Kind, Bytes: size, Mime: mime, SHA256: hash})
	if err != nil {
		return "", err
	}
	uploaded, err := c.CompleteUploadSource(ctx, session, source, size, ref.Role)
	if err != nil {
		return "", err
	}
	if uploaded.Kind != ref.Kind || uploaded.Bytes != size || uploaded.SHA256 != hash || !strings.HasPrefix(uploaded.Mime, ref.Kind+"/") {
		return "", uploadError(withUploadMeta(ctx, "complete", 1), ErrUploadIncomplete)
	}
	if c.ReferenceUploaded != nil {
		c.ReferenceUploaded(ref, uploaded)
	}
	return uploaded.URL, nil
}

type mediaReferenceFile struct{ *os.File }

func (f mediaReferenceFile) Close() error {
	err := f.File.Close()
	_ = os.Remove(f.Name())
	return err
}

func (c *MediaClient) openRemoteReference(ctx context.Context, raw string, maxBytes int64) (mediaReferenceFile, string, int64, error) {
	if maxBytes <= 0 {
		return mediaReferenceFile{}, "", 0, errors.New("参考素材缺少下载大小限制")
	}
	ctx = c.networkContext(ctx)
	if err := c.validURLContext(ctx, raw); err != nil {
		return mediaReferenceFile{}, "", 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return mediaReferenceFile{}, "", 0, err
	}
	response, err := c.storageClient("参考素材重定向次数过多").Do(req)
	if err != nil {
		return mediaReferenceFile{}, "", 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maxBytes {
		return mediaReferenceFile{}, "", 0, errors.New("参考素材无法下载或超过文件大小限制")
	}
	file, err := os.CreateTemp("", "beeftv-reference-*")
	if err != nil {
		return mediaReferenceFile{}, "", 0, err
	}
	result := mediaReferenceFile{file}
	size, err := io.Copy(file, io.LimitReader(mediaContextReader{ctx, response.Body}, maxBytes+1))
	if err == nil && size > maxBytes {
		err = errors.New("参考素材超过文件大小限制")
	}
	if err == nil && size == 0 {
		err = errors.New("参考素材为空")
	}
	if err != nil {
		_ = result.Close()
		return mediaReferenceFile{}, "", 0, err
	}
	return result, response.Header.Get("Content-Type"), size, nil
}

func detectMediaContentType(header []byte) string {
	if len(header) >= 4 && ((header[0] == 'I' && header[1] == 'I' && header[2] == '*' && header[3] == 0) || (header[0] == 'M' && header[1] == 'M' && header[2] == 0 && header[3] == '*')) {
		return "image/tiff"
	}
	if len(header) >= 12 && string(header[4:8]) == "ftyp" {
		switch string(header[8:12]) {
		case "avif", "avis":
			return "image/avif"
		case "heic", "heix", "mif1", "msf1":
			return "image/heic"
		case "qt  ":
			return "video/quicktime"
		}
	}
	return strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(header), ";")[0]))
}

func normalizeReferenceMime(kind, raw string) string {
	mime := strings.ToLower(strings.TrimSpace(raw))
	if semi := strings.IndexByte(mime, ';'); semi >= 0 {
		mime = strings.TrimSpace(mime[:semi])
	}
	if kind == "image" {
		switch mime {
		case "image/jpg", "image/pjpeg":
			return "image/jpeg"
		case "image/x-png":
			return "image/png"
		case "image/x-bmp":
			return "image/bmp"
		}
	}
	return mime
}

func isTranscodableImageMime(mime string) bool {
	switch mime {
	case "image/avif", "image/heic", "image/heif", "image/x-icon", "image/vnd.microsoft.icon":
		return true
	default:
		return false
	}
}

func transcodeImageReferenceToPNG(ctx context.Context, source io.ReaderAt, size int64) ([]byte, error) {
	ffmpeg, err := mediatools.ResolveFFmpeg()
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp("", "beeftv-ref-img-*")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, io.NewSectionReader(source, 0, size)); err != nil {
		_ = tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-v", "error",
		"-i", tmpPath,
		"-frames:v", "1",
		"-f", "image2pipe",
		"-vcodec", "png",
		"-",
	)
	mediatools.HideConsole(cmd)
	return cmd.Output()
}
