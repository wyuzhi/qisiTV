package beeftv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const MediaProtocolHeader = "X-BeefAPI-Media-Protocol"
const MediaProtocolVersion = "managed-media-v1"

type MediaDiscovery struct {
	Version              string                          `json:"version"`
	SupportedMediaTypes  []string                        `json:"supported_media_types"`
	TaskSubmitURL        string                          `json:"task_submit_url"`
	TaskQueryURLTemplate string                          `json:"task_query_url_template"`
	UploadsURL           string                          `json:"uploads_url"`
	Models               map[string]MediaModelCapability `json:"-"`
}

type MediaCapability struct {
	Operations     []string `json:"operations"`
	Options        []string `json:"options"`
	ReferenceKinds []string `json:"reference_kinds"`
	MaxOutputs     int      `json:"max_outputs"`
	PromptMaxChars int      `json:"prompt_max_chars,omitempty"`
}

type MediaModelCapability struct {
	Version      string                     `json:"media_capabilities_version"`
	Capabilities map[string]MediaCapability `json:"media_capabilities"`
}
type MediaReference struct {
	Kind string `json:"kind"`
	Role string `json:"role"`
	URL  string `json:"url"`
}
type LocalMediaReference struct {
	MediaReference
	StorageKey string
	DataURL    string
	MIME       string
	Bytes      int64
	MaxBytes   int64
}
type MediaRequest struct {
	TaskRef   string `json:"task_ref"`
	MediaType string `json:"media_type"`
	Model     string `json:"model"`
	Operation string `json:"operation"`
	Input     struct {
		Prompt     string           `json:"prompt"`
		References []MediaReference `json:"references,omitempty"`
	} `json:"input"`
	Options map[string]any `json:"options,omitempty"`
}
type MediaOutput struct {
	Kind     string         `json:"kind"`
	URL      string         `json:"url"`
	Metadata map[string]any `json:"metadata,omitempty"`
}
type MediaReceipt struct {
	Format    string `json:"format"`
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}
type MediaTaskError struct {
	Code     string `json:"code"`
	Category string `json:"category"`
	Message  string `json:"message"`
	TaskID   string `json:"task_id,omitempty"`
}

func (e *MediaTaskError) Error() string { return e.Message }

// Pending 表示 BeefTV 还没有给出这次提交的结论（结果未确认或仍在保存），
// 只能继续按同一个 task_ref 查询。其余任务错误都是 BeefTV 对这次提交的最终结论。
// 判断托管媒体错误是否终态只读这里，不在调用方另列错误码。
func (e *MediaTaskError) Pending() bool {
	return e.Code == "media_result_unknown" || e.Code == "media_delivery_pending"
}

// IsTerminalMediaTaskError 表示 BeefTV 已对这次提交给出最终的失败结论。
func IsTerminalMediaTaskError(err error) bool {
	var task *MediaTaskError
	return errors.As(err, &task) && !task.Pending()
}

// IsDefiniteMediaRejection 表示 BeefTV 明确拒绝了这次请求：4xx，
// 但超时、冲突、过早和限流除外（这几种只代表暂时没处理，原请求仍可能成立）。
func IsDefiniteMediaRejection(err error) bool {
	var httpErr *MediaHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	switch httpErr.StatusCode {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusTooEarly, http.StatusTooManyRequests:
		return false
	}
	return httpErr.StatusCode >= 400 && httpErr.StatusCode < 500
}

// MediaTaskMissingError 是查询原编号得到的 404：用这把 Key 查不到这个编号的提交记录。
// BeefTV 说明它不能单独证明「没提交过」（记录存在但当前不可见时也会返回 404），
// 所以它不是 MediaHTTPError，不会被当成「明确被拒」。提交时的 404 仍是 MediaHTTPError。
type MediaTaskMissingError struct {
	Code      string
	RequestID string
}

func (e *MediaTaskMissingError) Error() string { return "BeefTV 查不到这个编号的提交记录" }

// IsMediaTaskNotFound 表示查询原编号时 BeefTV 查不到这次提交。
func IsMediaTaskNotFound(err error) bool {
	var missing *MediaTaskMissingError
	return errors.As(err, &missing)
}

