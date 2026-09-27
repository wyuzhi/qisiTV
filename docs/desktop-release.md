# qisiTV 桌面发布

生产桌面包使用仓库根目录的 `VERSION` 作为唯一版本源。发布脚本会把版本号、当前 Git 提交和 UTC 构建时间同时注入前端与 Go 后端，并生成不依赖 Vite 开发服务器的 Wails 应用包。

带自动更新的生产包还要注入更新源地址和 Ed25519 公钥。密钥、草稿发布、签名清单和回滚语义见下方「桌面自动更新」。`v1.5.2` 及以前的安装包不含更新器，不能靠补发清单给已经装好的二进制补上自动更新。

本地合同检查仍由 `scripts/verify-qisitv-local-release.sh` 负责。macOS 发布脚本会先跑该门禁；Windows 发布脚本只做本机打包，不重复整套门禁。

前端未压缩产物的默认体积上限为 105 MiB，可通过 `QISITV_WEB_BUDGET_MIB` 调整。包含 FFmpeg、MediaPipe 和预设资源的主线基线约为 99.24 MiB；自动更新增量约 25 KiB。此上限不是 zip 下载大小。

## macOS

```bash
./scripts/build-qisitv-release.sh
```

如果系统没有全局 Go，可通过 `QISITV_GO_DIR` 指定本地工具链目录：

```bash
QISITV_GO_DIR=/path/to/go ./scripts/build-qisitv-release.sh
```

生产自动更新包需要额外环境变量：

| 变量 | 作用 |
| --- | --- |
| `QISITV_UPDATER_PUBLIC_KEY` | 注入更新源公钥；缺省则更新器保持关闭 |
| `QISITV_UPDATER_FEED_URL` | 发布方自己的签名清单 HTTPS 地址；没有默认更新源 |
| `QISITV_WAILS_PLATFORM` | 可选，例如 `darwin/arm64` 或 `darwin/amd64` |
| `QISITV_SKIP_LOCAL_VERIFY` | 设为 `1` 时跳过本地门禁；发布流水线的校验作业会跑门禁 |
| `QISITV_EXTRA_LDFLAGS` | 追加到 Wails `-ldflags` |

产物：

```text
backend/cmd/desktop/build/bin/qisiTV.app
backend/cmd/desktop/build/bin/qisiTV.app/Contents/Resources/plugin-packages/*.qisitv-plugin
```

验收重点：

- `backend/cmd/desktop/build/bin/qisiTV.app` 存在；
- Wails 将 `frontend/dist` 编译进应用二进制；应用包内应存在 `Contents/MacOS/qisiTV`，并由构建日志确认完成 `Compiling frontend` 与 `Packaging application`；
- macOS `Info.plist` 的 `CFBundleShortVersionString` 和 `CFBundleVersion` 与根目录 `VERSION`（去掉 `v` 前缀）一致；
- `/api/health/live` 与 `/api/system/version` 返回的版本信息来自同一份发布元数据；
- 发布启动不需要 `127.0.0.1:3000` 的 Vite 开发服务器。

