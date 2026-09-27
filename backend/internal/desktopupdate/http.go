package desktopupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func newHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{
		Transport:     transport,
		CheckRedirect: httpsRedirects,
	}
}

func httpsRedirects(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("重定向次数过多")
	}
	if req.URL == nil || req.URL.Scheme != "https" || req.URL.Host == "" {
		return fmt.Errorf("更新地址必须使用 HTTPS")
	}
	return nil
}

func (e *Engine) fetchFeed(ctx context.Context) (Payload, error) {
	data, err := e.getBytes(ctx, e.feedURL, maxFeedBytes, e.feedTimeout)
	if err != nil {
		return Payload{}, err
	}
	payload, _, err := verifyEnvelope(data, e.publicKey)
	if err != nil {
		return Payload{}, err
	}
	return payload, nil
}

func (e *Engine) getBytes(ctx context.Context, rawURL string, maxBytes int64, timeout time.Duration) ([]byte, error) {
	if _, err := normalizeFeedURL(rawURL); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "qisiTV-Desktop-Updater/"+e.currentVersion)
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, mapNetError(err)
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return nil, fmt.Errorf("更新地址必须使用 HTTPS")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("无法获取更新信息")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, mapNetError(err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("更新信息过大")
	}
	return data, nil
}

func (e *Engine) downloadArchive(ctx context.Context, artifact PlatformArtifact, dest string) error {
	if _, err := normalizeFeedURL(artifact.URL); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, e.downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "qisiTV-Desktop-Updater/"+e.currentVersion)
	resp, err := e.client.Do(req)
	if err != nil {
		return mapNetError(err)
	}
	defer resp.Body.Close()
	if resp.TLS == nil {
		return fmt.Errorf("更新地址必须使用 HTTPS")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("无法下载更新包")
	}
	if resp.ContentLength > 0 && resp.ContentLength != artifact.Size {
		return ErrTampered
	}
	file, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	hasher := sha256.New()
	reader := io.TeeReader(&progressReader{r: io.LimitReader(resp.Body, artifact.Size+1), e: e}, hasher)
	written, err := io.Copy(file, reader)
	if err != nil {
		return mapNetError(err)
	}
	if written != artifact.Size {
		return ErrTampered
	}
	if err := file.Sync(); err != nil {
		return err
	}
	sum := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(sum, strings.TrimSpace(artifact.SHA256)) {
		return ErrTampered
	}
	return nil
}

type progressReader struct {
	r io.Reader
	e *Engine
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	if n > 0 {
		p.e.addDownloaded(int64(n))
	}
	return n, err
}

func mapNetError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return ErrTimeout
	}
	if strings.Contains(strings.ToLower(err.Error()), "timeout") || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "context deadline") {
		return ErrTimeout
	}
	return err
}
