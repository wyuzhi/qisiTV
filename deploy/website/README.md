# 网站 LikeAI 临时转发

此目录是网站转发函数及测试的规范源。发布前把 `api/` 和 `test/` 复制到 Astro 静态网站根目录，并把 `vercel.fragment.json` 的 rewrite 合并到网站 `vercel.json`（不要覆盖网站其他配置）。函数采用 Vercel Node.js Web Handler，不需要数据库、账户、平台密钥或新运行时依赖；开发类型检查使用 `@types/node`。

用户的 API Key 只由当前请求的 `X-API-Key` 读取，仅发给 `https://task.likeai.pro/task-api`。应用代码不记录请求正文或密钥、不写文件、不创建持久化状态、不自动重试任务。上传素材和生成请求仍会发给 LikeAI，其保留规则由服务商决定。

## 浏览器合同

固定前缀为 `/api/qisitv/likeai`，只开放：

- `GET /task/models`：免费模型目录。
- `POST /files`：multipart 素材临时上传。
- `POST /task/create_task`：原样提交已由用户确认的 JSON 生成请求。
- `GET /task/query_task/<task_id>`：查询任务，不重复创建。
- `GET /task/artifact/<task_id>/<image|video|audio>/<index>`：先用本次 Key 查询已完成的任务，再下载结果中对应索引的媒体。不能直接传入任意下载 URL。

没有通用取消接口；停止网页等待不等于供应商取消任务或退款。未知路由、业务查询参数、跨源请求一律拒绝。rewrite 内部 `__route` 只接受上述固定路径，不接受 URL。正式同源允许 `https://cheeser.link`、`https://www.cheeser.link`，本机同源测试允许 `http://localhost:<port>`、`http://127.0.0.1:<port>`。不返回跨源 CORS 头。

结果下载只接受 HTTPS 公共地址，每次跳转都重新校验 DNS 并把连接固定到验证后的公共 IP；阻止私网、回环、链路本地地址及 IPv6 映射/过渡网络。下载 CDN 不携带 LikeAI Key、用户 Cookie 或 Authorization。所有响应设置 `no-store`。

## 大小与超时

- 网页参考文件应不超过 **4,000,000 bytes**；服务器限制整个 multipart 请求 **4,200,000 bytes**，为 Vercel 请求上限留下余量。更大素材需使用可供 LikeAI 读取的 HTTPS 链接，或本地连接程序；本接口不会自动上传到其他云存储。
- JSON 请求及上游 JSON 响应最多 **2,000,000 bytes**。
- 产物采用 Web `ReadableStream`，没有先读完整文件再返回，最多 **128 MiB**；请求处理最长 **120 秒**，函数最长 **180 秒**。
- 已知长度超限返回 413；未知长度在流式下载中超限会终止下载。客户端须保留任务及原始产物 URL，允许原始链接下载，不能把中断内容保存为完整成品。
- [Vercel 限制文档](https://vercel.com/docs/functions/limitations) 规定普通请求/响应上限 4.5 MB；[官方说明](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions) 明确流式响应不受该响应大小上限限制，但上传限制及函数执行时长仍适用。

## 验证

Node.js 24 可直接运行 TypeScript 函数的 mock 测试，不会访问 LikeAI：

```sh
node --test deploy/website/test/qisitv-likeai.test.mjs
```

网站副本对应命令为 `node --test test/qisitv-likeai.test.mjs`。类型检查：

```sh
npm install --save-dev @types/node@^24
npx tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck api/qisitv/likeai.ts
```

Vercel 函数源文件显式配置 `supportsResponseStreaming: true` 和 `maxDuration: 180`。本项目的静态 Astro 构建不能把 `[...path].ts` 自动解释成多段路径，因此使用单函数 `api/qisitv/likeai.ts` 加显式 rewrite。发布前应使用 `vercel build` 检查静态页面与函数是否一起出现在构建输出中；`astro build` 本身仅验证静态页面。