// IsIdempotencyConflict 表示这个编号已被内容不同的另一次提交占用。
func IsIdempotencyConflict(err error) bool {
	var httpErr *MediaHTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusConflict && httpErr.TaskError.Code == "idempotency_conflict"
}

type MediaTask struct {
	TaskRef           string          `json:"task_ref"`
	MediaType         string          `json:"media_type"`
	Status            string          `json:"status"`
	TaskID            string          `json:"task_id,omitempty"`
	Outputs           []MediaOutput   `json:"outputs"`
	Metadata          map[string]any  `json:"metadata,omitempty"`
	Usage             json.RawMessage `json:"usage,omitempty"`
	BillingState      *string         `json:"billing_state,omitempty"`
	UsageState        *string         `json:"usage_state,omitempty"`
	Quota             *int64          `json:"quota,omitempty"`
	ReservedQuota     *int64          `json:"reserved_quota,omitempty"`
	ChargedQuota      *int64          `json:"charged_quota,omitempty"`
	AdjustmentQuota   *int64          `json:"adjustment_quota,omitempty"`
	ReconcileDeadline *int64          `json:"reconcile_deadline,omitempty"`
	ResultReceipt     *MediaReceipt   `json:"result_receipt,omitempty"`
	Error             *MediaTaskError `json:"error,omitempty"`
}

// State only fences the first send and stores the original attempt identity.
// Provider recovery and dispatch retries belong to the API, never this client.
type MediaStatePort interface {
	Sent(context.Context) (bool, error)
	Begin(*http.Request) (alreadySent bool, err error)
}
type MediaProjectionPort interface {
	Project(context.Context, MediaTask)
}
type MediaClient struct {
	BaseURL            string
	APIKey             string
	Headers            http.Header
	Client             *http.Client
	AllowHTTPTest      bool
	State              MediaStatePort
	Open               func(context.Context, string) (io.ReadCloser, string, int64, error)
	Progress           func(label string, loaded, total int64, phase string)
	Observe            func(*http.Request, *http.Response, []byte, error)
	StorageObserve     func(UploadObservation)
	InspectReference   func(context.Context, LocalMediaReference, io.ReaderAt, int64, string) error
	ReferenceUploaded  func(LocalMediaReference, UploadedMedia)
	Poll               func(context.Context) error
	Project            func(context.Context, MediaTask)
	ExpectedOutputKind string
	discovery          *MediaDiscovery
}

func (c *MediaClient) endpoint(path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil || base.Host == "" || base.User != nil {
		return "", errors.New("模型服务地址无效")
	}
	if !strings.HasSuffix(base.Path, "/v1") {
		base.Path = strings.TrimRight(base.Path, "/") + "/v1"
	}
	if strings.HasPrefix(path, "/v1/") {
		path = strings.TrimPrefix(path, "/v1")
	}
	escaped := strings.TrimRight(base.EscapedPath(), "/") + "/" + strings.TrimLeft(path, "/")
	decoded, err := url.PathUnescape(escaped)
	if err != nil {
		return "", err
	}
	base.Path, base.RawPath = decoded, escaped
	base.RawQuery, base.Fragment = "", ""
	return base.String(), nil
}
func (c *MediaClient) httpClient() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return outbound.OutboundHTTPClient(5 * time.Minute)
}
func (c *MediaClient) validURL(raw string) error {
	return c.validURLContext(context.Background(), raw)
}
func (c *MediaClient) validURLContext(ctx context.Context, raw string) error {
	if !c.AllowHTTPTest {
		_, err := outbound.ValidatePublicHTTPSURLContext(ctx, raw)
		return err
	}
	u, err := outbound.ValidateOutboundURLContext(ctx, raw)
	if err != nil {
		return err
	}
	if u.User != nil || (u.Scheme != "https" && !(c.AllowHTTPTest && u.Scheme == "http")) {
		return errors.New("媒体地址需要安全的 HTTPS 链接")
	}
	return nil
}
func (c *MediaClient) request(ctx context.Context, method, path string, body any) (*http.Request, error) {
	ctx = c.networkContext(ctx)
	raw, err := c.endpoint(path)
	if err != nil {
		return nil, err
	}
	if err = c.validURLContext(ctx, raw); err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		data, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, raw, reader)
	if err != nil {
		return nil, err
	}
	for name, values := range c.Headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	for _, key := range []string{"Idempotency-Key", "X-Idempotency-Key", "Content-Length", "Transfer-Encoding"} {
		req.Header.Del(key)
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set(MediaProtocolHeader, MediaProtocolVersion)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.GetBody = nil
	return req, nil
}

