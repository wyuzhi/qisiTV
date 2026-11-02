package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpMediaReturnsImageContent uploads a real PNG to the isolated workspace,
// places it on a canvas node and reads it through the official MCP client.
// External agents can only see the picture when it arrives as an image block.
func mcpMediaReturnsImageContent(t *testing.T, bin, base string) {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for x := 0; x < 64; x++ {
		for y := 0; y < 48; y++ {
			picture.Set(x, y, color.RGBA{R: uint8(x * 4), G: 120, B: uint8(y * 5), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	resourceID := uploadTestResource(t, base, "mcp-media.png", encoded.Bytes())
	// 和产品流程一致：先写素材库记录，画布节点再引用它。
	const assetID = "integrated-mcp-media-asset"
	ownerJSON(t, http.MethodPut, base+"/assets/"+assetID, map[string]any{"asset": map[string]any{"id": assetID, "kind": "image", "title": "MCP 看图", "coverUrl": "", "tags": []string{},
		"data": map[string]any{"content": "resource:" + resourceID, "storageKey": "resource:" + resourceID, "resourceId": resourceID, "width": 64, "height": 48, "bytes": encoded.Len(), "mimeType": "image/png"}}})
	const canvasID = "integrated-mcp-media-canvas"
	body, _ := json.Marshal(map[string]any{"project": map[string]any{"id": canvasID, "title": "MCP 看图", "revision": 0, "connections": []any{},
		"nodes": []any{map[string]any{"id": "img-1", "type": "image", "title": "参考图", "position": map[string]any{"x": 0, "y": 0}, "width": 420, "height": 315,
			"metadata": map[string]any{"content": "resource:" + resourceID, "storageKey": "resource:" + resourceID, "assetId": assetID, "status": "success"}}}}})
	request, _ := http.NewRequest(http.MethodPut, base+"/canvas-projects/"+canvasID, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Beeftv-Owner", os.Getenv("BEEFTV_OWNER_TOKEN"))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	failure, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("seed media canvas: %d %s", response.StatusCode, failure)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "media-acceptance", Version: "1"}, nil).Connect(ctx, &mcp.CommandTransport{Command: exec.Command(bin, "mcp", "serve")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "media.overview", Arguments: map[string]any{"canvasId": canvasID, "nodeId": "img-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("media.overview failed: %s", toolText(result))
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("first block must be facts text, got %T", result.Content[0])
	}
	var images int
	for _, block := range result.Content[1:] {
		if img, ok := block.(*mcp.ImageContent); ok && strings.HasPrefix(img.MIMEType, "image/") && len(img.Data) > 0 {
			images++
			if strings.Contains(text.Text, base64.StdEncoding.EncodeToString(img.Data)) {
				t.Fatal("image bytes are still inside the text block")
			}
		}
	}
	if images == 0 {
		t.Fatalf("media.overview returned no image block: %s", text.Text)
	}
	if !strings.Contains(text.Text, resourceID) {
		t.Fatalf("facts text lost the resource identity: %s", text.Text)
	}
}

func uploadTestResource(t *testing.T, base, name string, data []byte) string {
	t.Helper()
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = writer.WriteField("kind", "image")
	_ = writer.Close()
	request, _ := http.NewRequest(http.MethodPost, base+"/resources", &form)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-Beeftv-Owner", os.Getenv("BEEFTV_OWNER_TOKEN"))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Resource struct {
				ID string `json:"id"`
			} `json:"resource"`
		} `json:"data"`
		Msg string `json:"msg"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil || envelope.Code != 0 || envelope.Data.Resource.ID == "" {
		t.Fatalf("upload resource: status=%d code=%d msg=%s err=%v", response.StatusCode, envelope.Code, envelope.Msg, err)
	}
	return envelope.Data.Resource.ID
}

func ownerJSON(t *testing.T, method, url string, payload any) {
	t.Helper()
	body, _ := json.Marshal(payload)
	request, _ := http.NewRequest(method, url, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Beeftv-Owner", os.Getenv("BEEFTV_OWNER_TOKEN"))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		failure, _ := io.ReadAll(response.Body)
		t.Fatalf("%s %s: %d %s", method, url, response.StatusCode, failure)
	}
}
