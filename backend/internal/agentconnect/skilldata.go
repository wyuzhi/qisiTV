package agentconnect

import "qisitv/backend/internal/agentguide"

// canvasSkill 是一键接入时写入用户技能目录的同一份使用说明。
var canvasSkill = []byte(agentguide.Text())