func (c *MediaClient) networkContext(ctx context.Context) context.Context {
	if !c.AllowHTTPTest {
		return outbound.WithPublicHTTPS(ctx)
	}
	return ctx
}
func (c *MediaClient) send(req *http.Request, limit int64) ([]byte, http.Header, error) {
	client := *c.httpClient()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c.sendWith(&client, req, limit)
}

func (c *MediaClient) sendWith(client *http.Client, req *http.Request, limit int64) ([]byte, http.Header, error) {
	resp, err := client.Do(req)
	var data []byte
	if err == nil {
		defer resp.Body.Close()
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err == nil && int64(len(data)) > limit {
			err = errors.New("媒体服务控制响应过大")
		}
		if err == nil && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
			var envelope struct {
				Error MediaTaskError `json:"error"`
			}
			_ = json.Unmarshal(data, &envelope)
			if envelope.Error.Message == "" {
				envelope.Error.Message = fmt.Sprintf("媒体服务请求未能确认（HTTP %d）", resp.StatusCode)
			}
			err = &MediaHTTPError{StatusCode: resp.StatusCode, TaskError: envelope.Error, Body: string(data), RequestID: resp.Header.Get("X-Request-Id")}
		}
	}
	if c.Observe != nil {
		c.Observe(req, resp, data, err)
	}
	if resp != nil {
		return data, resp.Header, err
	}
	return data, nil, err
}

type MediaHTTPError struct {
	StatusCode int
	TaskError  MediaTaskError
	Body       string
	RequestID  string
}

func (e *MediaHTTPError) Error() string { return e.TaskError.Message }

// MediaDiscoveryTransportError 表示 /v1/models 协议探测在收到 HTTP 响应前因网络传输失败，
// 本次业务请求尚未发出。判断探测是否属于未发出的传输层失败只看这里。
type MediaDiscoveryTransportError struct{ Cause error }

func (e MediaDiscoveryTransportError) Error() string { return e.Cause.Error() }
func (e MediaDiscoveryTransportError) Unwrap() error { return e.Cause }

func IsDiscoveryTransportError(err error) bool {
	var target MediaDiscoveryTransportError
	return errors.As(err, &target)
}

func wrapDiscoveryTransportError(err error) error {
	var httpErr *MediaHTTPError
	var urlErr *url.Error
	var netErr net.Error
	if !errors.As(err, &httpErr) && (errors.As(err, &urlErr) || errors.As(err, &netErr) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)) {
		return MediaDiscoveryTransportError{Cause: err}
	}
	return err
}

func (c *MediaClient) Discover(ctx context.Context) (MediaDiscovery, error) {
	if c.discovery != nil {
		return *c.discovery, nil
	}
	var data []byte
	var header http.Header
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		var req *http.Request
		req, err = c.request(ctx, http.MethodGet, "/models", nil)
		if err != nil {
			return MediaDiscovery{}, err
		}
		data, header, err = c.send(req, 4<<20)
		if err == nil || ctx.Err() != nil || !retryUploadControl(err) || attempt == 2 {
			break
		}
		if err = uploadPause(ctx, attempt); err != nil {
			return MediaDiscovery{}, wrapDiscoveryTransportError(err)
		}
	}
	if err != nil {
		return MediaDiscovery{}, wrapDiscoveryTransportError(err)
	}
	var payload struct {
		MediaProtocol MediaDiscovery `json:"media_protocol"`
		Data          []struct {
			ID string `json:"id"`
			MediaModelCapability
		} `json:"data"`
	}
	if json.Unmarshal(data, &payload) != nil || header.Get(MediaProtocolHeader) != MediaProtocolVersion || payload.MediaProtocol.Version != MediaProtocolVersion {
		return MediaDiscovery{}, errors.New("模型服务暂不支持当前媒体协议，本次尚未开始生成")
	}
	d := payload.MediaProtocol
	if d.TaskSubmitURL != "/v1/media/tasks" || d.TaskQueryURLTemplate != "/v1/media/tasks/{task_ref}" || d.UploadsURL != "/v1/media/uploads" {
		return MediaDiscovery{}, errors.New("媒体服务任务接口声明无效，本次尚未开始生成")
	}
	d.Models = make(map[string]MediaModelCapability, len(payload.Data))
	for _, model := range payload.Data {
		d.Models[model.ID] = model.MediaModelCapability
	}
	c.discovery = &d
	return d, nil
}

