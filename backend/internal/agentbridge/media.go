package agentbridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func number(value any) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		value, _ := n.Float64()
		return value
	default:
		return 0
	}
}

func (c *Client) importAsset(ctx context.Context, args map[string]any) (map[string]any, error) {
	path, err := canvasPath(args)
	if err != nil {
		return nil, err
	}
	// Validate the destination before persisting a resource; the later mutation
	// still uses a revision check if the caller supplied one.
	if _, err = c.request(ctx, http.MethodGet, path, nil); err != nil {
		return nil, err
	}
	filePath := stringArg(args, "path")
	if !filepath.IsAbs(filePath) {
		return nil, errors.New("asset path must be absolute")
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open local media: %w", err)
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() {
		return nil, errors.New("asset path must name a regular file")
	}
	kind := stringArg(args, "kind")
	width, height := int(number(args["width"])), int(number(args["height"]))
	if kind == "image" && (width == 0 || height == 0) {
		if config, _, err := image.DecodeConfig(file); err == nil {
			width, height = config.Width, config.Height
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
	}
	digest := sha256.New()
	if _, err = io.Copy(digest, file); err != nil {
		return nil, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var head bytes.Buffer
	writer := multipart.NewWriter(&head)
	for key, value := range map[string]string{"kind": kind, "width": strconv.Itoa(width), "height": strconv.Itoa(height), "durationMs": strconv.FormatInt(int64(number(args["durationMs"])), 10)} {
		if err = writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	if _, err = writer.CreateFormFile("file", filepath.Base(filePath)); err != nil {
		return nil, err
	}
	header := append([]byte(nil), head.Bytes()...)
	head.Reset()
	if err = writer.Close(); err != nil {
		return nil, err
	}
	trailer := head.Bytes()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/resources", io.MultiReader(bytes.NewReader(header), file, bytes.NewReader(trailer)))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(header)+len(trailer)) + stat.Size()
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Idempotency-Key", "agent-import-"+kind+"-"+hex.EncodeToString(digest.Sum(nil)))
	response, err := c.perform(req)
	if err != nil {
		return nil, err
	}
	resource := objectArg(response, "resource")
	resourceID := stringArg(resource, "id")
	if resourceID == "" {
		return nil, errors.New("upload returned no resource ID")
	}
	title := stringArg(args, "title")
	if title == "" {
		title = filepath.Base(filePath)
	}
	media := map[string]any{"storageKey": "resource:" + resourceID, "url": "/api/resources/" + resourceID + "/file", "width": float64(width), "height": float64(height), "bytes": float64(stat.Size()), "durationMs": args["durationMs"], "mimeType": resource["mimeType"]}
	nodeID := stringArg(args, "nodeId")
	if nodeID == "" {
		nodeID = uuid.NewString()
	}
	node, err := c.importedMediaNode(ctx, kind, title, nodeID, media, stringArg(args, "canvasId"))
	if err != nil {
		return nil, fmt.Errorf("resource %s uploaded, but asset binding failed: %w", resourceID, err)
	}
	if p, ok := args["position"]; ok {
		node["position"] = p
	}
	result, err := c.operations(ctx, path, args, []any{map[string]any{"op": "add", "node": node}})
	if err != nil {
		return nil, fmt.Errorf("media remains in local asset library (resource %s, asset %s); canvas insertion failed: %w", resourceID, stringArg(objectArg(node, "metadata"), "assetId"), err)
	}
	result["resourceId"], result["nodeId"], result["assetId"] = resourceID, nodeID, objectArg(node, "metadata")["assetId"]
	return result, nil
}

func (c *Client) importedMediaNode(ctx context.Context, kind, title, nodeID string, media map[string]any, canvasID string) (map[string]any, error) {
	content := stringArg(media, "url")
	if content == "" {
		content = stringArg(media, "dataUrl")
	}
	key := stringArg(media, "storageKey")
	if key != "" && strings.HasPrefix(key, "resource:") {
		id, err := idPath(strings.TrimPrefix(key, "resource:"))
		if err != nil {
			return nil, err
		}
		content = "/api/resources/" + id + "/file"
	}
	if content == "" && key == "" {
		return nil, errors.New("task output has no media locator")
	}
	identity := key
	if identity == "" {
		identity = content
	}
	// Persisted UUID namespace: retaining it prevents duplicate assets on reimport.
	assetID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("beeftv-agent:"+kind+":"+identity)).String()
	width, height := number(media["width"]), number(media["height"])
	mimeType := stringArg(media, "mimeType")
	if mimeType == "" {
		mimeType = map[string]string{"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}[kind]
	}
	data := map[string]any{"storageKey": key, "width": width, "height": height, "bytes": number(media["bytes"]), "mimeType": mimeType, "durationMs": number(media["durationMs"])}
	if kind == "image" {
		data["dataUrl"] = content
	} else {
		data["url"] = content
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	asset := map[string]any{"id": assetID, "kind": kind, "title": title, "coverUrl": "", "tags": []string{}, "category": "material", "status": "confirmed", "source": "Canvas", "createdAt": now, "updatedAt": now, "data": data, "metadata": map[string]any{"source": "canvas-upload", "canvasId": canvasID, "nodeId": nodeID, "resourceKey": key}}
	if kind == "image" {
		asset["coverUrl"] = content
	}
	if _, err := c.request(ctx, http.MethodPut, "/assets/"+assetID, map[string]any{"asset": asset}); err != nil {
		return nil, err
	}
	displayWidth, displayHeight := 360.0, 240.0
	if width > 0 && height > 0 {
		displayHeight = displayWidth * height / width
	}
	if kind == "audio" {
		displayHeight = 160
	}
	meta := map[string]any{"content": content, "storageKey": key, "assetId": assetID, "status": "success", "mimeType": mimeType, "bytes": number(media["bytes"]), "naturalWidth": width, "naturalHeight": height, "durationMs": number(media["durationMs"])}
	if preview := stringArg(media, "previewUrl"); preview != "" {
		meta["previewUrl"] = preview
	}
	return map[string]any{"id": nodeID, "type": kind, "title": title, "position": map[string]any{"x": 0, "y": 0}, "width": displayWidth, "height": displayHeight, "metadata": meta}, nil
}

func (c *Client) applyTaskResult(ctx context.Context, args map[string]any) (map[string]any, error) {
	taskID, err := idPath(stringArg(args, "taskId"))
	if err != nil {
		return nil, err
	}
	payload := map[string]any{}
	for _, key := range []string{"canvasId", "nodeId", "baseRevision"} {
		if value, exists := args[key]; exists {
			payload[key] = value
		}
	}
	// The backend shares this implementation with automatic completion, so
	// manual recovery cannot duplicate or redirect the original task outputs.
	return c.request(ctx, http.MethodPost, "/agent/tasks/"+taskID+"/apply", payload)
}
