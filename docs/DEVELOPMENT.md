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

`dsh-tools` 的 peer 范围是 `^0.1.6-alpha.2 || ^0.1.7-alpha.1 || ^0.2.0-rc.1`——三条版本线都兼容。注意用单个 `>=…<…` 范围会因为 node-semver 的 prerelease 语义漏掉 `0.1.7-alpha.1`，必须给每个 patch 各写一个 `^` 分支。

### peer 范围怎么维护（省事的关键）

**规则：一条 `0.x` 版本线写一个 `^0.x.0-0` 分支，发一次就够了。**

`^0.1.7-alpha.1` 编译出来是 `>=0.1.7-alpha.1 <0.2.0-0`——**上界只由第二位决定**。于是同一条线内的所有 pre-release 与正式版都被自动覆盖，**DSH 发 `0.1.7-alpha.2` / `0.1.7-rc.1` / `0.1.7` / `0.1.8-alpha.1` / `0.1.9` 都不需要动本插件**。只有第二位从 `0.1` 抬到 `0.2`（或 `0.2` 抬到 `0.3`）时才会掉出去，那时才需要跟进。

因此推荐把每条线写成 `-0` 形式，一次覆盖整条线：

```jsonc
"@deepseek-ai/dsh-tools": "^0.1.6-alpha.2 || ^0.1.7-alpha.1 || ^0.2.0-0"
//                                                            ^^^^^^^ 覆盖 0.2.x 全线（含 0.2.0-alpha.1）
```

`^0.2.0-0` 与 `^0.2.0-rc.1` 的差别**只在 `0.2.0` 的 pre-release**：前者连 `0.2.0-alpha.1` 也覆盖，后者从 `rc.1` 起。若某个 `0.2.0-alpha.x` 已经发过且接口不兼容，就不要用 `-0`，改用具体的 `^0.2.0-rc.1`（本插件当前即如此，因为已确认真实发布列表里 `0.2.0` 的第一个 pre-release 是 `rc.1`）。

> 历史版本（`0.1.5` 线）不需要保留分支——没人会用 `0.1.5` 装这个插件的当前版本，写进去只会让范围变长且难以理解。

**为什么 `0.2.0-rc.1` 必须显式写出来**：DSH 自 `0.2.0-rc.1` 起在启动时执行整包兼容性闸门（`dsh-app-boot` 的 `evaluatePluginCompatibility()`）——遍历 manifest 里所有名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer，用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 逐个判定；**只要有一个不满足，整个 bundle 被宿主跳过**（`skipping profile bundle`），安装本身却会成功，因此症状是「工具莫名消失」而非安装报错。`0.2.0-rc.1` 不落在 `^0.1.7-alpha.1` 内（semver 的 caret 不含更高 minor 的 prerelease），所以升级 DSH 后必须由插件追加该区间。

**判断要不要发版的最快方法**——把 DSH 的版本号丢给专用脚本，别靠猜：

```bash
npm run check:peer              # 不给参数：读本地实际安装的 DSH 版本
npm run check:peer -- 0.2.1-rc.1   # 指定版本：DSH 刚发新版时先问一句
```

输出会直接告诉你「覆盖 / 未覆盖」，未覆盖时还会给出可粘贴的建议分支。退出码 `0` = 不用发版，`1` = 需要追加分支。

> 别用 `node -e "require('semver')…"` 那种一行写法：插件的 `node_modules` 里**解析不到 `semver`**（它只在宿主的依赖树里），实测会直接 `Cannot find module 'semver'`。`scripts/check-peer-range.mjs` 自带了极简 semver 实现，与 `selfcheck.mjs` 同源，因此不依赖任何外部包。

自检里也有等价护栏：`selfcheck.mjs` 会用**本地实际解析到的第一方包版本**判定 peer 覆盖，不覆盖就 FAIL（`peer 范围覆盖当前运行时 …`）。所以升级 DSH 后先跑 `npm run check`，它会直接告诉你需不需要改 manifest。

> 这条闸门只看 peer **范围**，不看代码实际用到的接口——所以「追加区间」前必须先确认运行时接口没变，否则等于把一次明确的拒绝换成一次静默的运行期崩溃。本插件的 0.2.0-rc.1 适配已逐项核对：`dsh-tools` 仍导出 `defineTool`；`dsh-settings` 的 `SettingsForms` 仍提供 `describe(options)`（`user` / `base` / `value` 三层语义未变）与 `configure({ auto })`；`dsh-client-ui-settings` 仍提供 `configForms` 服务。因此这是**纯 manifest 变更**，`index.js` 与 `lib/` 一行未改。