func (c *MediaClient) Execute(ctx context.Context, request MediaRequest, refs []LocalMediaReference) (map[string]any, error) {
	if request.TaskRef == "" || c.State == nil {
		return nil, errors.New("媒体任务缺少持久化提交身份")
	}
	// Consult the existing send fence before opening a reference. A restart can
	// collect the task even after the original local files have been deleted.
	sent, err := c.State.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if sent {
		return c.Wait(ctx, request.TaskRef, request.MediaType, false)
	}
	d, err := c.Discover(ctx)
	if err != nil {
		return nil, err
	}
	supported := false
	for _, kind := range d.SupportedMediaTypes {
		if kind == request.MediaType {
			supported = true
		}
	}
	if !supported {
		return nil, errors.New("媒体服务尚未支持当前任务类型")
	}
	if request.MediaType == "audio" || request.MediaType == "upscale" {
		model := d.Models[request.Model]
		capability, ok := model.Capabilities[request.MediaType]
		if !ok || model.Version == "" || capability.MaxOutputs != 1 || !mediaStringMember(capability.Operations, request.Operation) {
			return nil, errors.New("当前模型尚未声明所选媒体操作，本次尚未提交")
		}
		for key := range request.Options {
			if !mediaStringMember(capability.Options, key) {
				return nil, fmt.Errorf("当前模型未声明参数 %s，本次尚未提交", key)
			}
		}
		for _, ref := range refs {
			if !mediaStringMember(capability.ReferenceKinds, ref.Kind) {
				return nil, errors.New("当前模型不接受所选参考素材类型，本次尚未提交")
			}
		}
	}
	for _, ref := range refs {
		link, err := c.UploadReference(ctx, ref)
		if err != nil {
			return nil, err
		}
		if err := c.validURLContext(ctx, link); err != nil {
			return nil, errors.New("媒体参考素材需要 HTTPS 链接")
		}
		request.Input.References = append(request.Input.References, MediaReference{Kind: ref.Kind, Role: ref.Role, URL: link})
	}
	// Fixed content options only; stale protocol/plugin settings never enter wire.
	for _, key := range []string{"response_format", "model", "task_ref", "references", "image", "images", "mask", "transport", "protocol"} {
		delete(request.Options, key)
	}
	req, err := c.request(ctx, http.MethodPost, d.TaskSubmitURL, request)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Idempotency-Key", request.TaskRef)
	already, err := c.State.Begin(req)
	if err != nil {
		return nil, err
	}
	if !already {
		data, _, sendErr := c.send(req, 4<<20)
		if sendErr == nil {
			task, decodeErr := decodeMediaTask(data, request.TaskRef, request.MediaType)
			if decodeErr == nil && c.Project != nil {
				c.Project(ctx, task)
			}
			if decodeErr == nil && task.Status == "completed" {
				return c.Result(ctx, task, false)
			}
			if decodeErr == nil && task.Status == "failed" {
				return nil, task.failure()
			}
		} else if IsDefiniteMediaRejection(sendErr) {
			return nil, sendErr
		}
		// Any dispatched result, including 429 or a lost response, is observed by
		// GET thereafter. Never automatically create another request/key here.
	}
	return c.Wait(ctx, request.TaskRef, request.MediaType, false)
}

