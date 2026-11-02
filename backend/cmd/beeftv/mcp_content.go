package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// videoPartNote replaces video bytes that MCP cannot carry as a content block.
const videoPartNote = "视频片段未附带：MCP 没有视频内容类型。看画面请用 mode=frames，看连续动作或听声音请用 media.review。"

type mcpMediaPart struct {
	Type     string          `json:"type"`
	MimeType string          `json:"mimeType"`
	Data     string          `json:"data"`
	SHA256   string          `json:"sha256,omitempty"`
	Source   json.RawMessage `json:"source,omitempty"`
}

// opToolContent turns a workspace operation response into MCP content.
// Media reads return base64 parts inside result.content; left in the JSON text
// an external agent cannot see the picture and the bytes fill its context, so
// images and audio become MCP blocks and the text keeps only the facts.
func opToolContent(raw json.RawMessage) []mcp.Content {
	plain := []mcp.Content{&mcp.TextContent{Text: string(raw)}}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		return plain
	}
	var op string
	if json.Unmarshal(envelope["op"], &op) != nil || !strings.HasPrefix(op, "media.") {
		return plain
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(envelope["result"], &result) != nil {
		return plain
	}
	var parts []mcpMediaPart
	if json.Unmarshal(result["content"], &parts) != nil || len(parts) == 0 {
		return plain
	}
	blocks := make([]mcp.Content, 0, len(parts))
	facts := make([]map[string]any, 0, len(parts))
	for _, part := range parts {
		fact := map[string]any{"type": part.Type, "mimeType": part.MimeType}
		if part.SHA256 != "" {
			fact["sha256"] = part.SHA256
		}
		if len(part.Source) > 0 {
			fact["source"] = part.Source
		}
		data, err := base64.StdEncoding.DecodeString(part.Data)
		switch {
		case err != nil || len(data) == 0:
			fact["note"] = "媒体数据无法解码，未附带"
		case strings.HasPrefix(part.MimeType, "image/"):
			blocks = append(blocks, &mcp.ImageContent{Data: data, MIMEType: part.MimeType})
			fact["attached"] = "image"
		case strings.HasPrefix(part.MimeType, "audio/"):
			blocks = append(blocks, &mcp.AudioContent{Data: data, MIMEType: part.MimeType})
			fact["attached"] = "audio"
		default:
			fact["note"] = videoPartNote
		}
		facts = append(facts, fact)
	}
	encodedFacts, err := json.Marshal(facts)
	if err != nil {
		return plain
	}
	result["content"] = encodedFacts
	if envelope["result"], err = json.Marshal(result); err != nil {
		return plain
	}
	text, err := json.Marshal(envelope)
	if err != nil {
		return plain
	}
	return append([]mcp.Content{&mcp.TextContent{Text: string(text)}}, blocks...)
}