DSH 的设置接口在 `0.1.6` 与 `0.1.7` 是两套不兼容的实现：`0.1.6` 的 `SettingsProvider` 提供 `get(ns)` / `installSection(...)` / `describe()`；`0.1.7` 的 `SettingsForms` 不再有这三者，只有 `configure/describe/update/replace/mutate`，配置改由插件条目的 `cordis.patch.yml` 承载。`0.2.0-rc.1` **沿用 `0.1.7` 的 `SettingsForms` 表面**（无 `get` / `installSection`），因此运行期探测直接命中 `0.1.7+` 分支，无需第三套判断。`index.js` 用 `typeof settings.get === "function"` 在运行期二选一，浏览器半侧用 `ctx.get("configForms")` 与 `ctx.get("settingsScope")` 探测可用服务。

**两个容易踩死的坑（都已在真实 0.1.7 上验证）：**

1. **服务不能写进 `inject`。** `inject` 里的服务是**激活依赖**：服务缺席时条目会永远停在 `pending (waiting for service: …)`，整个 profile 报 `Failed to load plugins`。runner 的读 guard（`ctx.get(name)` 对未声明服务返回 `undefined` 而不抛错）只保证**读**不炸，不改变激活语义。所以浏览器半侧的 `inject` 只有 `["slots"]`，`settingsScope` / `configForms` 一律用 `ctx.get(name)` 可选探测。

2. **`Config` 必须逐字段标 `.volatile()`，否则 0.1.7 的配置页根本不显示这个插件。** `dsh-settings` 的 `describe()` 对每个活动条目调用 `volatileForm(schema)`，**返回 `undefined` 的条目整条被丢弃**：

   ```
   volatileForm(schema):
     schema.meta.volatile  -> 整个 schema 变表单
     type === 'object'     -> 递归收集标了 volatile 的子字段
     否则                   -> undefined（条目被 describe 剔除）
   ```

   判定条件与插件来源无关（第一方 `dsh-web-search-deepseek` 同样逐字段标记）。连带影响：volatile 字段**求值时返回引用对象**（`Config({})` → `{ site: {}, … }`），所以 `defaultConfig()` 改读 `meta.default`；且**不能**标在根节点上（会让整个 schema 变惰性引用，默认值都读不出）。

3. **机密字段的「已落地」确认通道在 0.1.7 下会失效，必须换判据。** 两个事实叠在一起才会触发：

   - `redactSecrets()` 把 `role('secret')` 字段从下发的 user 层里**整个删掉**（实测：override 里有 `apiKeyIntl`，浏览器收到的 `user` 只有 `site`/`plan`/`gifWidth`），所以 `userKeys()` 对机密字段永远回答「没有」；
   - 0.1.7 的 `mutate()` **返回 boolean**（`false` = Host 拒绝，见 `dsh-client-ui-settings/lib/client.js` 的 `if (!response.ok) { …; return false; }`），而 0.1.6 返回 `void`。

   旧代码只看回读、且对机密字段判定「`userKeys` 里没有 = 未生效」，于是**每次保存 API Key 都误报「保存未生效」**（写入其实成功了）。修法是两层：
   - 以 `mutate()` 的返回值为首要判据（`false` 直接报错；`true`/`undefined` 才继续核对）；
   - 核对时用 `verifyVisible()` 跳过机密字段——Host 已明确接受时，不该再用「看不见的字段」去否定它。

   同时 Host 侧补上 `settingsUserKeys`：0.1.7 下 `rawConfig` **就是** profile patch 的覆盖层，`Object.keys(rawConfig)` 天然就是「用户覆盖了哪些字段」。客户端 `userKeys()` 只从中挑选 `SECRET_KEYS`，因此非机密字段的状态不受影响。

