`managed-video-catalog.json` 是 BeefAPI 2026-10-29 的真实 TokenAuth + `/v1/models` handler 在隔离数据库中的序列化响应。包括陌生 ID、Kling、H3、Wan 视频目录，不包含真实凭据或付费调用。

`managed-video-catalog-live.json` 是同日企业站公开 `/v1/models` 的视频字段快照，保留 Seedance 全系列及当时缺失的目录。测试只把存在有效版本的行当作服务端声明，不为缺失行猜测能力。

两份数据同时由 Go 目录持久化测试和前端目录、配置恢复、控件读取测试消费。

The candidate snapshot includes BeefAPI PR #683 operationReferences for per-operation reference counts. Defaults are form initial values; supported controls are explicitly serialized by the client.
