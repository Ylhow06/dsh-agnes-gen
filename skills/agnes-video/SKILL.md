---
name: agnes-video
description: 使用 Agnes AI 视频模型（agnes-video-2.5-flash / agnes-video-2.5）生成视频，并把结果转成 GIF。当用户要求生成视频、文生视频、图生视频、首尾帧动画、做动图/GIF/循环动画、让某张图动起来时使用。
whenToUse: 用户提出"生成视频/做个动图/转成 GIF/让这张图动起来/首尾帧过渡"等视频或动图需求时。
---

# Agnes 视频生成（含 GIF）

用 **`agnes_video` 工具**访问 `agnes-video-2.5-flash` / `agnes-video-2.5`。异步任务：创建任务 → 轮询 → 下载 mp4 →（可选）用本机 ffmpeg 转 GIF。密钥在插件配置里用「Agnes 站点」面板填写（中国站 `apiKeyCn` / 国际站 `apiKeyIntl`）。

**GIF 是本地 ffmpeg 转换，不额外走接口、不额外计费。** 若本机没有 ffmpeg（缺 ffmpegPath / PATH 都找不到），GIF 转换会**降级**：视频照常返回 mp4，`gif` 字段为空串，并带 `warning` 提示原因。此时告诉用户"本机无 ffmpeg，已只生成 mp4"。

## 调用方式

文生视频并转 GIF（最常用）：

```
agnes_video(prompt="夜晚森林中三只猫组成微型铜管乐队向前行进，镜头平稳后退，月光穿过树叶", seconds=5, gif=true)
```

只要 mp4：

```
agnes_video(prompt="雨后街道霓虹倒映，银色跑车缓慢驶过，电影级运镜", seconds=5)
```

让已有图片动起来（首尾帧控制，本地路径会自动转 Data URI）：

```
agnes_video(prompt="人物从首帧姿态自然转身走向窗边，镜头缓慢推进", seconds=5, first_frame=".\\a.png", last_frame=".\\b.png")
```

图片参考（保持角色/风格一致）：

```
agnes_video(prompt="以 <Picture 1> 中的角色和画风为参考，角色在花田自然奔跑，低机位跟拍", mode="reference", image=[".\\char.png"])
```

GIF 细节调节：