## Windows（amd64，必须在 Windows 本机执行）

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-qisitv-windows-release.ps1
```

产物：

```text
backend\cmd\desktop\build\bin\qisiTV.exe
backend\cmd\desktop\build\bin\plugin-packages\*.qisitv-plugin
```

官方插件必须和 `qisiTV.exe` 放在同一目录下的 `plugin-packages\`。从开始菜单、快捷方式或资源管理器启动时，工作目录不一定是仓库或 exe 所在目录；应用按可执行文件位置查找官方插件，不依赖当前工作目录。

### 本机前提

脚本发现缺工具就退出，不会安装全局工具，也不会改用户 PATH。

| 前提 | 用途 | 依据 |
| --- | --- | --- |
| Windows 10/11 amd64 | Wails Windows 目标 | [Wails CLI platforms](https://wails.io/docs/reference/cli) |
| Go 1.25 或更新，且在 PATH（或 `QISITV_GO_DIR\bin\go.exe`） | 编译桌面后端；`backend/go.mod` 要求 1.25 | 仓库 `backend/go.mod` |
| Bun 在 PATH | `wails.json` 的 `bun install --frozen-lockfile` 与 `bun run build:desktop` | 仓库 `backend/cmd/desktop/wails.json` |
| `CGO_ENABLED` 不能是 `0` | `gorm.io/driver/sqlite` 依赖 `github.com/mattn/go-sqlite3` | [go-sqlite3 README](https://github.com/mattn/go-sqlite3#windows) |
| PATH 中的 `gcc`/`clang`，或可执行的 `CC` | 编译 go-sqlite3。Go 1.25 起 Windows CGO 需要支持 DWARF 5 的 GCC（binutils 2.37 或更新） | [go-sqlite3 Windows](https://github.com/mattn/go-sqlite3#windows)、[Go Minimum Requirements · cgo](https://go.dev/wiki/MinimumRequirements#cgo) |
| 已有 `plugin-packages/*.qisitv-plugin`，或能现场打包 | 官方协议包是运行时依赖 | 仓库 `plugin-packages/build-packages.sh` |
| Microsoft WebView2 Runtime | 运行 Wails 窗口。Windows 11 通常已安装 | [Wails Windows](https://wails.io/docs/guides/windows)、[Wails installation](https://wails.io/docs/gettingstarted/installation) |

现场打包官方插件时的顺序：

1. 若已有 `plugin-packages/*.qisitv-plugin`，直接使用；
2. 否则若本机有 `bash`、`zip` 和 `node`，调用现有 `plugin-packages/build-packages.sh`；
3. 否则用 Bun 或 Node 运行 `plugin-packages/embed-documentation.mjs`，再用 PowerShell 写出带正斜杠路径的 zip。反斜杠路径会被插件校验拒绝。

构建使用与 macOS 相同的 Wails 模块 `github.com/wailsapp/wails/v2/cmd/wails@v2.16.0`，并显式传入 `-platform windows/amd64`、`-webview2 download`。Wails 把生产二进制写到 `build/bin`。缺少 WebView2 时，下载策略会提示安装官方 bootstrapper。

本脚本不生成 NSIS 安装包。Wails 的 `-nsis` 需要另装 NSIS，且默认安装脚本是否包含 `plugin-packages\` 未经本仓库验证。当前支持的发布形态是：把 `qisiTV.exe` 和旁边的 `plugin-packages\` 一起分发。

在非 Windows 主机交叉编译出来的 exe，不能当作 Windows 验收通过。

## 启动目录与数据目录

桌面进程默认数据目录来自 Go 的 `os.UserConfigDir()`，再拼 `qisiTV`：

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%AppData%\qisiTV`（Roaming） |
| macOS | `~/Library/Application Support/qisiTV` |

其中包含 SQLite、本地资源和迁移备份。隔离调试时设置 `CANVAS_DESKTOP_DATA_DIR`。`CANVAS_BACKEND_DATA_DIR` 只作用于 `cmd/server`，不会改桌面数据目录。

官方插件源目录是安装包内的只读输入；启动后会复制到数据目录下的 `plugin-packages\`。源目录找不到时，桌面后端无法完成启动。

需要知道的限制：

- 未签名的 `qisiTV.exe` 可能被 SmartScreen 拦截；本脚本不签名。
- 构建机没有 C 编译器时，脚本会失败。常见 MSYS2/MinGW 路径若存在但不在 PATH，脚本会指出路径，不会自动加入 PATH。
- 数据库连接串目前把数据目录与 `/open_ai_canvas.db` 直接拼接。Windows 一般接受正斜杠；数据目录名里如果出现 `?` 或 `#`，可能被当成 DSN 参数。

发布前先停止 Wails/Vite 开发进程，避免开发输出与生产构建并发写入同一目录。

## 桌面自动更新

自动更新只服务于已经装过「带更新器的生产包」的用户。检查、下载、安装都在应用内完成；安装并重启前，正在运行的版本不会被替换。

### 现有安装

`v1.5.2` 及以前的安装包里没有更新器。给仓库补上更新源或签名清单，不会让这些已经装好的版本自己升级。

用户需要先手动下载并安装第一个带更新器的版本。之后就可以在应用里检查更新。项目、素材、设置、BeefAPI 登录和自定义插件会留在原来的数据目录，不会跟着安装包走。

### 会保留的数据

更新包只替换应用本身：

| 系统 | 被替换 | 不会进更新包、也不会被替换 |
| --- | --- | --- |
| macOS | `qisiTV.app` | `~/Library/Application Support/qisiTV` |
| Windows | `qisiTV.exe` 和旁边的 `plugin-packages\*.qisitv-plugin` | `%AppData%\qisiTV` |

应用包身份和可执行文件路径保持不变，所以前端 IndexedDB 会继续可用。官方插件随应用包更新；用户自己装的插件如果放在数据目录里，会留下来。

程序与数据必须使用独立目录。尤其不要把 Windows zip 解压到 `%AppData%\qisiTV`，也不要将 `CANVAS_DESKTOP_DATA_DIR` 指向 exe 所在目录。更新器会在退出前拒绝这类目录重叠。

更新包禁止带上 `.env`、SQLite 数据库和 `.settings-key`。打包工具遇到用户数据目录会直接拒绝。

### 更新签名和 Apple 签名

这是两件独立的事。

- **更新签名**：Ed25519 签的是 `desktop-update.json` 里的清单。清单写明每个系统包的下载地址、SHA-256 和大小。应用用编译进去的公钥验签，再核对 zip 哈希。不依赖 Apple 证书，也不走业务云接口。
- **Apple 签名 / 公证**：只影响 Gatekeeper 对 `.app` 的信任。现有 macOS 脚本仍使用 ad hoc `codesign --sign -`。Developer ID 和公证是可选的，不是自动更新生效的前提。

Windows 目前也不做 Authenticode 签名。SmartScreen 可能拦截首次手动安装。

### 密钥

在本机生成，不要写进仓库，也不要在终端打印私钥：

```bash
cd backend
go run ./cmd/update-release gen-key \
  --private-key /path/to/qisitv-updater.private \
  --public-key /path/to/qisitv-updater.public
```

私钥文件权限是 `0600`，内容是 64 字节 Ed25519 私钥的标准 Base64。公钥是 32 字节公钥的标准 Base64。

GitHub 仓库配置：

| 位置 | 名称 | 内容 |
| --- | --- | --- |
| Actions secret | `QISITV_UPDATER_PRIVATE_KEY` | 私钥文件全文 |
| Actions variable | `QISITV_UPDATER_PUBLIC_KEY` | 公钥文件全文 |

发布流水线会用私钥推导公钥，必须和变量一致，否则失败，不会发布未签名更新源。

本地要打带更新器的包时，导出公钥即可：

```bash
export QISITV_UPDATER_PUBLIC_KEY="$(tr -d '[:space:]' < /path/to/qisitv-updater.public)"
export QISITV_UPDATER_FEED_URL="https://releases.example.com/qisitv/desktop-update.json"
./scripts/build-qisitv-release.sh
```

脚本会把下面两个链接期变量写进二进制：

- `qisitv/backend/internal/desktopupdate.FeedURL` = 显式指定的 `QISITV_UPDATER_FEED_URL`
- `qisitv/backend/internal/desktopupdate.PublicKey` = 公钥 Base64

公钥或更新源未配置时，应用里的更新器保持关闭，但仍显示当前版本。qisiTV 不复用上游 BeefTV 的更新源；示例域名需要替换成发布方实际控制的 HTTPS 地址。

**丢失私钥**：已经发出去的包只认当时编进去的公钥。新密钥签的清单，旧包验不过。换密钥等于重新发一个需要用户手动安装的引导包。不要轮换生产密钥，除非旧私钥已经泄露或确认丢失。

**泄露私钥**：立刻停用自动更新源（不要再发布用该密钥签的清单），换新密钥，并让用户手动安装新引导包。

### 发布

版本号只来自仓库根目录 `VERSION`，必须是稳定的 `vMAJOR.MINOR.PATCH`。不要用预发布号，也不要按 `main` 的 commit SHA 轮询。

正式文件名固定为：

```text
qisiTV-vX.Y.Z-darwin-arm64.zip
qisiTV-vX.Y.Z-darwin-amd64.zip
qisiTV-vX.Y.Z-windows-amd64.zip
desktop-update.json
```

zip 里的布局：

- macOS：`qisiTV.app/...`，保留可执行权限；内部安全符号链接会被解成普通文件，不会写成 zip 符号链接项。
- Windows：根目录的 `qisiTV.exe` 和 `plugin-packages/*.qisitv-plugin`。

发布方可以使用自己 GitHub 仓库的 latest 下载地址。以下为占位示例，不代表已有公开 qisiTV 发布仓库：

```text
https://github.com/OWNER/REPOSITORY/releases/latest/download/desktop-update.json
```

流水线先建 draft，三个平台构建任务把包保存为 Actions 产物。发布任务收齐三个包后生成签名清单，把包和清单一起上传到 draft，最后发布并明确标记 latest。失败的构建不会切换客户端更新源。

在发布方自己的 qisiTV 仓库 `main` 上手动运行 `.github/workflows/release-desktop.yml`。输入的 `confirm_version` 必须和 `VERSION` 一致。`CHANGELOG.md` 必须有对应的 `## vX.Y.Z` 段落，这段文字会同时成为 GitHub Release 说明和清单里的 `notes`。

工作流会拒绝：

- 在非 `main` 上发布
- 缺少密钥或公私钥不匹配
- 标签或 Release 已经存在（包括 draft）
- 新版本不高于已经发布的稳定版本
- 三个系统包还没齐就签名

Apple 公证不在这条工作流里。macOS 作业沿用现有脚本的 ad hoc 签名。Windows 作业安装 MSYS2 UCRT64 GCC，并核对 binutils ≥ 2.37，以符合 Go 1.25 的 DWARF 5 要求；不要用 Chocolatey mingw 或旧版 TDM-GCC。

同一版本的资源是不可变的。不要覆盖已发布的 tag、zip 或 `desktop-update.json`。

本地打包和签名（用测试密钥，不要用生产私钥做实验）：

```bash
cd backend
go run ./cmd/update-release package \
  --platform darwin-arm64 \
  --input cmd/desktop/build/bin/qisiTV.app \
  --output /tmp/qisiTV-vX.Y.Z-darwin-arm64.zip
go run ./cmd/update-release sign \
  --version vX.Y.Z \
  --commit "$(git rev-parse HEAD)" \
  --changelog ../CHANGELOG.md \
  --private-key /path/to/qisitv-updater.private \
  --expect-public-key "$(tr -d '[:space:]' < /path/to/qisitv-updater.public)" \
  --require-platforms darwin-arm64,darwin-amd64,windows-amd64 \
  --asset darwin-arm64=/tmp/qisiTV-vX.Y.Z-darwin-arm64.zip \
  --asset darwin-amd64=/tmp/qisiTV-vX.Y.Z-darwin-amd64.zip \
  --asset windows-amd64=/tmp/qisiTV-vX.Y.Z-windows-amd64.zip \
  --output /tmp/desktop-update.json
```

### 回滚

客户端在退出前校验并把更新准备到程序所在磁盘；无写入权限、磁盘空间不足或签名错误时保留当前运行的应用。替换/启动失败会尝试恢复旧程序。程序旁的 `.qisitv-update-*` 目录保留旧程序和 `result.json` 恢复记录，确认新版本正常后才手动清理。已启动的新进程不会自动降级，以免把迁移后的数据库交给旧程序；恢复旧程序时需另行确认数据库兼容或还原匹配的数据备份。

已经发布的版本不能收回。已经更新成功的用户，不会因为删除 GitHub Release 而回到旧包。

发现新版本有问题：

1. 不要改写或删除该版本的 zip 和 `desktop-update.json`，可能还有人正在下载。
2. 在 `CHANGELOG.md` 写清问题，把 `VERSION` 升到更高的稳定号。
3. 从修复后的 `main` 再跑一次发布工作流。
4. 已安装更新器的用户检查更新后会拿到更高版本。

如果某个 draft 失败且从未公开：确认没有用户能下到它之后，可以删除该 draft 和对应 tag，再对同一 `VERSION` 重试。已经公开的 tag 不要复用。

`/releases/latest` 指向最近一次发布的正式版，按发布时间而不是按最大版本号。只按时间顺序发布递增的稳定版本。
