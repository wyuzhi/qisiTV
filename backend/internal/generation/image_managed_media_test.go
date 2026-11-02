package generation

import (
	"bytes"
	"context"
	"errors"
	"qisitv/backend/internal/protocol"
	"io"
	"mime"
	"mime/multipart"
	"testing"
)

func TestThirdPartyOpenAIEditPreservesMultipartBytes(t *testing.T) {
	data := []byte("original image bytes")
	spec := protocol.RequestSpec{Path: "/v1/images/edits", ContentType: "multipart/form-data", Body: map[string]any{"model": "gpt-image-2", "response_format": "b64_json"}, Files: []protocol.RequestFilePart{{Name: "image", Filename: "source.png", Reference: protocol.MediaReference{DataURL: DataURL("image/png", data)}}}}
	body, contentType, err := ProtocolRequestBody(context.Background(), Config{BaseURL: "https://third-party.example", InterfaceType: "openai-image", Model: "gpt-image-2"}, spec)
	if err != nil {
		t.Fatal(err)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(body, params["boundary"])
	found := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		value, _ := io.ReadAll(part)
		if part.FormName() == "image" {
			found = true
			if !bytes.Equal(value, data) || part.FileName() != "source.png" {
				t.Fatal("third-party multipart changed")
			}
		}
		if part.FormName() == "response_format" && string(value) != "b64_json" {
			t.Fatal("third-party response format changed")
		}
	}
	if !found {
		t.Fatal("third-party source file missing")
	}
}
