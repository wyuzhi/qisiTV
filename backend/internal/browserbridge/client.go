package browserbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address    string `json:"address"`
	AgentToken string `json:"agentToken"`
}

func ConfigPath() (string, error) {
	if root := os.Getenv("QISITV_CONNECT_CONFIG_DIR"); root != "" {
		if !filepath.IsAbs(root) {
			return "", errors.New("QISITV_CONNECT_CONFIG_DIR must be an absolute directory")
		}
		return filepath.Join(root, "connection.json"), nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "qisitv-connect", "connection.json"), nil
}
func SaveConfig(address string) (Config, error) {
	path, err := ConfigPath()
	if err != nil {
		return Config{}, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return Config{}, err
	}
	agentToken := randomToken(32)
	if previous, err := LoadConfig(); err == nil {
		// MCP stdio can outlive the listener. Restarting the listener revokes browser
		// pairings, but must not strand an already configured local MCP client.
		agentToken = previous.AgentToken
	}
	config := Config{Address: address, AgentToken: agentToken}
	data, _ := json.Marshal(config)
	file, err := os.CreateTemp(filepath.Dir(path), ".connection-*")
	if err != nil {
		return Config{}, err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return Config{}, err
	}
	if err = file.Close(); err != nil {
		return Config{}, err
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return Config{}, err
	}
	return config, nil
}
func LoadConfig() (Config, error) {
	path, err := ConfigPath()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, errors.New("qisiTV MCP has not started yet; enable qisitv-web in your Agent")
	}
	var config Config
	if json.Unmarshal(data, &config) != nil || len(config.AgentToken) < 32 {
		return Config{}, errors.New("invalid qisiTV MCP configuration; restart qisitv-web")
	}
	parsed, err := url.Parse(config.Address)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return Config{}, errors.New("connector address must be a plain loopback HTTP origin")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return Config{}, errors.New("invalid connector port")
	}
	return config, nil
}

type Client struct {
	config Config
	http   *http.Client
}

func NewClient(config Config) *Client {
	return &Client{config: config, http: &http.Client{Timeout: 110 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("connector redirects are forbidden") }}}
}
func (c *Client) Request(ctx context.Context, method, path string, body any) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.Address+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.AgentToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &RPCError{Code: "CONNECTOR_UNAVAILABLE", Message: "Local qisiTV service did not respond. Restart qisitv-web in your Agent; do not retry uncertain writes automatically."}
	}
	defer resp.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(io.LimitReader(resp.Body, maxMessageBytes)).Decode(&result); err != nil {
		return nil, errors.New("invalid connector response")
	}
	if raw, ok := result["error"].(map[string]any); ok {
		code, _ := raw["code"].(string)
		message, _ := raw["message"].(string)
		return nil, &RPCError{Code: code, Message: message}
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("connector returned HTTP %d", resp.StatusCode)
	}
	return result, nil
}
func (c *Client) Call(ctx context.Context, operation string, args map[string]any) (any, error) {
	if args == nil {
		args = map[string]any{}
	}
	if err := validateArgs(operation, args, false); err != nil {
		return nil, err
	}
	if operation == "qisitv_pair" {
		result, err := c.Request(ctx, http.MethodPost, "/agent/pair-code", map[string]any{})
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"code": result["code"], "expiresAt": result["expiresAt"],
			"website":      "https://cheeser.link/qisitv/#/local",
			"instructions": "Open the website in desktop Chrome or Edge, choose your project folder, and enter this one-use pairing code. Allow local network access if your browser asks. Keep the website and this Agent open. You do not need a separate connector window. The code expires after 10 minutes; after refreshing the page, call qisitv_pair again. No paid generation is submitted by pairing.",
		}, nil
	}
	if operation == "asset_import" {
		copy := make(map[string]any, len(args)+3)
		for key, value := range args {
			copy[key] = value
		}
		args = copy
		if err := prepareAsset(args); err != nil {
			return nil, err
		}
	}
	reply, err := c.Request(ctx, http.MethodPost, "/agent/call", map[string]any{"operation": operation, "args": args})
	if err != nil {
		return nil, err
	}
	return reply["result"], nil
}
func prepareAsset(args map[string]any) error {
	path, _ := args["path"].(string)
	if !filepath.IsAbs(path) {
		return errors.New("asset_import path must be absolute")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("cannot open the selected media file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("asset_import accepts regular media files only")
	}
	if info.Size() == 0 || info.Size() > MaxAssetBytes {
		return errors.New("media file must be between 1 byte and 32 MiB; import larger media from the website")
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxAssetBytes+1))
	if err != nil || len(data) > MaxAssetBytes {
		return errors.New("could not read media within the 32 MiB limit")
	}
	kind, _ := args["kind"].(string)
	mimeType := http.DetectContentType(data)
	if mimeType == "application/octet-stream" {
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	}
	if !strings.HasPrefix(mimeType, kind+"/") {
		return errors.New("selected file must have a supported image, video or audio media type matching kind")
	}
	delete(args, "path")
	args["name"], args["mime"], args["base64"] = filepath.Base(path), mimeType, base64.StdEncoding.EncodeToString(data)
	return nil
}
