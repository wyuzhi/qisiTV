// Package agentbridge is the shared, local-only command boundary for MCP and CLI.
// It always talks to an existing workspace; it never opens another database.
package agentbridge

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
	"os"
	"strings"
	"time"

	"qisitv/backend/internal/brand"
)

const DefaultURL = "http://127.0.0.1:8080/api"
const maxResponseBytes = 24 << 20

type Client struct {
	base  string
	token string
	http  *http.Client
}

// New rejects remote hosts so a mistyped endpoint cannot receive local media or
// a desktop launch token. Redirects are disabled for the same reason.
func New(base, token string) (*Client, error) {
	if base == "" {
		base = DefaultURL
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, errors.New("invalid qisiTV URL")
	}
	ip := net.ParseIP(u.Hostname())
	if (u.Scheme != "http" && u.Scheme != "https") || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("qisiTV URL must be an HTTP(S) loopback URL without credentials, query or fragment")
	}
	base = strings.TrimRight(u.String(), "/")
	if u.Path == "" || u.Path == "/" {
		base += "/api"
	}
	return &Client{base: base, token: token, http: &http.Client{
		Timeout:       90 * time.Second,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func FromEnvironment() (*Client, error) {
	token := brand.Getenv("QISITV_TOKEN")
	if file := brand.Getenv("QISITV_TOKEN_FILE"); file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read qisiTV token file: %w", err)
		}
		token = strings.TrimSpace(string(b))
	}
	return New(brand.Getenv("QISITV_URL"), token)
}

type APIError struct {
	Status  int    `json:"status"`
	Code    int    `json:"code"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("qisiTV HTTP %d / code %d (%s): %s", e.Status, e.Code, e.Reason, e.Message)
}

func (c *Client) request(ctx context.Context, method, path string, body any) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.perform(req)
}

func (c *Client) perform(req *http.Request) (map[string]any, error) {
	if c.token != "" {
		req.Header.Set("X-Desktop-Token", c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect to running qisiTV workspace: %w", err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxResponseBytes {
		return nil, errors.New("qisiTV response exceeds 24 MiB")
	}
	var envelope struct {
		Code   *int            `json:"code"`
		Data   json.RawMessage `json:"data"`
		Msg    string          `json:"msg"`
		Reason string          `json:"reason"`
	}
	if json.Unmarshal(b, &envelope) != nil || envelope.Code == nil {
		return nil, fmt.Errorf("qisiTV returned invalid API envelope (HTTP %d); check QISITV_URL points to its /api", res.StatusCode)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 || *envelope.Code != 0 {
		return nil, &APIError{Status: res.StatusCode, Code: *envelope.Code, Reason: envelope.Reason, Message: envelope.Msg}
	}
	var data any
	if len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, &data); err != nil {
			return nil, fmt.Errorf("invalid qisiTV data: %w", err)
		}
	}
	if object, ok := data.(map[string]any); ok {
		return object, nil
	}
	return map[string]any{"items": data}, nil
}

func idPath(id string) (string, error) {
	if strings.TrimSpace(id) == "" || strings.ContainsAny(id, "/\\?#%") || id == "." || id == ".." {
		return "", errors.New("invalid or empty object ID")
	}
	return url.PathEscape(id), nil
}

func canvasPath(args map[string]any) (string, error) {
	id, err := idPath(stringArg(args, "canvasId"))
	return "/canvas-projects/" + id, err
}

func stringArg(args map[string]any, key string) string { value, _ := args[key].(string); return value }

func objectArg(args map[string]any, key string) map[string]any {
	value, _ := args[key].(map[string]any)
	if value == nil {
		return map[string]any{}
	}
	return value
}

// PublicTask excludes even sanitized provider input from the Agent surface.
func publicTask(task map[string]any) map[string]any {
	delete(task, "inputJson")
	delete(task, "config")
	delete(task, "apiKey")
	if nested, ok := task["task"].(map[string]any); ok {
		publicTask(nested)
	}
	return task
}