4. **volatile 字段求值返回引用对象，绝不能让它流进路径或持久化。** 这是全字段 `.volatile()` 的连带代价，也是本项目踩过的最隐蔽的一个坑：

   ```
   Config({}).outDir  ->  {}      // 不是 ""
   Config({}).site    ->  {}      // 不是 "cn"
   ```

   volatile 字段在 Schemastery 里是「可变的活引用」，取值必须 `.get()` 解包（第一方 `dsh-web-search-deepseek` 读配置时正是逐字段 `config.apiKey.get()`）。本插件**不**做解包，而是把 schema 当默认值声明表读（`defaultConfig()` 读 `meta.default`），所以自身拿到的值是对的。

   但只要上游任何一环把**求值结果**当作行配置传进来，`cfg.outDir` 就成了对象，随后 `path.resolve(cwd, {})` 抛出：

   ```
   The "paths[1]" argument must be of type string. Received an instance of Object
   ```

   ——一个与「生成图片」毫无关系、每次调用都复现、且完全无法从报错反推原因的错误。防线分三层：

   - `apply()` 丢弃行配置里的非标量非数组值（回落默认值，并 warn 出被丢掉的键）；
   - `pathFromConfig()` / `sessionCwd()` 把所有「配置 → 路径」的取值收敛成字符串；
   - `generateImage` / `generateVideo` / `toGif` 各自再挡一道，给出「outDir 不是字符串」这种可诊断的错误，而不是让 `path.*` 抛出类型错误。

   三层彼此独立，任何一层单独存在都能挡住这个故障——这正是反向验证时需要**同时**去掉三层，才能让测试复现出原始报错的原因。

5. **0.1.7 下配置必须实时读，且要读 `describe()` 的 `user` 层而不是 `value` 层。** `rawConfig` 是 **`apply()` 那一刻**的行配置快照，配置卡写入 profile patch 后 DSH **不会重新调用 `apply()`**——只认 `rawConfig` 的话，界面显示「已保存」、patch 文件也真的变了，工具却仍报「未找到 Agnes API Key」。

   修法是让 `settingsSource` 在 0.1.7 下问 `describe()`。`describe()` 给每个活动条目返回三层**未脱敏**的值：

   | 层 | 含义 | 能否用作 `settingsSource()` |
   |---|---|---|
   | `value` | 全字段生效值（默认 + 组合层 + 用户层） | **不能**——含默认值，会盖掉 `rawConfig` |
   | `base` | 组合层 | 不能 |
   | `user` | 用户真正写下的覆盖层（只有那几个键） | **是** |

   误用 `value` 层的实测后果：`rawConfig = { site: "intl", apiKeyIntl: "sk-…" }` 被 describe 的默认值 `site: "cn"` 盖掉 → 去中国站找 Key → 再次「未找到 Agnes API Key」。

   另外**不能**传 `{ redactSecrets: true }`：那是给远程/浏览器调用方用的，会按 `role('secret')` 把密钥整个抹掉（实测 user 层只剩 `site`）。Host 进程内部读取要的就是原值。

   代价是 `describe()` 遍历全部活动条目，实测约 3.4ms/次（约 30 个条目）——对一次几秒到几分钟的生成调用可忽略。**刻意不加缓存**：配置卡保存与工具调用可能只隔几十毫秒，任何 TTL 都会让用户看到「保存了却没生效」（这一点在自检里被一条断言钉住了）。

6. **「用户覆盖了哪些键」只能有实时这一个来源，且刷新不能被互斥挡掉。** 用户点「清除已配置的 Key」后输入框仍显示「已配置」，是两个问题叠出来的：

   - `settingsUserKeys` 曾把 `apply()` 时刻的 `Object.keys(rawConfig)` 与实时 user 层**取并集**。那个快照在用户清除后不会更新，键名就永远留在 `overriddenKeys` 里，界面据此画的「已配置 / 重置」标记也就永不消失。而 `describe().user` 读的就是 profile patch 的当前内容，与 `rawConfig` 同源**且实时**，单个来源即可覆盖「patch 里写的」与「配置卡刚改的」两种情况——不需要快照兜底。
   - `refreshStatus()` 在 `statusLoading` 为真时**直接 return**。清除 Key 时若恰好有一次诊断请求在飞，这次刷新就被丢掉，`this.status` 停留在清除之前的内容。因此加了 `refreshStatus(force)`：`clearKey()` 与 `save()` 传 `force`，等前一次结束后再拉一次。

自检（`selfcheck.mjs`）覆盖了两条路径，并把「全字段 volatile」「默认值走 `meta.default`」「0.1.7 保存 Key 不误报」「路径参数不被 volatile 空壳污染」「配置卡保存后工具立刻读到 Key」「清除 Key 后标记消失」六条前提钉成了断言。后四条都经过反向验证：把修复回退（或误用 `value` 层）后，测试会复现出与用户报告**逐字一致**的现象。

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