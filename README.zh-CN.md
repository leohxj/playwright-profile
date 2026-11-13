# playwright-profile

[English](README.md) | [简体中文](README.zh-CN.md)

一个独立的 TypeScript CLI，用于管理带版本的浏览器存储快照。所有浏览器操作都使用**未经修改、在本地固定为 0.1.24 版本的 `@playwright/cli`**，包括 `run-code`。它不会连接你日常使用的浏览器，不会修改其文件，也不会要求你关闭它。

源是 macOS 上的 Chrome 或 Chrome Beta profile。目标是 macOS 或 Linux 上独立的 headless Chromium profile，也可以是明确配置、运行同一 CLI 的 SSH 端点。刷新会从源导出新版本，同步会在目标上启用该版本。会话会先加载目标的最新版本，再将控制权交给 agent。

## 本地安装

运行要求：Node 22+、npm、带标准库 SQLite 支持的 Python 3，以及 `ps`。从源导出还需要 macOS 和对应的 Google Chrome 或 Google Chrome Beta 应用。SSH 目标需要 OpenSSH。仅作为目标的 Linux 安装不需要 macOS；如果不克隆源，也不需要 Python。

```sh
npm ci
npm run build
node dist/cli.js --help
# 如果本地没有合适的 Chromium 可执行文件，可选安装目标运行时：
npx --no-install playwright install chromium
```

安装不会执行全局安装、安装后操作、skill 部署、定时任务启用或自动凭据导出。只有明确执行这条可选命令时，才会下载浏览器，下载位置为 Playwright 的常规浏览器缓存目录。也可以通过 `target add --executable` 指定可执行文件。

示例中的 `playwright-profile` 可替换为 `node /absolute/path/playwright-profile/dist/cli.js`。通过自行选择的包管理器安装后，该包也会提供 `playwright-profile` 命令。`npm pack` 会包含编译后的代码、SQLite 辅助程序和 skill。打包前先构建。不要发布包含私有数据根目录的包。

## 命令

名称必须匹配 `[a-z][a-z0-9-]{0,47}`。每条命令都支持 `--help`。全局选项 `--data-root` 必须放在子命令前。数据根目录默认为 `~/.local/share/playwright-profile`，也可由 `PLAYWRIGHT_PROFILE_DATA_ROOT` 指定。使用不含符号链接的绝对路径。在 macOS 上，`/tmp` 和 `/var` 是符号链接别名：指定私有验证根目录时，使用它们对应的真实路径。

```sh
playwright-profile profiles list
playwright-profile profiles list --browser chrome-beta
playwright-profile profiles list --browser chrome-beta --user-data-dir /private/path/empty-profile --app '/Applications/Google Chrome Beta.app'

playwright-profile source add work --browser chrome-beta --profile 'Profile 1'
# cookie 过滤条件可选。不设置时会导出全部 cookie。
playwright-profile source add limited --browser chrome --profile Default \
  --domain example.com login.example.net \
  --origin https://app.example.com https://login.example.net

playwright-profile refresh work
playwright-profile target add local
# 可选指定可执行文件；否则上游 CLI 使用其已安装的 Chromium。
playwright-profile target add custom --executable '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'
playwright-profile sync work local
playwright-profile session start local
playwright-profile session stop local
playwright-profile status

# 只有明确执行这些命令才会修改 launchd。不要为了查看状态而执行。
playwright-profile schedule enable work          # 默认为每小时一次
playwright-profile schedule enable limited --minutes 120
playwright-profile schedule disable work
```

`source add` 只登记元数据并读取 profile 名称，不导出凭据。profile 绑定的是浏览器和目录，不是显示名称。支持重复的显示名称。`--user-data-dir` 和 `--app` 可显式覆盖源配置，用于非标准安装或一次性验证。`--app` 必须指向 bundle ID 正确的应用。使用自定义源根目录时，操作者必须选择创建该目录的浏览器渠道；Chrome profile 文件无法可靠标识其发行渠道。如果已知的默认源根目录属于另一个渠道，CLI 会拒绝使用。

