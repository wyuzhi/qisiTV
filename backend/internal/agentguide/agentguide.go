// Package agentguide 保存所有外部 Agent 共用的一份画布使用说明。
// 可编辑原文在 plugins/qisitv-skills/skills/qisitv-canvas/SKILL.md；
// 这里的嵌入副本由 scripts/sync-agent-skill.mjs 生成，字节必须一致。
package agentguide

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
)

const Name = "qisitv-canvas"

//go:embed skilldata/SKILL.md
var content []byte

// Guide 是 agent.guide 操作返回给外部客户端的稳定结构。
type Guide struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	ContentHash string `json:"contentHash"`
	Text        string `json:"text"`
}

func Text() string {
	return string(content)
}

func ContentHash() string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// Version 是内容指纹的短形式：说明一改就变，调用方不必单独维护版本号。
func Version() string {
	return ContentHash()[:12]
}

func Current() Guide {
	return Guide{Name: Name, Version: Version(), ContentHash: ContentHash(), Text: Text()}
}
