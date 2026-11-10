import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('.', import.meta.url))

export function requiresGenerationApproval(name, args, businessTools = []) {
  if (/^mcp__beeftv__canvas_generation_submit(?:_[a-f0-9]{12})?$/.test(name)) return true
  if (!/^mcp__beeftv__business_call(?:_[a-f0-9]{12})?$/.test(name)) return false
  const tool = businessTools.find(item => item.id === args?.tool)
  return !(tool?.readOnly === true && tool.submitsGeneration === false)
}

export function runtimeRecord(value) {
  for (const key of ['bridgeURL', 'baseURL']) {
    const url = new URL(value?.[key])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('工作区地址必须为本机回环地址')
  }
  if (typeof value.bridgeToken !== 'string' || !value.bridgeToken) throw new Error('工作区未返回桥接凭据')
  return value
}

export function embeddedDocument(html, basePath, parentOrigin = '*') {
  const config = JSON.stringify({ embedded: true, apiBase: `${basePath}/api`, basePath, parentOrigin }).replaceAll('<', '\\u003c')
  // The asset page's stacking context otherwise puts its narrow sidebar below the dismiss scrim.
  const styles = `<style>
html .app-workspace-shell:has(.assets-library-page) .app-workspace-main-row{z-index:auto}
/* Only top controls avoid the host overlay. The page and canvas remain full width. */
html .canvas-topbar{padding-left:calc(8px + var(--beeftv-host-leading,0px))!important}
html .app-user-workspace .app-workspace-floating-menu{left:calc(12px + var(--beeftv-host-leading,0px))!important}
/* A full sidebar stays in place. Its brand row can sit below the host controls. */
html[data-beeftv-host-chrome] .app-workspace-sidebar-brand-row,
html[data-beeftv-host-chrome] .app-workspace-sidebar-rail-header{margin-top:48px}
</style>`
  const bridge = `<script>(${embeddedChromeBridge.toString()})()</script>`
  return html.replace(/<base\b[^>]*>/gi, '').replace(/<head[^>]*>/i, match => `${match}<base href="${basePath}/"><meta name="referrer" content="no-referrer">${styles}<script>window.__BEEFTV_HARNESS__=${config}</script>${bridge}`)
}

// The parent only transmits bounded layout metrics, never workspace data or credentials.
function embeddedChromeBridge() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'beeftv:host-chrome') return
    const leading = event.data.leading
    if (typeof leading !== 'number' || !Number.isFinite(leading) || leading < 0 || leading > 320) return
    document.documentElement.style.setProperty('--beeftv-host-leading', `${leading}px`)
    document.documentElement.toggleAttribute('data-beeftv-host-chrome', leading > 0)
  })
}

export function publicContext(value) {
  if (!value || typeof value.route !== 'string' || !value.route.startsWith('/') || value.route.startsWith('//') || value.route.length > 2048) throw new Error('无效的工作区上下文')
  const context = { route: value.route }
  for (const key of ['canvasId', 'canvasTitle']) {
    if (typeof value[key] === 'string') context[key] = value[key].slice(0, 256)
  }
  context.selectedNodeIds = Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds.filter(id => typeof id === 'string').slice(0, 100).map(id => id.slice(0, 256)) : []
  return context
}

// Paths DeepSeek Harness manages itself. The embedded workspace page never reaches them.
const managedWorkspacePaths = ['/api/assistant', '/api/ops/clients', '/api/agent-clients']

// Judges the raw request path. URL parsers resolve encoded separators and dot segments differently
// from the Go bridge, so ambiguous spellings are refused instead of resolved. Returns 0, 400 or 403.
export function embeddedPathRejection(rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\#]|%(?:2f|5c|25)/i.test(rawPath)) return 400
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return 400
  }
  const segments = path.split('/').slice(1)
  if (segments.some((segment, index) => segment === '.' || segment === '..' || (segment === '' && index < segments.length - 1))) return 400
  // The bridge also serves the workspace under /beeftv/app, so that prefix is removed before matching.
  const effective = (path.replace(/^\/beeftv\/app(?=\/|$)/i, '') || '/').toLowerCase()
  return managedWorkspacePaths.some(managed => effective === managed || effective.startsWith(`${managed}/`)) ? 403 : 0
}

const localApp = {
  bundle: '/Applications/BeefTV.app',
  info: '/Applications/BeefTV.app/Contents/Info.plist',
  executable: '/Applications/BeefTV.app/Contents/MacOS/BeefTV',
  cli: '/Applications/BeefTV.app/Contents/MacOS/cli/beeftv',
}
// 2.2.0 is the first desktop release with the harness bridge. Older builds pass unknown flags to the
// GUI, so starting them with harness flags would open the desktop window instead of attaching.
const minimumLocalAppVersion = '2.2.0'

function supportsHarness(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '')?.slice(1).map(Number)
  if (!parts) return false
  const minimum = minimumLocalAppVersion.split('.').map(Number)
  const index = parts.findIndex((part, position) => part !== minimum[position])
  return index === -1 || parts[index] > minimum[index]
}