`--domain example.com` 匹配 `example.com` 及其子域名，不匹配 `evilexample.com` 或 `example.com.evil`。不要添加协议或前导点。CLI 不会自动添加任何 SSO 域名。私有副本会保留会话 cookie，但会丢弃旧标签页和会话文件，并清空启动 URL，因此不会恢复日常浏览器的标签页。域名过滤只影响 cookie。只有通过 `--origin` 显式指定的 origin 才会导出 localStorage 和 IndexedDB。origin 必须是精确的 HTTP(S) origin，不能包含路径、凭据、查询参数或末尾斜杠。如果请求失败、HTTP 出错、重定向离开该 origin、存储操作出错或采集失败，本次刷新就会被拒绝。采集期间会阻止导航到其他 origin 的请求，但资源请求仍可能访问其他 origin。采集可能执行网站脚本并发送常规网站请求，因此应审慎选择 origin。没有显式指定 origin 时，不会导航到任何网站。

不会导出 session storage、密码、证书、OPFS、service worker 或其他浏览器专有存储。复制后的浏览器数据库仍保留加密 cookie，直到对应浏览器将明文存储状态导出到私有根目录。源的克隆副本通过受支持的配置选项，排除上游的 mock-keychain 和 basic-password-store 启动参数。对应应用可能需要正常的 macOS Keychain 授权。拒绝授权时，操作会失败，不会绕过限制。状态文件本身就是凭据。整个数据根目录都必须保持私有，且不得纳入版本控制。

## 会话所有权与 agent 调用

`session start` 会返回上游随机会话名称、不可变版本、校验和、私有 `cwd`，以及准确的原始 CLI 调用示例。复制完整示例，包括 `cd` 和环境变量赋值。如果只从任意目录执行 `playwright-cli -s=...`，可能会使用另一个工作目录，无法可靠定位本次会话。不要对受管理会话执行 `open`、`attach`、`delete-data`、`close-all` 或 `kill-all`。使用本 CLI 的 `session stop`。

数据根目录首次使用时必须为空。私有所有权标记会阻止初始化操作修改不相干的非空目录。CLI 会拒绝位于浏览器用户数据目录树内的数据根目录。

每个目标只有一把会话锁。每次启动都会在这把锁的保护下创建干净的持久化 profile，并通过 `run-code` 调用 `page.context().setStorageState(path)` 加载状态。这样可以避免缩小导出范围后，旧的 localStorage 或 IndexedDB 数据仍然保留。该 profile 在同一会话的多次 agent 命令之间持续存在。停止会话会删除该会话的 profile；任务写入的改动不会保存回不可变快照。会话运行期间执行刷新或同步，只会影响下一次会话。

并发启动会失败。无法识别的锁也会导致启动失败。浏览器崩溃会留下失效锁，必须明确执行 `session stop` 处理。停止操作只会调用工具在私有工作目录中拥有的具名会话。只有 `ps` 确认没有浏览器或 CLI daemon 使用该 profile 后，才会移除锁。如果 `ps` 不可用、所有权元数据损坏或浏览器仍在运行，锁会保留。SIGKILL 留下的失效 `.operation` 目录，必须由操作者检查后才能手动删除。切勿通过删除锁来绕过仍在运行的浏览器。

## SSH 约定

SSH 必须显式启用，没有默认主机。在远程机器上安装**相同版本的本 CLI 及其依赖**。提供 Node、CLI 和私有根目录的绝对路径。先在远程机器上显式登记一个**本地**目标。没有任何命令会在远程机器上安装代码或浏览器。

```sh
# 通过你自行授权的连接，在远程机器上执行：
/absolute/node /absolute/playwright-profile/dist/cli.js \
  --data-root /absolute/private-root target add remote-browser

# 在本地登记并使用：
playwright-profile target add server \
  --ssh-host user@explicit-host \
  --remote-root /absolute/private-root \
  --remote-node /absolute/node \
  --remote-cli /absolute/playwright-profile/dist/cli.js \
  --remote-target remote-browser
playwright-profile sync work server
playwright-profile session start server
playwright-profile session stop server
```