```
agnes_video(prompt="...", gif=true, gif_width=720, gif_fps=15, gif_start=1, gif_duration=3, keep_mp4=false)
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `prompt` | 必填 | 提示词 |
| `seconds` | `5` | **4–12 的整数** |
| `ratio` | `16:9` | `21:9 16:9 4:3 1:1 3:4 9:16` |
| `size` | `720P` | Flash 只能 `720P`；`agnes-video-2.5` 可 `720P/1080P/1K/2K` |
| `model` | `agnes-video-2.5-flash` | 视频模型 ID；须在**当前站点**的视频模型集内。选 `agnes-video-2.5` 可用更多分辨率 |
| `mode` | 自动推断 | `text` / `keyframe` / `reference` |
| `first_frame` / `last_frame` | — | keyframe 模式的帧，至少给一个 |
| `image` / `audio` | — | reference 模式参考素材；Flash 参考图 ≤5、音频 ≤3，**不支持参考视频** |
| `seed` | — | 随机种子 |
| `gif` | `false` | 是否转 GIF |
| `gif_width` | `480` | GIF 宽度，高度按比例自适应 |
| `gif_fps` | `12` | GIF 帧率 |
| `gif_start` / `gif_duration` | — | 截取起点与时长（秒） |
| `keep_mp4` | `true` | 转完 GIF 后是否保留 mp4 |
| `output_name` | — | 自定义文件名主名（不含扩展名），mp4 与 gif 共用；不传则用提示词前 16 字符自动短名 |

> **输出目录**：工具没有 `out_dir` 参数。视频默认写到会话工作目录下的
> `out/agnes-videos`；操作者可在插件配置的 `outDir` 里改输出根目录。
> **文件名**：传了 `output_name` 就用**纯名**（如 `output_name="小猪打滚"` → `小猪打滚.mp4`），不带时间戳；
> 不传则用 `时间戳_提示词前16字符.mp4`，mp4 与 gif 同名。**每次生成请给不同的 `output_name`**，避免覆盖同目录同名文件。
> **模型白名单**：`model` 只能在配置卡「Agnes 站点」区、Key 框下方的模型下拉
> （**当前站点**的视频模型集）里选；选「自定义…」可输入任意 ID 作为生效项。
> 填了 API Key 可点「校验 Key & 拉取模型」自动从 `/v1/models` 导入当前站模型。
> 默认就是 `agnes-video-2.5-flash`，通常不用传。取集外的 ID 会被拒绝并提示可选值。

## 要点

- 提示词顺序：主体与场景 → 动作变化 → 镜头语言 → 视觉风格 → 声音节奏 → 一致性要求。
- 参考模式要在提示词里写占位符，如 `<Picture 1>`、`<Audio 1>`，并说明用途。
- 720P/16:9 实测输出 `1280x704`。
- 480px/12fps 的 4 秒 GIF 约 4 MB，给聊天/文档用建议这个量级；要更小就降 `gif_width` 和 `gif_fps`。
- **RPM 限制（重要）**：视频模型**不区分分辨率，只有一个档位**：免费/默认密钥「实际 RPM」= **1**（Token Plan = 5）。Agnes 只按 RPM 限流，没有 RPS 概念。
- **插件已内置跨进程限流**：创建任务与轮询**共用同一个 `video` 配额池**（文档里视频模型只有一个 RPM），多个会话/进程并发时合计计数。轮询默认间隔 2.5s 远超 1 RPM，因此由限流器统一节流到约每分钟一次——这也是之前 429 频发的原因。
- **1 RPM 意味着**：同时跑多个视频任务会串行排队；一个视频从创建到完成（通常 1–3 分钟）中间的轮询会持续占用该池，此时再发起新视频任务会等待。
- **429 退避**：轮询遇 429 按 `poll × 2^n` 退避、上限 30s；创建任务遇 429 改为等 60 秒（1 RPM 下短退避无意义），其余错误 5s/10s/15s。

## 实测坑（插件已处理，排障时参考）

- **视频地址在顶层 `url` 字段**，不是文档写的 `metadata.url`（实测 `metadata` 为 `null`）。插件两个都兜。
- **状态机**：`pending`(0%) → `in_progress`(长期停在 10%) → 直接 `completed`(100%)。不要按 `progress` 判断完成，只认 `status`。
- **轮询会遇到 HTTP 429**，插件自动退避，并把轮询间隔逐次放大到上限 10s；同时轮询本身也走 `video` 限流池。生成 4–5 秒视频通常耗时 1–3 分钟；默认轮询超时 30 分钟。
- **创建任务也会 429/5xx**，插件对其重试最多 3 次（429 等 60s，其余 5s、10s、15s）。
- ffmpeg 需在 PATH，或配置 `ffmpegPath` 指定路径；GIF 用两遍调色板法（`palettegen`+`paletteuse`），画质优于单遍。**ffmpeg 不可用时插件会降级：mp4 照常、`gif` 为空串 + `warning`，整条调用不会失败。**
- **沙箱限制**：某些沙箱禁止 Node 用管道捕获子进程输出，`spawnSync` 必须用 `stdio: 'inherit'/'ignore'`（插件已如此），否则 ffmpeg 会报 EPERM 而被误判为"未找到"。

## 交付

工具返回 `mp4` 和 `gif` 的本地绝对路径、`url` 云端直链、`video_id`。

- 用户要 GIF → 用 `present` 呈现 `gif`。
- 用户要视频 → 用 `present` 呈现 `mp4`。
- 两者都要 → 一起 present。

回复中说明模型、模式、时长、画幅和所用提示词。