function bundleVersion(plist) {
  return new Promise(resolve => {
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

export async function localAppStatus() {
  try {
    await Promise.all([access(localApp.executable, constants.X_OK), access(localApp.cli, constants.X_OK)])
  } catch {
    return { compatible: false, version: null, message: `未找到本机 BeefTV。请安装 ${minimumLocalAppVersion} 或更高版本后重新连接。` }
  }
  const version = await bundleVersion(localApp.info)
  if (supportsHarness(version)) return { compatible: true, version, message: null }
  return {
    compatible: false, version,
    message: version
      ? `本机 BeefTV 版本为 ${version}，需要 ${minimumLocalAppVersion} 或更高版本。请升级后重新连接。`
      : `无法读取本机 BeefTV 的版本。请重新安装 ${minimumLocalAppVersion} 或更高版本后重新连接。`,
  }
}

async function requireLocalApp() {
  const app = await localAppStatus()
  if (!app.compatible) throw new Error(app.message)
}

async function bundledPaths() {
  const contents = join(root, 'runtime', 'Contents')
  const paths = { executable: join(contents, 'MacOS', 'BeefTV'), cli: join(contents, 'MacOS', 'cli', 'beeftv') }
  try {
    await Promise.all(Object.values(paths).map(path => access(path, constants.X_OK)))
  } catch (error) {
    throw new Error('插件缺少内置的 BeefTV 运行时，请重新安装插件', { cause: error })
  }
  return paths
}

export async function startLocalRuntime() {
  await requireLocalApp()
  try {
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', localApp.bundle], { timeout: 10_000 }, error => {
        if (error) reject(error)
        else resolve()
      })
    })
  } catch (error) {
    throw new Error('无法打开本机 BeefTV，请确认 /Applications/BeefTV.app 已完整安装', { cause: error })
  }
  const deadline = Date.now() + 30_000
  let lastFailure
  while (Date.now() < deadline) {
    try {
      return await launchRuntime(localApp, { attachOnly: true })
    } catch (error) {
      lastFailure = error
    }
    await delay(250)
  }
  throw new Error('本机 BeefTV 尚未就绪，请检查桌面应用的启动提示后重新连接', { cause: lastFailure })
}

// Reconnects to a running desktop App without opening it again.
export async function attachLocalRuntime() {
  await requireLocalApp()
  return launchRuntime(localApp, { attachOnly: true })
}

// The standalone workspace only ever runs the runtime bundled with the plugin.
export async function startRuntime(dataDir) {
  return launchRuntime(await bundledPaths(), { dataDir })
}

async function launchRuntime(paths, { dataDir, attachOnly = false }) {
  const args = ['--harness-runtime']
  if (attachOnly) args.push('--harness-attach-only')
  if (dataDir) args.push('--data-dir', dataDir)
  const child = spawn(paths.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // Runtime logs stay out of model output and the browser. Readiness is the only stdout record.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  let ready = false
  const record = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('启动 BeefTV 超过 30 秒，请检查安装与工作区状态'))
    }, attachOnly ? 3_000 : 30_000)
    const fail = () => {
      if (ready) return
      clearTimeout(timer)
      reject(new Error('BeefTV 运行时启动失败，请确认安装完整且工作区未被旧版本占用'))
    }
    child.once('error', fail)
    child.once('exit', fail)
    lines.on('line', line => {
      if (ready) return
      try {
        const value = runtimeRecord(JSON.parse(line))
        ready = true
        clearTimeout(timer)
        resolve(value)
      } catch {
        // Go/native startup notices are not readiness records.
      }
    })
  }).catch(error => {
    lines.close()
    child.stdin.end()
    child.kill('SIGTERM')
    throw error
  })
  return {
    ...record, cli: paths.cli, child,
    close() {
      lines.close()
      child.stdin.end()
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (record.owned) child.kill('SIGTERM')
          resolve()
        }, record.owned ? 10_000 : 1_000)
        timer.unref()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

export async function workspaceJSON(runtime, path, options = {}) {
  const response = await fetch(`${runtime.bridgeURL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', 'X-Beeftv-Harness-Token': runtime.bridgeToken, ...options.headers },
  })
  const value = await response.json()
  if (!response.ok || value.code !== 0) throw new Error(value.msg || `BeefTV 请求失败 (${response.status})`)
  return value.data
}

export async function inspectWorkspace(runtime) {
  const [health, bootstrap] = await Promise.all([
    workspaceJSON(runtime, '/api/health'),
    workspaceJSON(runtime, '/api/workspace/bootstrap'),
  ])
  if (!health.ready || !health.schema?.ready || !health.build?.version || !bootstrap.workspace?.id) {
    throw new Error('BeefTV 工作区尚未就绪，请在本机应用中完成启动后重试')
  }
  if (String(runtime.version).replace(/^v/, '') !== health.build.version.replace(/^v/, '')) {
    throw new Error('BeefTV 连接版本已变化，请重新连接')
  }
  return {
    build: health.build,
    workspace: { id: bootstrap.workspace.id, name: bootstrap.workspace.name, storage: bootstrap.workspace.storage },
    contractVersion: bootstrap.contractVersion,
  }
}
