# 旧视频协议清单

两份 JSON 逐字取自 BeefTV `v2.0.4`，提交 `542124baadcdbe5ce34ba9029ef7f1d192b49d16` 的 `plugin-packages/<协议 ID>/manifest.json`。保留原文（包括内嵌文档），不手写一个近似旧版。

来源是 #78 的研究附录（`961424b9`）。`video_protocol_upgrade_test.go` 将其打成临时包，通过真实 SQLite 与 `NewLocal` 安装，再换为当前清单并正常重启；不调用无引用盘点构造器。

对应回归还覆盖删 ID 保留和旧包回退。所有凭据、任务、数据库和 HTTP 上游均为测试创建，不含用户数据。
