# 开发与测试

面向**开发者**（改这个插件源码的人）的说明。使用者安装 / 配置请看主 [README](../README.md)。

## 离线自检

```bash
npm run check          # 等价于 node selfcheck.mjs
```

检查依赖声明、manifest/patch 形状、工具定义合法性、参数校验是否生效、settings schema 的信封与机密标记、默认配置的单一来源与一键恢复默认、Host 与浏览器两半的字段名契约、两站密钥的分离与脱敏、站点路由（请求真的发往选定站点）、布局不变量（控件不重叠），以及浏览器半侧 bundle 能否加载并注册。全通过会打印 `XXX PASS / 0 FAIL`。

其中恢复默认与「保存成功」的判定都用**真实的 `CardController`** 配一个假 scope 跑，包括模拟「Host 静默拒绝写入」——`scope.mutate()` 在这种情况下也会正常返回，所以自检专门验证界面不会对着一次被拒绝的假报成功。

除离线自检外，发布前建议再用**真实上游服务**跑一遍：自检用假 ctx，抓不到「我们的假设与上游不一致」这类错误。详见下文[用真实上游验证](#用真实上游服务验证发布前)。

## 依赖与目录结构

Host 侧使用两个第一方依赖，在 `peerDependencies` 里声明（版本随宿主提供）：

| 依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool`——工具定义、参数编译与校验 |
| `@deepseek-ai/schemastery` | 配置 schema（`.default()` / `.min()` / `.role('secret')`） |

`dsh-tools` 的 peer 范围是 `^0.1.6-alpha.2 || ^0.1.7-alpha.1`——两个版本线都兼容。注意用单个 `>=…<…` 范围会因为 node-semver 的 prerelease 语义漏掉 `0.1.7-alpha.1`，必须给每个 patch 各写一个 `^` 分支。

DSH 的设置接口在 `0.1.6` 与 `0.1.7` 是两套不兼容的实现：`0.1.6` 的 `SettingsProvider` 提供 `get(ns)` / `installSection(...)` / `describe()`；`0.1.7` 的 `SettingsForms` 不再有这三者，只有 `configure/describe/update/replace/mutate`，配置改由插件条目的 `cordis.patch.yml` 承载。`index.js` 用 `typeof settings.get === "function"` 在运行期二选一，浏览器半侧用 `ctx.settingsScope` 是否存在判断（guard 对「已声明但未提供的服务」返回 `undefined` 而不抛错，因此 `inject` 里保留 `"settingsScope"` 是安全的）。自检（`selfcheck.mjs`）覆盖了两条路径。

```
.
├── package.json           # dsh.bundle.patch 指向组合层；dsh.client 声明浏览器半侧
├── cordis.patch.yml       # 向 profile 插入插件行
├── selfcheck.mjs          # 离线自检
├── index.js               # Host 插件：注册工具 + settings namespace + 诊断路由 + 内置技能
├── lib/
│   ├── client.js          # Agnes API：密钥、图像生成、视频创建与轮询
│   ├── rate-limit.js      # 跨进程滑动窗口 RPM 限流器
│   ├── gif.js             # 本地 ffmpeg 两遍调色板转 GIF + ffmpeg 探测
│   ├── config-schema.js   # 配置 schema（真实 Schemastery）
│   ├── client-bundle.js   # 浏览器半侧：插件页里的配置卡（手写 lazy-CJS bundle）
│   └── util.js            # 时间戳、slug、Data URI、超时
└── skills/
    ├── agnes-image/SKILL.md
    └── agnes-video/SKILL.md
```

**为什么能直接 import**：从 npm 安装的插件在 profile 里是真实目录，Node 的祖先目录查找会命中宿主在 profile 里放的第一方包目录。已发布的第三方 DSH 插件正是这样做的。

**唯一会失败的场景是本地 `link:` 安装**（见下），需要额外的 `node_modules` 准备。

> 早期版本为了绕开第一方包解析问题，自带了一份手写的 `defineTool` 替代品和手写的 Schemastery 兼容 schema。**两者都已删除**：它们只在本地 `link` 开发时才有必要，代价是约 700 行自研代码、与上游分叉的 schema 语义，以及每次 DSH 升级都要自己跟。开源给别人用的插件不该背这个。

## 三层生效边界（最容易踩的地方）

| 改动 | 生效方式 |
|---|---|
| `index.js` / `lib/*.js`（Host 侧源码） | **必须重启 dsh 进程** |
| `lib/client-bundle.js`（浏览器半侧） | 浏览器端 HMR 重载，必要时刷新页面 |
| Web 配置卡 / `settings.yaml` | **立即生效**，无需重启 |
| profile 的 `cordis.patch.yml` 里某个 `config` 段 | 视 profile 的 `patchReload` 而定 |
| 换版本、增删 bundle 成员 | **必须重启 dsh 进程** |

为什么改 JS 必须重启：本地 `link:` 让磁盘上的文件是新的，但运行中的进程早已把模块拉进 Node 的 ESM 缓存，且 dsh 通常不监听插件源码目录。

## 安装来源决定「更新」的语义

- **本地路径** → pnpm 装成 `link:`（目录联接），`node_modules/<pkg>` 是 junction，真实文件仍是仓库那一份，**改仓库文件后 profile 侧立刻是新的**，不需要重新安装。但要额外准备 `node_modules`（见下）。
- **tarball / npm** → 装成真实目录快照，内容是打包那一刻的副本，之后改仓库文件对已装副本毫无影响。这是**使用者会走**的路径，发布前务必用这种方式验证一次。

### 本地 `link:` 安装需要一步额外准备

本地路径安装（junction，realpath 在 profile 之外）会让 Node 的祖先查找走不到宿主的第一方包目录，于是 `import "@deepseek-ai/dsh-tools"` 直接 `ERR_MODULE_NOT_FOUND`。

解决办法：在插件仓库内放一份 `node_modules/@deepseek-ai/*` 联接。Node 查找 bare import 时先看导入方最近的 `node_modules`，所以 realpath 也能命中：

```bash
mkdir -p node_modules/@deepseek-ai
# 把 dsh-tools、schemastery 联进仓库内的 node_modules（Windows: mklink /J；macOS/Linux: ln -s）
```

`.gitignore` 已忽略 `node_modules/`，这份联接不会进仓库，也不进 npm 包（`npm pack` 的 `files` 白名单里没有它）。

> 这只影响开发。**发布物不受影响**：从 npm 或 tarball 安装时插件是真实目录，祖先查找天然命中宿主提供的副本。

## 开发回路

1. **回路 A：正式安装（发布前最后一步）**——`npm pack .` 后用 tarball 以使用者会走的方式安装，验证裸 import 能被解析。这是发布前唯一可信的端到端检查。
2. **回路 B：`--patch` overlay（日常开发）**——patch 里的插件名支持绝对路径，可直接指向入口文件，不改 profile 的依赖 / bundles，适合反复调工具 schema 与参数校验。改 JS 同样要重启，但省掉安装 / 卸载往返。
3. **回路 C：离线自检**——`node selfcheck.mjs`，不起 dsh、不碰网络、不需要账号，随时跑。
4. **回路 D：卸载**——`dsh plugin --profile <profile> remove <pkg>`，或 GUI Plugins 页面。

## 用真实上游服务验证（发布前）

自检用假 ctx，抓不到「我们的假设与上游不一致」。发布前建议再跑一遍真实服务的集成检查：解包 tarball 到一个真实目录、补上 peer 依赖，用真 `Context` + `SettingsProvider` 验证注册 / 脱敏 / 写入 / 拒绝四条路径。

本项目实测确认过的行为（都是容易踩错的地方）：

| 行为 | 实测结果 |
|---|---|
| 空输入求值 | `Config({})` 返回全部 `.default()`，三个密钥字段（`apiKeyCn`/`apiKeyIntl`/`apiKey`）缺省 |
| 非法值 | **抛错**（`$.imageRpm1K expected number >= 0 but got -5`），不静默改写 |
| 未知键 | **保留**在解析结果里，但不声明进 `dict`（所以表单渲染不出它） |
| `redactSecrets` | 把**每一个**声明为 secret 的字段从 `value`/`user` 中**删除**，并在 `secrets` 里逐一留下 `{path,set}` |
| 未声明的旧键 | **不会**被脱敏——旧版 `apiKey` 若从 schema 移除会原样泄露，因此保留了 hidden 声明 |
| user 层有非法值 | `register()` 抛错 → `index.js` 降级为 `logger.warn`，插件行仍加载、配置卡消失 |
| `defineTool` 的 `required` | 编译到 object 根（`required: ['prompt']`），不是属性上 |
| `defineTool` 的 `enum` | 保留在属性节点上 |

## 浏览器半侧的约束

`lib/client-bundle.js` 必须是 loader 的 **lazy-CJS factory bundle**（顶层调用 `window.__ModuleLoader__.load({ id, factory })`），且 `id` **必须严格等于包名** `dsh-agnes-gen`——对不上会报 `bundle loaded without registering`。

官方仓库内的包由 `tsdown` 的 `clientBundle` 预设产出这个格式，而该预设并未作为独立包发布，所以本插件是**手工复刻**——没有构建步骤，改完直接生效。文件里用 `React.createElement`（没有 JSX 转换），只 `require("react")`。

## 关键实现约定

- 工作目录取 `exec.agent.session.header.cwd`（**不是** `session.meta.cwd`），所以默认输出落在会话工作目录下而非 dsh 进程的启动目录。
- `defaultConfig()` = `Config({})` 是默认值单一来源；`publicDefaults()` 剔除机密字段。恢复默认逐字段 `unset`，不用 `path:[]` 整节清空（否则会抹掉已存密钥）。
- 模型按 id 前缀分类：含 `image` → 图像，含 `video` → 视频，否则当文本忽略。`/v1/models` 响应是 OpenAI 兼容的 `{ data: [{ id }] }`，**没有 type 字段**。
- 两站模型白名单彼此独立（国际站可能比中国站多某些模型），每站一套「可选集 + 选中项」。
- 深度相等必须深比较数组，否则数组字段保存后会误报「保存未生效」。

## 排障清单

- 本地 `link:` 安装裸 import 报 `ERR_MODULE_NOT_FOUND` → 检查仓库内的 `node_modules/@deepseek-ai/*` 联接是否就位。
- 浏览器半侧加载报 `bundle loaded without registering` → 检查 `client-bundle.js` 里 `id` 是否严格等于包名。
- 某些沙箱禁止 Node 通过管道捕获子进程输出，`spawnSync` 必须用 `stdio: 'inherit'/'ignore'`，否则 ffmpeg 会被误报 EPERM。