import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))
const application = '/Applications/BeefTV.app/Contents'
const destination = join(root, 'runtime', 'Contents')

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('首版运行包面向 macOS Apple Silicon')
await mkdir(destination, { recursive: true })
for (const directory of ['MacOS', 'Resources']) {
  await cp(join(application, directory), join(destination, directory), { recursive: true, dereference: true })
}
for (const file of ['LICENSE', 'NOTICE']) await cp(join(repo, file), join(root, 'runtime', file))
const version = (await readFile(join(repo, 'VERSION'), 'utf8')).trim()
await writeFile(join(root, 'runtime', 'version.json'), JSON.stringify({ version, platform: 'darwin-arm64' }, null, 2))
console.log(`BeefTV ${version} 运行包已从安装版更新`)
