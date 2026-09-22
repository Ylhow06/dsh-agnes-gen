# dsh-agnes-gen

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![version: 0.1.0](https://img.shields.io/badge/version-0.1.0-blue)

Agnes AI 图像 / 视频生成插件，为 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 添加两个模型可见工具 `agnes_image` 与 `agnes_video`。内置跨进程 RPM 限流、429 退避，以及用本机 ffmpeg 把视频转成 GIF。

这是一个 DSH **bundle 插件**，不是独立脚本。装进某个 profile 后，该 profile 的每个 session、每个 workspace 都能用。

## 功能

- ✨ **两个工具**：`agnes_image`（文生图 / 图生图 / 多图合成）、`agnes_video`（文生视频 / 首尾帧动画 / 图生视频）。
- 🚦 **内置跨进程 RPM 限流**：本地滑动窗口配额池，多会话 / 多进程并发时合计计数，避免撞 Agnes 的 429。
- ⏱ **429 退避**：自动等待服务端 `Retry-After`（上限 120 秒），不无意义重试。
- 🎞 **本地 GIF 转换**：视频转 GIF 走本机 ffmpeg，纯本地、不额外计费；ffmpeg 缺失时自动降级为仅返回 mp4。
- 🗝 **按站点管理密钥**：中国站 / 国际站两套 Key 分开保存、互不通用。
- 🎛 **Web 配置卡**：在 DSH Web GUI 的「插件」页直接配置站点、API Key、RPM 预设、模型白名单、ffmpeg 路径。
- 📚 **内置技能**：随插件附带 `agnes-image` / `agnes-video` 两个技能，引导 AI 正确调用工具。

## 安装

插件在三种 DSH 界面下均可运行：Web、Desktop、TUI。根据你使用的 profile 选对应命令安装。

### Web（推荐，自带预构建产物）

```bash
dsh plugin --profile web add dsh-agnes-gen
dsh web
```

或从 GitHub 源码安装 Web 版：

```bash
dsh plugin --profile web add github:Ylhow06/dsh-agnes-gen
dsh web
```

### Desktop（桌面版）

```bash
dsh plugin --profile desktop add dsh-agnes-gen
dsh --profile desktop
```

### TUI（终端界面）

```bash
dsh plugin --profile dsh-tui add dsh-agnes-gen
dsh --profile dsh-tui
```

也可以用 Web GUI 的 **Plugins** 页面添加包名 / tarball 路径，或从本地 tarball 安装：

```bash
npm pack .
dsh plugin --profile <profile> add ./dsh-agnes-gen-0.1.0.tgz
```

> **前置条件**：宿主 DSH 需提供 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`（本插件在 `peerDependencies` 里声明）。任何正常安装的 DSH `0.1.6-alpha.2` 都自带这两个包，无需手动安装。

### 申请 Agnes API Key

本插件不包含、也不会替你申请 API Key。到 Agnes 平台注册并创建一个 Key：

| 站点 | `site` | 申请地址 | API 主机 |
|---|---|---|---|
| 中国站 | `cn`（默认） | <https://platform.agnes-ai.cn/settings/apiKeys> | `https://api.agnes-ai.cn` |
| 国际站 | `intl` | <https://platform.agnes-ai.com/settings/apiKeys> | `https://apihub.agnes-ai.com` |

### 在 Web 配置卡填 Key

打开 DSH Web GUI → 侧栏「插件」→ 点开 `dsh-agnes-gen` 卡片。最上面是「Agnes 站点」下拉框，下面是**当前那一站**的 Key 输入框：

1. 先选对站点（中国站 / 国际站）；
2. 填对应那一站的 API Key；
3. （可选）点「校验 Key & 拉取模型」，即刻验证 Key 有效并从 `/v1/models` 导入当前站的模型白名单；
4. 点「保存」。

> ⚠️ **两站的 Key 不通用。** 中国站与国际站是两套独立服务、独立令牌体系，拿国际站的 Key 打国内站只会得到 401。界面按站点只显示对应那一个输入框，两站 Key 各存一份、各用一份。

### 开始生成

配置好之后，AI 即可调用两个工具。也可以在对话里显式触发：

```
agnes_image(prompt="日出薄雾峡谷上方的发光浮空城市，电影级写实，广角，高视觉密度")
agnes_video(prompt="夜晚森林中三只猫组成微型铜管乐队向前行进", seconds=5, gif=true)
```

## 两个工具

### `agnes_image`

| 参数 | 默认 | 说明 |
|---|---|---|
| `prompt` | 必填 | 提示词 |
| `model` | 当前站选中项 | 图像模型 ID，须在当前站的图像模型集内 |
| `size` | `1K` | `1K` / `2K` / `3K` / `4K` |
| `ratio` | `1:1` | `1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9` |
| `image` | — | 参考图数组，传入即图生图，多张为合成 |
| `output_name` | — | 自定义文件名主名（纯名，不带时间戳）；不传则用提示词前 16 字符自动短名 |

返回：`files`（本地绝对路径）、`urls`、`size`、`ratio`、`mode`、`task_id`。

### `agnes_video`

| 参数 | 默认 | 说明 |
|---|---|---|
| `prompt` | 必填 | 提示词 |
| `seconds` | `5` | 4–12 的整数 |
| `ratio` | `16:9` | `21:9 16:9 4:3 1:1 3:4 9:16` |
| `size` | `720P` | Flash 只支持 `720P`；`agnes-video-2.5` 可用 `720P/1080P/1K/2K` |
| `model` | 当前站选中项 | 视频模型 ID，须在当前站的视频模型集内 |
| `mode` | 自动推断 | `text` / `keyframe` / `reference` |
| `first_frame` / `last_frame` | — | keyframe 模式的帧 |
| `image` / `audio` | — | reference 模式参考素材 |
| `seed` | — | 随机种子 |
| `gif` | `false` | 是否转 GIF（纯本地，不额外计费） |
| `gif_width` / `gif_fps` | `480` / `12` | GIF 尺寸与帧率 |
| `gif_start` / `gif_duration` | — | GIF 截取范围 |
| `keep_mp4` | `true` | 转 GIF 后是否保留 mp4 |
| `output_name` | — | 自定义文件名主名，mp4 与 gif 共用 |

返回：`video_id`、`task_id`、`url`、`mp4`、`gif`、`gif_bytes`、`model`、`mode`、`seconds`、`size`、`aspect_ratio`、`warning`。

### 输出位置与文件名

- 图片默认写到会话工作目录下的 `out/agnes-images`，视频写到 `out/agnes-videos`（目录自动创建）。可用配置项 `outDir` 改变输出根目录。
- 传了 `output_name` 就用**纯名**（不带时间戳，会清洗为安全字符）；不传则用 `时间戳_提示词前16字符[_序号].ext`。
- **每次生成请给不同的 `output_name`**——纯名不带时间戳，同目录重名会直接覆盖前一个文件。

## 配置

配置分**两层**，运行时可改：

| 层 | 存放位置 | 改动生效方式 |
|---|---|---|
| 用户层 | DSH 的 `settings.yaml` 中 `agnes-gen:` 分节 | **立即生效**，无需重启；工具每次执行都重新读取 |
| 组合层 | profile 的 `cordis.patch.yml` 中该行 `config:` | 按 profile 的 HMR 生效 |

> 日常使用**推荐用 Web 配置卡**，它写的就是用户层。也可以直接编辑 `settings.yaml`：
> ```yaml
> agnes-gen:
>   site: cn                  # Agnes 站点：cn（中国站）| intl（国际站）
>   apiKeyCn: sk-...          # 中国站的 Key（仅 site: cn 时使用）；机密字段
>   apiKeyIntl: sk-...        # 国际站的 Key（仅 site: intl 时使用）；机密字段
>   plan: free                # 密钥档位预设：free | token-plan
>   rateLimit: true
>   outDir: ''
> ```

### 完整配置项

默认值**全项目只有一处来源**（`lib/config-schema.js` 里的 Schemastery `.default(...)`），所以下表默认值就是「恢复默认」回到的值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `site` | `cn` | Agnes 站点：`cn` / `intl`。决定请求主机与用哪个 Key |
| `apiKeyCn` | 无（缺省） | 中国站的 Key，机密字段。仅 `site: cn` 时使用 |
| `apiKeyIntl` | 无（缺省） | 国际站的 Key，机密字段。仅 `site: intl` 时使用 |
| `apiKey` | 无（缺省） | **已弃用**：旧版单键字段，仅保留作脱敏槽位，不再生效 |
| `plan` | `free` | 密钥档位预设：`free` / `token-plan`，决定各档位基线 RPM |
| `imageRpm1K`–`4K` | `0` | 逐档位覆盖，0 = 跟随预设。注意 3K/4K 恒为 1 RPM |
| `videoRpm` | `0` | 视频 RPM 覆盖，0 = 跟随预设。创建与轮询共用该池 |
| `rateLimit` | `true` | 是否启用本地跨进程限流 |
| `ffmpegPath` | `''` | ffmpeg 路径，留空 = 按 `PATH` 查找 |
| `gifWidth` | `480` | GIF 默认宽度，单次调用可用 `gif_width` 覆盖 |
| `gifFps` | `12` | GIF 默认帧率，单次调用可用 `gif_fps` 覆盖 |
| `outDir` | `''` | 输出根目录，留空 = `<cwd>/out/agnes-*` |
| `imageModel<Site>` | `agnes-image-2.5-flash` | 该站的**生效**图像模型 |
| `videoModel<Site>` | `agnes-video-2.5-flash` | 该站的**生效**视频模型 |
| `imageModels<Site>` | `["agnes-image-2.5-flash"]` | 该站的**可选**图像模型集（白名单） |
| `videoModels<Site>` | `["agnes-video-2.5-flash"]` | 该站的**可选**视频模型集（白名单） |

>`<Site>` ∈ `Cn` / `Intl`。以下三项不在配置卡、也不参与「恢复默认」，只能经组合层（`cordis.patch.yml` 的 `config:`）设置：`imageTimeoutMs`（默认 300000，图像请求超时）、`videoTimeoutMs`（默认 1800000，视频任务超时）、`videoPollMs`（默认 2500，视频轮询间隔）。

### 自定义模型

插件支持每站一套自定义模型白名单。「Agnes 站点」区、Key 框下方有模型下拉（当前站的图像 / 视频模型各一个）：

- **下拉即生效**：选中哪项，`model` 参数不传时默认就用哪项。
- **自定义**：下拉选「自定义…」可输入任意模型 ID。
- **一键导入**：填好 API Key 后点 Key 框旁的「校验 Key & 拉取模型」，自动从 `/v1/models` 导入当前站模型并按类型（图像 / 视频）分类进白名单。
- **白名单校验**：`model` 参数须落在当前站白名单内，取集外的 ID 会立即报错并列出可选值。

### 一键恢复默认

Web 配置卡底部的「恢复默认」会清除用户层里所有覆盖，让字段重新继承组合层与出厂默认值：

- **两段式确认**：第一下只变成「确认恢复默认？」，第二下才提交；任何编辑都会撤销。
- **一次原子写入**：所有 `unset` 在同一个 `mutate` 里提交，共享 revision 栅栏。
- **不碰 API Key 与站点 / 模型**：刻意逐字段清除，而不用整节清空，已存的 Key、站点选择与模型白名单全部保留。

## RPM 限流

Agnes 只公布 **RPM**（每分钟请求数），没有 RPS 概念；限制按**密钥类型**共享，不按单个 key 叠加——多建几个 key 不会增加配额。

| 类型 | 免费/默认 | Token Plan |
|---|---|---|
| 图片 1K | 20 | 100 |
| 图片 2K | 10 | 80 |
| 图片 3K | **1** | **1** |
| 图片 4K | **1** | **1** |
| 视频 | **1** | 5 |

> 3K / 4K 对所有档位都只有 1 RPM，批量任务请用 1K / 2K。这些是公开参考值，官方可能调整；可到你所用站点的控制台 Usage 页核对实际用量（`plan` 预设可以通过 `imageRpm*` / `videoRpm` 逐档位覆盖）。

限流在 `lib/rate-limit.js` 里用「滑动窗口状态文件 + 独占锁」做跨进程协调，多个会话 / 进程并发时**合计**计数。状态目录默认取系统临时目录下的 `agnes-ratelimit`：

- 该目录不可写时**自动放行**（fail-open），宁放宽不卡死请求；
- 锁超时后放行，且不会误删他人锁；
- 用环境变量 `AGNES_RATELIMIT_DIR` 可指到别的共享可写目录。

> 视频只有 1 RPM，所以创建任务与轮询**共用一个 `video` 池**：一个视频从创建到完成（通常 1–3 分钟）的轮询会持续占用该池，此时再发起新视频任务会等待。

## ffmpeg 与 GIF

`gif=true` 时需要本机 ffmpeg：

- 优先用配置里的 `ffmpegPath`（Web 配置卡可直接填）；
- 留空则按 `PATH` 里的 `ffmpeg` 查找。

GIF 用两遍调色板法（`palettegen` + `paletteuse`），画质优于单遍。**ffmpeg 不可用时不会导致工具调用失败**：视频照常生成并返回本地 mp4，`gif` 字段为空串，带一个 `warning` 字段说明原因。

## 诊断

插件注册了两条只读路由（仅本机回环可访问），供排障：

- `GET /plugins/dsh-agnes-gen/status`：返回 Key 与 ffmpeg 可用性、当前生效档位与逐档位 RPM。**从不返回密钥明文**，只报告「是否已配置」。
- `GET /plugins/dsh-agnes-gen/check`：实际调一次 `GET /v1/models` 校验 Key 有效性，并返回按类型分类的模型清单。同样不返回密钥明文。

```bash
curl http://127.0.0.1:3080/plugins/dsh-agnes-gen/status
```

## 安全说明

- `apiKeyCn` / `apiKeyIntl`（及历史字段 `apiKey`）在 schema 里都带 secret 标记，值会从**每个**对外响应中剥离，只在 descriptor 的 `secrets` 里留下 `{ path, set }`。
- 插件**不读环境变量、不读任何凭据文件**。唯一正确的配置 Key 的方式就是在配置卡 / `settings.yaml` 里填 `apiKeyCn` / `apiKeyIntl`。没填就直接报错，并指引去对应站点申请。
- 插件不打印密钥、不把密钥写进返回值或日志。

## 开发与自检

```bash
npm run check        # 等价于 node selfcheck.mjs
```

离线自检检查依赖声明、manifest、工具定义、参数校验、settings schema 的机密标记、默认配置单一来源、两站密钥分离与脱敏、站点路由、浏览器半侧 bundle 加载等。

> 完整的开发与测试说明（本地安装的三种回路、`link:` 安装的注意事项、发布前建议）见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## 手动安装 / 卸载

```bash
# 打包安装
npm pack .
dsh plugin --profile <profile> add ./dsh-agnes-gen-0.1.0.tgz

# 卸载
dsh plugin --profile <profile> remove dsh-agnes-gen
```

## 协议

[MIT](LICENSE)