SSH 命令的各参数会分别按 shell 规则转义，并使用 BatchMode 和连接超时。身份验证与主机密钥验证仍由 OpenSSH 负责。传输时，经由 stdin 向 `internal receive <target>` 发送一个封装对象。接收端在暂存凭据文件前，会验证 JSON、大小、schema、状态和 SHA-256。随后重命名不可变版本目录，并原子替换 `current.json`。上传或校验和验证失败时，会保留旧指针。响应丢失时，远程启用操作可能已经成功：重试前先检查远程状态。本机上的 `status` 按设计不会联系 SSH。远程 `session start` 的回执包含远程调用示例，必须在对应主机上执行。

## 状态、配置与回执

```
private-root/
  config.json
  sources/<name>/versions/<timestamp-uuid>/{envelope.json,state.json}
  sources/<name>/current.json
  targets/<name>/versions/<timestamp-uuid>/{envelope.json,state.json}
  targets/<name>/current.json
  targets/<name>/session-lock/{owner.json,profile/,workspace/}
  receipts/<operation>.json
  daemon/                   # 隔离的上游注册表和错误文件
  upstream-global/          # 隔离且为空的上游全局配置根目录
  schedules/                # 仅由定时任务命令创建
  tmp/                      # 源克隆和导出的工作目录
```

目录权限为 0700，凭据文件权限为 0600。凭据版本不可变且会保留，没有自动删除策略。配置使用严格的 schema 1 JSON，包含 `sources` 和 `targets` 字典。源字段为 `browser`、`profile`、`userData`、`app`、`domains`、`origins`。本地目标字段为 `kind: "local"` 和可选的 `executable`。SSH 字段为 `kind: "ssh"`、`host`、`root`、`node`、`cli`、`target`。未知字段、无效名称和不安全路径都会导致失败。登记时拒绝覆盖已有名称。要改变范围，先停止依赖它的会话，再审慎编辑私有配置，然后刷新并同步。下一次启动始终使用干净的 profile。

命令输出 JSON 回执。成功回执包含状态，以及适用的 `version`、`checksum`、`cookieCount`、`origins`、`failedCollections` 和 `warnings`。失败时返回非零退出状态，并将安全的错误代码输出到 stderr。验证错误不会输出输入值。`status` 报告本地源版本、本地目标所有权、操作锁、保留的临时目录、定时任务状态和最新操作回执，不包含 cookie、localStorage 或 IndexedDB 的值。Launchd 输出使用同一种安全回执格式。

## 验证

```sh
npm run typecheck
npm run verify
npm run verify:upstream
npm run verify:package
python3 /path/to/skill-creator/scripts/quick_validate.py skills/playwright-profile
```

`verify` 是可重复运行的隔离目录协议验证，使用合成 SQLite 存储和**本地假 SSH 可执行文件**。它不会启动浏览器，也不会联系 SSH 服务器。它覆盖过滤、格式错误的状态、旧版本保留、SQLite 损坏、活跃 WAL 与源文件哈希不变、macOS 上的重复显示名称、macOS 上的浏览器不匹配、锁占用、接收回执、中断和校验和失败。

`verify:upstream` 使用实际固定版本的上游 CLI。在 macOS 上使用**空的一次性 Chrome Beta profile**，在 Linux 上使用已安装的 Chromium。它只使用 `about:blank` 和合成存储，不使用真实网站、登录或个人 profile。它验证基于文件的 `run-code` 采集、隔离环境、跨 `cwd` 定位、macOS 上带合成 cookie 的一次性源克隆导出、macOS 上对合成加密 cookie 的拒绝、独立目标加载、并发占用、重启、范围缩小和清理。这些是运行时集成证据，不是业务 E2E 验收。

脚本会删除自己的临时数据，并将不含敏感信息的报告写入 `evidence/protocol.json` 和 `evidence/upstream.json`。报告只包含检查名称和结果，不包含 profile 路径或状态值。只有两个脚本都通过后，才能声称具备它们各自对应的证据。这里不声称验证过真实 SSH、个人数据解密、真实登录或已启用的 launchd 定时任务。没有新增单元测试套件。

参见[架构](docs/architecture.md)、[失败模式](docs/failure-modes.md)和随包附带的 [agent skill](skills/playwright-profile/SKILL.md)。
