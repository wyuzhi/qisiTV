# Gemini（OpenAI 兼容）

该目录是 qisiTV 声明式协议插件源码。后端从生成的 `gemini-openai-compat.qisitv-plugin` 包加载，不依赖系统内置 `host:` 适配器。

Google Gemini 同时提供原生 `generateContent` 接口和 OpenAI 兼容接口。本插件只适配后者：请求路径是 `/v1beta/openai/chat/completions`，鉴权用 `Authorization: Bearer`。Gemini 原生接口用单独的插件。

本插件源自 BeefTV Contributors 的实现，由 qisiTV 分支维护，用于适配 Google Gemini 相关服务接口；不表示 qisiTV 与该服务商存在隶属、授权或合作关系。

## 服务地址怎么填

填 `https://generativelanguage.googleapis.com` 即可。填到 `/v1beta` 或 `/v1beta/openai` 也会拼出同一个地址，不会重复。

模型列表读不到时，在模型列表里手动填写模型 ID。

完整接口见 [docs/interface.md](docs/interface.md)。
