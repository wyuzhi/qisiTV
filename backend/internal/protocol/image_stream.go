package protocol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// ManifestImageStream maps completed image events to the same result contract
// as a JSON response. Event names and payload fields belong to the plugin.
type ManifestImageStream struct {
	TypePath     string   `json:"typePath"`
	ItemEvents   []string `json:"itemEvents"`
	ErrorEvents  []string `json:"errorEvents,omitempty"`
	IndexPath    string   `json:"indexPath,omitempty"`
	Images       any      `json:"images"`
	Usage        any      `json:"usage,omitempty"`
	MessagePaths []string `json:"messagePaths,omitempty"`
}

// CreateResponseParser is optional; transports still own authentication,
// timeouts and response limits. An undeclared event stream is not interpreted.
type CreateResponseParser interface {
	ParseCreateResponse(context.Context, []byte, string) (CreateResult, error)
}

func (a manifestAdapter) ParseCreateResponse(ctx context.Context, body []byte, contentType string) (CreateResult, error) {
	stream := a.manifest.Response.Stream
	declaredStreamBody := stream != nil && (bytes.HasPrefix(bytes.TrimSpace(body), []byte("data:")) || bytes.HasPrefix(bytes.TrimSpace(body), []byte("event:")))
	if !strings.EqualFold(strings.TrimSpace(strings.Split(contentType, ";")[0]), "text/event-stream") && !declaredStreamBody {
		return a.ParseCreate(ctx, body)
	}
	if stream == nil {
		return CreateResult{}, fmt.Errorf("plugin does not declare an image event stream")
	}
	result := &Result{}
	type indexedImage struct {
		index int
		image MediaReference
	}
	images := make([]indexedImage, 0)
	seen := map[int]bool{}
	var lastError error
	consume := func(data string) bool {
		if strings.TrimSpace(data) == "[DONE]" {
			return false
		}
		payload, err := decodeObject([]byte(data))
		if err != nil {
			lastError = err
			return true
		}
		env := map[string]any{"response": payload}
		typ := firstPathValue(payload, stream.TypePath)
		if containsEvent(stream.ErrorEvents, typ) {
			lastError = fmt.Errorf("%s", defaultValue(firstPathValue(payload, stream.MessagePaths...), "image stream failed"))
		}
		if stream.Usage != nil {
			if value, err := evaluateManifestValue(stream.Usage, env); err == nil && value != nil {
				result.Usage = manifestObject(value)
			}
		}
		if !containsEvent(stream.ItemEvents, typ) {
			return true
		}
		refs := manifestResponseMedia(stream.Images, env, "image", a.manifest.Response.ResultEphemeral)
		index := len(images)
		if stream.IndexPath != "" {
			index, err = strconv.Atoi(manifestString(pathValue(payload, stream.IndexPath)))
			if err != nil || index < 0 {
				lastError = fmt.Errorf("image stream contains an invalid image index")
				return true
			}
			if seen[index] {
				return true
			}
		}
		for _, ref := range refs {
			if a.manifest.Response.DetectImageMIME {
				item := &Result{Images: []MediaReference{ref}}
				if err := detectInlineImageMIME(item); err != nil {
					lastError = err
					continue
				}
				ref = item.Images[0]
			}
			images = append(images, indexedImage{index, ref})
			seen[index] = true
		}
		return true
	}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	var lines []string
	flush := func() bool {
		if len(lines) == 0 {
			return true
		}
		data := strings.Join(lines, "\n")
		lines = nil
		return consume(data)
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if !flush() {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	if err := scanner.Err(); err != nil {
		lastError = err
	}
	sort.SliceStable(images, func(i, j int) bool { return images[i].index < images[j].index })
	for _, item := range images {
		result.Images = append(result.Images, item.image)
	}
	if len(result.Images) == 0 {
		if lastError != nil {
			return CreateResult{}, lastError
		}
		return CreateResult{}, fmt.Errorf("image stream returned no images")
	}
	return CreateResult{Status: StatusSucceeded, Result: result}, nil
}

func containsEvent(events []string, event string) bool {
	for _, candidate := range events {
		if candidate == event {
			return true
		}
	}
	return false
}

func detectInlineImageMIME(result *Result) error {
	if result == nil {
		return nil
	}
	for index := range result.Images {
		ref := &result.Images[index]
		if ref.DataURL == "" {
			continue
		}
		_, encoded, ok := strings.Cut(ref.DataURL, ",")
		if !ok {
			return fmt.Errorf("image response contains invalid inline data")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return fmt.Errorf("decode image response: %w", err)
		}
		mime := http.DetectContentType(data)
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return fmt.Errorf("unsupported image response type %s", mime)
		}
		ref.MIMEType = mime
		ref.DataURL = "data:" + mime + ";base64," + encoded
	}
	return nil
}