func mediaStringMember(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func decodeMediaTask(data []byte, ref, kind string) (MediaTask, error) {
	var task MediaTask
	if json.Unmarshal(data, &task) != nil || task.TaskRef != ref || task.MediaType != kind {
		return task, errors.New("媒体任务响应身份不一致")
	}
	return task, nil
}

// Resubmit 把发出前冻结的原始提交请求原样再发一次：同一地址、同一请求头
// （原 Key 与 Idempotency-Key）、同一请求体。BeefTV 按编号去重，收到过就返回
// 原任务，没收到才第一次执行，所以不会产生第二次付费生成。
func (c *MediaClient) Resubmit(ctx context.Context, rawURL string, header http.Header, body []byte, ref, kind string) (MediaTask, error) {
	if ref == "" || strings.TrimSpace(header.Get("Idempotency-Key")) != ref {
		return MediaTask{}, errors.New("原请求的提交编号与任务不一致，不能补交")
	}
	ctx = c.networkContext(ctx)
	if err := c.validURLContext(ctx, rawURL); err != nil {
		return MediaTask{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return MediaTask{}, err
	}
	req.Header = header.Clone()
	req.Header.Del("Content-Length")
	req.GetBody = nil
	data, _, err := c.send(req, 4<<20)
	if err != nil {
		return MediaTask{}, err
	}
	task, err := decodeMediaTask(data, ref, kind)
	if err == nil && c.Project != nil {
		c.Project(ctx, task)
	}
	return task, err
}

func (c *MediaClient) Query(ctx context.Context, ref, kind string) (MediaTask, error) {
	if ref == "" {
		return MediaTask{}, errors.New("媒体任务编号为空")
	}
	req, err := c.request(ctx, http.MethodGet, "/media/tasks/"+url.PathEscape(ref), nil)
	if err != nil {
		return MediaTask{}, err
	}
	q := req.URL.Query()
	q.Set("media_type", kind)
	req.URL.RawQuery = q.Encode()
	data, _, err := c.send(req, 4<<20)
	if httpErr := (*MediaHTTPError)(nil); errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
		return MediaTask{}, &MediaTaskMissingError{Code: httpErr.TaskError.Code, RequestID: httpErr.RequestID}
	}
	if err != nil {
		return MediaTask{}, err
	}
	task, err := decodeMediaTask(data, ref, kind)
	if err == nil && c.Project != nil {
		c.Project(ctx, task)
	}
	return task, err
}
func (c *MediaClient) Wait(ctx context.Context, ref, kind string, legacy bool) (map[string]any, error) {
	return c.wait(ctx, ref, kind, legacy, false)
}

// Collect 与 Wait 相同，但 BeefTV 查不到这个编号时立即返回 404，交给调用方处理。
// 只给恢复路径用：那时原请求早已发出。刚发出请求时查不到可能是请求还在路上，
// 所以生成过程仍用 Wait。
func (c *MediaClient) Collect(ctx context.Context, ref, kind string, legacy bool) (map[string]any, error) {
	return c.wait(ctx, ref, kind, legacy, true)
}

func (c *MediaClient) wait(ctx context.Context, ref, kind string, legacy, stopWhenMissing bool) (map[string]any, error) {
	for {
		task, err := c.Query(ctx, ref, kind)
		if stopWhenMissing && IsMediaTaskNotFound(err) {
			return nil, err
		}
		if err == nil {
			switch task.Status {
			case "completed":
				return c.Result(ctx, task, legacy)
			case "failed":
				return nil, task.failure()
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if c.Poll != nil {
			if err = c.Poll(ctx); err != nil {
				return nil, err
			}
		} else {
			timer := time.NewTimer(2500 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
	}
}
func (t MediaTask) failure() error {
	if t.Error != nil {
		err := *t.Error
		if err.TaskID == "" {
			err.TaskID = t.TaskID
		}
		return &err
	}
	return &MediaTaskError{Code: "media_task_failed", Category: "upstream", TaskID: t.TaskID, Message: "媒体生成失败，请保留原任务查询结算"}
}
