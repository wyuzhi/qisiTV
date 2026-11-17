// Host 的 HTTP 面：嵌入页代理与 /beeftv/* 控制接口。协议细节留在 runtime.js。

import { request } from 'node:http'
import { embeddedDocument, embeddedPathRejection, publicContext } from './runtime.js'

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(value))
}

async function bodyJSON(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new Error('请求需要 JSON 内容')
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 32_768) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function proxy(runtime, req, res, path, basePath) {
  return new Promise((resolve, reject) => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      reject(new Error('无效的工作区路径'))
      return
    }
    // The checked target is sent verbatim. Re-parsing it could drop or rewrite parts the check saw.
    const bridge = new URL(runtime.bridgeURL)
    // The page marker lets the bridge apply its own path check to embedded-page traffic.
    const headers = { ...req.headers, host: bridge.host, 'x-beeftv-harness-token': runtime.bridgeToken, 'x-beeftv-harness-page': '1' }
    for (const header of ['authorization', 'cookie', 'origin', 'x-desktop-token', 'x-beeftv-ui-bootstrap', 'x-beeftv-client', 'x-beeftv-owner']) delete headers[header]
    const upstream = request({ hostname: bridge.hostname, port: bridge.port, path, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }
      delete responseHeaders['set-cookie']
      if ((response.headers['content-type'] || '').includes('text/html')) {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const html = embeddedDocument(Buffer.concat(chunks).toString('utf8'), basePath)
          delete responseHeaders['content-length']
          delete responseHeaders['content-encoding']
          res.writeHead(response.statusCode || 200, responseHeaders)
          res.end(html)
          resolve()
        })
      } else {
        if ((response.headers['content-type'] || '').includes('text/event-stream')) {
          responseHeaders['cache-control'] = 'no-cache, no-transform'
          responseHeaders['x-accel-buffering'] = 'no'
          req.socket?.setNoDelay?.(true)
          response.socket?.setNoDelay?.(true)
        }
        res.writeHead(response.statusCode || 502, responseHeaders)
        res.flushHeaders?.()
        response.pipe(res)
        response.once('end', resolve)
        res.once('close', resolve)
      }
      response.once('error', reject)
    })
    upstream.once('error', reject)
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}

export function registerWorkspaceRoutes(ctx, { connection, runner, stepLimit }) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/beeftv',
    async handler(req, res) {
      try {
        const current = connection.current()
        // Workspace requests are judged on the raw target. Parsing it first could resolve it into a path the bridge reads differently.
        if (current && req.url.startsWith(`${current.basePath}/`)) {
          const target = req.url.slice(current.basePath.length)
          const rawPath = target.split('?', 1)[0]
          if (req.method === 'GET' && rawPath === '/__harness/status') return json(res, 200, connection.status())
          const origin = req.headers.origin
          if (origin && origin !== ctx.webServer.getOrigin()) return json(res, 403, { error: '不允许的来源' })
          const rejected = embeddedPathRejection(rawPath)
          if (rejected) return json(res, rejected, { error: rejected === 403 ? '该操作由 DeepSeek Harness 管理' : '无效的工作区路径' })
          await proxy(current, req, res, target, current.basePath)
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const rejection = ctx.connection.requestRejection({ headers: req.headers })
        if (rejection) return json(res, rejection, { error: '未授权' })
        if (req.method === 'GET' && url.pathname === '/beeftv/status') {
          await connection.settingsReady
          await connection.pluginSettingsReady
          return json(res, 200, await connection.refreshConnection())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/connect') {
          const body = await bodyJSON(req)
          await connection.settingsReady
          await connection.connect(body.mode)
          return json(res, 200, connection.status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/context') {
          const body = await bodyJSON(req)
          const live = connection.current()
          if (!live || body.connectionId !== live.connectionId) return json(res, 409, { error: '工作区连接已更新，请刷新后重试' })
          if (typeof body.sessionId !== 'string' || body.sessionId.length > 256) throw new Error('无效的 Agent 会话')
          const view = publicContext(body.context)
          view.agentMode = ['creation', 'assets', 'ecosystem'].includes(body.agentMode) ? body.agentMode : 'creation'
          connection.setContext(body.sessionId, view)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/settings') {
          const body = await bodyJSON(req)
          await connection.pluginSettingsReady
          await connection.updatePluginSettings(body)
          return json(res, 200, connection.status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/away-notice') {
          const body = await bodyJSON(req)
          if (body.seen !== true) throw new Error('无效的提示设置')
          // 断线时不知道该清哪个工作区；先忽略，等连回后再关，避免把别的工作区计数一起清掉。
          const live = connection.current()
          if (!live) return json(res, 200, connection.status())
          // 用户关掉的是已经看到的提示；尚未核对的 taskId 留在盘上，下次连回同一工作区继续查。
          await runner.dispatch({ type: 'awaySeen', workspaceId: live.workspace?.id ?? null }).settled
          return json(res, 200, connection.status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/step-notice') {
          const body = await bodyJSON(req)
          if (body.seen !== true) throw new Error('无效的提示设置')
          stepLimit.acknowledge()
          return json(res, 200, connection.status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/local-prompt') {
          const body = await bodyJSON(req)
          if (body.dismissed !== true) throw new Error('无效的本机连接提示设置')
          await connection.dismissLocalPrompt()
          return json(res, 200, connection.status())
        }
        json(res, 404, { error: '未找到接口' })
      } catch (failure) {
        if (!res.headersSent) json(res, 503, { error: failure.message })
        else res.destroy()
      }
    },
  }))
}
