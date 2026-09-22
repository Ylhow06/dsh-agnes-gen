/**
 * Agnes API 客户端：密钥读取、HTTP 调用、图像生成、视频创建与轮询。
 *
 * 这一层不写 stdout/stderr，所有进度都通过 `log` 回调交给插件层，
 * 这样工具执行时能进到 DSH 的日志/session 里，而不是污染进程输出。
 *
 * @module dsh-agnes-gen/lib/client
 */

import fs from "node:fs";
import path from "node:path";
import { acquire, FREE_RPM } from "./rate-limit.js";
import { ensureDir, safeBaseName, slug, stamp, sleep, toDataUri, withTimeout } from "./util.js";

/**
 * Agnes 有两个**独立**的服务站点。
 *
 * 实测（HTTP 探测，2026-09）：两站的 API 路径完全一致
 * （`/v1/images/generations`、`/v1/videos`、`/agnesapi`），但**是不同的主机、
 * 不同的令牌体系**——同一路由分别返回 `未提供令牌` 与 `Token not provided`。
 * 因此 Key 不能跨站使用：拿国际站的 Key 打国内站的域名只会得到 401。
 *
 * 这正是不该把主机写死在代码里的原因。`site` 配置项让使用者选自己注册的那一站。
 */
export const SITES = {
  cn: {
    label: "中国站",
    base: "https://api.agnes-ai.cn",
    consoleUrl: "https://platform.agnes-ai.cn/settings/apiKeys",
  },
  intl: {
    label: "国际站",
    base: "https://apihub.agnes-ai.com",
    consoleUrl: "https://platform.agnes-ai.com/settings/apiKeys",
  },
};

/** 默认站点（历史行为就是这个，保持向后兼容）。 */
export const DEFAULT_SITE = "cn";

/** 站点可选值，供 UI 与校验共用。 */
export const SITE_VALUES = Object.keys(SITES);

/**
 * 取配置里的站点；未知取值回落到默认站。
 *
 * 容错而不是抛错：组合层（`cordis.patch.yml` 的 `config:`）能绕过 schema 校验
 * 直接塞值，此时宁可退回一个能用的站点，也不要让整个工具不可用。
 *
 * @param {{site?: string}} [config]
 */
export function siteOf(config) {
  return SITES[config?.site] ?? SITES[DEFAULT_SITE];
}

/** 图像生成端点（POST）。 */
export const imageEndpoint = (site) => `${site.base}/v1/images/generations`;
/** 视频接口根（创建 `/v1/videos`、查询 `/agnesapi` 都挂在它下面）。 */
export const videoBase = (site) => site.base;

export const IMAGE_MODEL = "agnes-image-2.5-flash";
export const VIDEO_MODEL = "agnes-video-2.5-flash";

export const IMAGE_SIZES = ["1K", "2K", "3K", "4K"];
export const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
export const VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
export const VIDEO_SIZES_25 = ["720P", "1080P", "1K", "2K"];
export const VIDEO_SIZES_FLASH = ["720P"];

/** 图片模型的请求退避序列；429 单独处理。 */
const IMAGE_RETRY_DELAYS = [3000, 8000, 15000, 25000, 40000];
/** 429（真实上限）默认等待窗口，服务端 Retry-After 优先。 */
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_WAIT_CAP_MS = 120_000;

/**
 * 读取 API Key。**唯一来源是显式配置**。
 *
 * 刻意不做任何环境/文件回退：`AGNES_API_KEY` / `AGNES_CN_API_KEY` 以及
 * `$DSH_HOME/.credentials.yaml` 都是作者本人环境里才有的约定，开源使用者没有。
 * 对插件的使用者来说，唯一的正路就是在插件配置里填 Key。没有就直接报错，
 * 把「去申请 Key / 填进配置」明确指出来，而不是悄悄从某个文件里捞。
 *
 * @param {string} [explicit] 来自 settings 配置的密钥（若有）
 * @param {object} [site]     站点描述，仅用于报错时指明去哪个控制台申请
 */
export function readKey(explicit, site = SITES[DEFAULT_SITE]) {
  const configured = typeof explicit === "string" ? explicit.trim() : "";
  if (configured) return configured;
  throw new Error(
    `未找到 Agnes API Key（${site.label}）：请在插件配置里填入 Key（apiKeyCn / apiKeyIntl）。` +
      `获取 Key：${site.consoleUrl}`,
  );
}

/**
 * 报告密钥来源，**绝不返回密钥本身**——供 Web 配置页与诊断使用。
 *
 * 卡片上的输入框是只写的，用户需要知道「我已经配过、正在生效」，
 * 而不是看到那串字符。**只认显式配置**，与 readKey 一致。
 *
 * @param {string} [explicit] 来自 settings 配置的密钥（若有）
 * @returns {{set: boolean, source: string}}
 */
export function keyStatus(explicit) {
  const configured = typeof explicit === "string" ? explicit.trim() : "";
  if (configured) return { set: true, source: "配置" };
  return { set: false, source: "" };
}

/** 把响应体解析成 JSON，并给错误附上 status / retryAfterMs。 */
async function toError(res) {
  const text = await res.text();
  const err = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  err.status = res.status;
  err.retriable = res.status === 429 || res.status >= 500;
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, RATE_LIMIT_WAIT_CAP_MS);
  return err;
}

/**
 * 一次 POST，带超时与取消。
 * @param {string} url
 * @param {object} body
 * @param {{key: string, timeout?: number, signal?: AbortSignal, log?: Function}} ctx
 */
async function postJson(url, body, { key, timeout = 300000, signal, log }) {
  const gate = withTimeout(signal, timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: gate.signal,
    });
    if (!res.ok) throw await toError(res);
    return JSON.parse(await res.text());
  } catch (err) {
    // 调用方取消 / 超时：给出可读信息，并保留失败原因
    if (err?.name === "AbortError" || gate.signal.aborted) {
      const reason = gate.signal.reason;
      const e = new Error(reason instanceof Error ? reason.message : "请求已取消或超时");
      e.aborted = true;
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    gate.dispose();
  }
}

/** 下载二进制到本地文件，返回路径与字节数。 */
async function download(url, file, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

/**
 * 拉取 `GET /v1/models` 并按 id 分类成图像 / 视频模型清单。
 *
 * Agnes 的响应是标准 OpenAI 格式（实测）：
 * ```json
 * {"data":[{"id":"agnes-image-2.5-flash","object":"model",...},...],
 *  "object":"list","success":true}
 * ```
 * 响应**不带模型类型字段**，只能靠 id 命名前缀分类：
 *   - 名字含 `image`  → 图像模型
 *   - 名字含 `video`  → 视频模型
 *   - 其余（`agnes-*`）→ 文本模型，本插件不用，直接丢弃。
 * 无 key 时接口返回 401——这把「Key 未填」与「模型清单」区分开。
 *
 * @param {object} [site] 站点描述（SITES 里的一个）
 * @param {string} [key]  API Key（Bearer）
 * @param {{timeout?: number, signal?: AbortSignal, log?: Function}} [ctx]
 * @returns {Promise<{ok: boolean, imageModels: string[], videoModels: string[], error?: string, httpStatus?: number}>}
 * 总是 resolve，不抛错——它是诊断入口。
 */
export async function fetchModels(site = SITES[DEFAULT_SITE], key, { timeout = 15000, signal } = {}) {
  const url = `${site.base}/v1/models`;
  try {
    const gate = withTimeout(signal, timeout);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key ?? ""}` },
        signal: gate.signal,
      });
      if (res.status === 401) {
        const err = await toError(res);
        return { ok: false, imageModels: [], videoModels: [], httpStatus: 401, error: err.message };
      }
      if (!res.ok) {
        const err = await toError(res);
        return { ok: false, imageModels: [], videoModels: [], httpStatus: res.status, error: err.message };
      }
      const json = JSON.parse(await res.text());
      const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      const ids = rows
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((id) => typeof id === "string" && id.trim());
      const imageModels = [...new Set(ids.filter((id) => /image/i.test(id)))].sort();
      const videoModels = [...new Set(ids.filter((id) => /video/i.test(id)))].sort();
      return {
        ok: true,
        imageModels,
        videoModels,
        httpStatus: res.status,
      };
    } finally {
      gate.dispose();
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, imageModels: [], videoModels: [], error: "请求已取消或超时" };
    }
    return { ok: false, imageModels: [], videoModels: [], error: `无法获取模型列表: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 按 URL 后缀或内容猜扩展名。 */
function extFrom(url, fallback = ".png") {
  try {
    return (new URL(url).pathname.match(/\.(png|jpe?g|webp)$/i) || [fallback])[0];
  } catch {
    return fallback;
  }
}

/**
 * 生成图片（文生图 / 图生图 / 多图合成）。
 *
 * @param {object} opt
 * @param {string} opt.prompt
 * @param {string} [opt.model]   图像模型 ID；缺省用 IMAGE_MODEL（agnes-image-2.5-flash）
 * @param {string} [opt.size]    档位 1K/2K/3K/4K
 * @param {string} [opt.ratio]
 * @param {string[]} [opt.images] 参考图（本地路径或 URL）
 * @param {string} [opt.outputName] 自定义文件名主名（安全清洗；空则用自动短名）
 * @param {string} opt.outDir
 * @param {{image?: Record<string, number>, video?: number}} [opt.limits] 逐档位 RPM 上限
 * @param {boolean} [opt.rateLimit]
 * @param {string} [opt.key]      显式 API Key（覆盖环境变量与凭据文件）
 * @param {object} [opt.site]     站点描述（见 SITES）；缺省中国站
 * @param {string} [opt.cwd]      相对路径基准
 * @param {Function} [opt.log]
 * @param {AbortSignal} [opt.signal]
 */
export async function generateImage(opt) {
  const {
    prompt,
    size = "1K",
    ratio = "",
    images = [],
    outputName,
    outDir,
    cwd = process.cwd(),
    timeout = 300000,
    site = SITES[DEFAULT_SITE],
    signal,
    log = () => {},
  } = opt;

  if (!prompt || !String(prompt).trim()) throw new Error("缺少 prompt");
  const tier = String(size).toUpperCase();
  if (!IMAGE_SIZES.includes(tier)) throw new Error(`size 只支持 ${IMAGE_SIZES.join(" / ")}，当前: ${size}`);
  if (ratio && !IMAGE_RATIOS.includes(ratio)) {
    throw new Error(`不支持的 ratio: ${ratio}，可选 ${IMAGE_RATIOS.join(" ")}`);
  }

  const body = { model: opt.model || IMAGE_MODEL, prompt, size: tier };
  if (ratio) body.ratio = ratio;
  if (images.length) {
    body.extra_body = { image: images.map((ref) => toDataUri(ref, cwd)), response_format: "url" };
  } else {
    body.extra_body = { response_format: "url" };
  }

  const key = readKey(opt.key, site);

  // 限流按输出档位分池。上限由调用方按「预设 + 逐档位覆盖」算好后传入；
  // 这里只兜底：`opt.limits` 给了就用它，否则回落内置免费档参考值。
  const bucket = `image-${tier}`;
  const fallbackLimit = FREE_RPM.image[tier] ?? FREE_RPM.image["1K"];
  const configured = opt.limits?.image?.[tier];
  const limit = opt.rateLimit === false ? 0 : (Number.isFinite(configured) ? configured : fallbackLimit);
  if (limit > 0) log(`限流池 ${bucket}：${limit} RPM`);

  let raw;
  let lastErr;
  for (let attempt = 0; attempt <= IMAGE_RETRY_DELAYS.length; attempt++) {
    if (signal?.aborted) throw new Error("已取消");
    if (limit > 0) await acquire(bucket, limit, { label: "agnes-image", signal, log });
    try {
      raw = await postJson(imageEndpoint(site), body, { key, timeout, signal, log });
      break;
    } catch (err) {
      lastErr = err;
      if (err.aborted) throw err;
      const canRetry =
        attempt < IMAGE_RETRY_DELAYS.length && (err.retriable || err.name === "TypeError");
      if (!canRetry) throw err;
      // 429 说明已到真实上限，短退避只会继续撞墙。
      const wait = err.status === 429 ? (err.retryAfterMs ?? RATE_LIMIT_WAIT_MS) : IMAGE_RETRY_DELAYS[attempt];
      log(`第 ${attempt + 1} 次失败（${err.message.slice(0, 80)}），${(wait / 1000).toFixed(1)}s 后重试`);
      await sleep(wait, signal);
    }
  }
  if (!raw) throw lastErr ?? new Error("图片生成失败");

  ensureDir(outDir);
  // 显式给了 output_name 就用**纯名**（不叠时间戳，AI 想要的语义名保持原样）；
  // 只有自动短名才带时间戳前缀防多批重名。多张图再加 _0/_1 序号。
  const custom = safeBaseName(outputName);
  const base = custom ? custom : `${stamp()}_${slug(prompt, 16, "image")}`;
  const items = raw.data ?? [];
  const files = [];
  const single = items.length === 1;
  for (const [i, item] of items.entries()) {
    // 单张就直接用基名（自定义名 → cityscape.png，不会多一个 _0）；多张才加序号。
    const name = single ? base : `${base}_${i}`;
    if (item.b64_json) {
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(item.b64_json, "base64"));
      files.push(file);
    } else if (item.url) {
      const file = path.join(outDir, name + extFrom(item.url));
      await download(item.url, file, signal);
      files.push(file);
    }
  }

  return {
    files,
    urls: items.map((it) => it.url).filter(Boolean),
    model: body.model,
    task_id: raw.task_id ?? null,
    size: tier,
    ratio: ratio || "1:1",
    mode: images.length ? (images.length > 1 ? "multi-image" : "image-to-image") : "text-to-image",
  };
}

/** 视频素材转 Data URI（音频保持原样传 URL）。 */
function audioRef(ref) {
  return String(ref).trim();
}

function resolveVideoMode(opt) {
  if (opt.mode) return opt.mode;
  if (opt.firstFrame || opt.lastFrame) return "keyframe";
  if ((opt.images?.length ?? 0) || (opt.audios?.length ?? 0)) return "reference";
  return "text";
}

/** 构造视频创建请求体，含全部参数校验。 */
export function buildVideoBody(opt) {
  const model = opt.model || VIDEO_MODEL;
  const mode = resolveVideoMode(opt);
  if (!opt.prompt || !String(opt.prompt).trim()) throw new Error("缺少 prompt");

  const ratio = opt.ratio || "16:9";
  if (!VIDEO_RATIOS.includes(ratio)) {
    throw new Error(`不支持的 aspect_ratio: ${ratio}，可选 ${VIDEO_RATIOS.join(" ")}`);
  }
  const seconds = Number(opt.seconds ?? 5);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 12) {
    throw new Error(`seconds 必须是 4–12 的整数，当前: ${opt.seconds}`);
  }

  const isFlash = model.includes("flash");
  const allowed = isFlash ? VIDEO_SIZES_FLASH : VIDEO_SIZES_25;
  const size = opt.size || "720P";
  if (!allowed.includes(size)) {
    throw new Error(`${model} 的 size 只支持 ${allowed.join(" ")}，当前: ${size}`);
  }
  if (!["text", "keyframe", "reference"].includes(mode)) {
    throw new Error(`未知 mode: ${mode}（可选 text / keyframe / reference）`);
  }

  const cwd = opt.cwd || process.cwd();
  const images = opt.images ?? [];
  const audios = opt.audios ?? [];

  const body = { model, prompt: opt.prompt, seconds: String(seconds), mode, size, aspect_ratio: ratio };
  if (Number.isFinite(opt.seed)) body.seed = opt.seed;

  if (mode === "keyframe") {
    if (!opt.firstFrame && !opt.lastFrame) throw new Error("keyframe 模式至少需要 first_frame 或 last_frame");
    if (opt.firstFrame) body.first_frame = toDataUri(opt.firstFrame, cwd);
    if (opt.lastFrame) body.last_frame = toDataUri(opt.lastFrame, cwd);
  } else if (mode === "reference") {
    if (!images.length && !audios.length) throw new Error("reference 模式至少需要 image 或 audio");
    if (images.length) body.images = images.map((ref) => toDataUri(ref, cwd));
    if (audios.length) body.audios = audios.map(audioRef);
    if (isFlash) {
      if (images.length > 5) throw new Error("agnes-video-2.5-flash 最多 5 张参考图片");
      if (audios.length > 3) throw new Error("agnes-video-2.5-flash 最多 3 段参考音频");
    }
  }
  return { body, mode };
}

/** 查询视频任务状态。 */
export async function queryVideo(
  videoId,
  { model = VIDEO_MODEL, key, timeout = 60000, signal, site = SITES[DEFAULT_SITE] } = {},
) {
  const url = `${videoBase(site)}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
  const gate = withTimeout(signal, timeout);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key ?? readKey(undefined, site)}` },
      signal: gate.signal,
    });
    if (!res.ok) throw await toError(res);
    return JSON.parse(await res.text());
  } finally {
    gate.dispose();
  }
}

/**
 * 创建视频任务，然后轮询到完成。
 *
 * 轮询与创建共用同一个 `video` 配额池：文档里视频模型只有一个 RPM，
 * 而轮询默认 2.5s 一次远超 1 RPM，正是 429 频发的原因。
 */
export async function generateVideo(opt) {
  const {
    outDir,
    outputName,
    signal,
    log = () => {},
    timeout = 1_800_000,
    poll = 2500,
    site = SITES[DEFAULT_SITE],
  } = opt;

  const key = readKey(opt.key, site);
  const { body, mode } = buildVideoBody(opt);

  // 视频只有一个 RPM 档位；上限同样由调用方按预设算好后传入。
  const configured = opt.limits?.video;
  const limit = opt.rateLimit === false ? 0 : (Number.isFinite(configured) ? configured : FREE_RPM.video);
  if (limit > 0) log(`限流池 video：${limit} RPM`);

  let created;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("已取消");
    if (limit > 0) await acquire("video", limit, { label: "agnes-video", signal, log });
    try {
      created = await postJson(`${videoBase(site)}/v1/videos`, body, { key, timeout: 300_000, signal, log });
      break;
    } catch (err) {
      if (err.aborted) throw err;
      if (attempt >= 3 || (err.status !== 429 && (err.status ?? 500) < 500)) throw err;
      // 1 RPM 下短退避没有意义，429 直接等一个完整窗口。
      const wait = err.status === 429 ? RATE_LIMIT_WAIT_MS : 5000 * (attempt + 1);
      log(`创建任务失败（${err.message.slice(0, 80)}），${wait / 1000}s 后重试`);
      await sleep(wait, signal);
    }
  }

  const videoId = created.video_id ?? created.id;
  if (!videoId) throw new Error(`创建任务未返回 video_id: ${JSON.stringify(created).slice(0, 300)}`);
  log(`已创建任务 ${videoId}（${mode} / ${body.seconds}s / ${body.size} / ${body.aspect_ratio}）`);

  // ---- 轮询 ----
  const started = Date.now();
  let interval = poll;
  let consecutive429 = 0;
  let info;
  for (;;) {
    if (signal?.aborted) throw new Error("已取消");
    if (Date.now() - started > timeout) {
      throw new Error(`轮询超时（${Math.round(timeout / 1000)}s），视频仍在生成中，video_id=${videoId}`);
    }
    if (limit > 0) await acquire("video", limit, { label: "agnes-video", signal, log });
    await sleep(interval, signal);
    try {
      info = await queryVideo(videoId, { model: body.model, key, signal, site });
      consecutive429 = 0;
    } catch (err) {
      if (err.status === 429) {
        consecutive429++;
        const backoff = Math.min(interval * 2 ** consecutive429, 30_000);
        log(`429 限流，${Math.round(backoff / 1000)}s 后退避重试`);
        await sleep(backoff, signal);
        continue;
      }
      if (err.status >= 500) {
        log(`${err.message.slice(0, 80)}，重试`);
        continue;
      }
      throw err;
    }
    log(`${info.status} ${info.progress ?? 0}%`);
    if (info.status === "completed") break;
    if (info.status === "failed") {
      throw new Error(`视频生成失败: ${info.error?.message ?? JSON.stringify(info.error ?? info)}`);
    }
    // 实测：pending(0%) → in_progress(长期停在 10%) → completed(100%)，
    // 所以只认 status，不按 progress 判断。轮询逐步降频以减少请求。
    interval = Math.min(interval * 1.15, 10_000);
  }

  // 实测：完成响应把地址放在顶层 url，metadata.url 为 null（文档只提到 metadata.url）。
  const url = info.metadata?.url ?? info.url;
  if (!url) throw new Error(`任务已完成但未返回视频地址: ${JSON.stringify(info).slice(0, 400)}`);

  ensureDir(outDir);
  // 显式给了 output_name 就用**纯名**（不叠时间戳，AI 想要的语义名保持原样）；
  // 只有自动短名才带时间戳前缀防多批重名。
  const custom = safeBaseName(outputName);
  const base = opt.baseName || (custom ? custom : `${stamp()}_${slug(opt.prompt, 16, "video")}`);

  const mp4 = path.join(outDir, `${base}.mp4`);
  await download(url, mp4, signal);

  return {
    video_id: videoId,
    task_id: created.task_id ?? videoId,
    url,
    mp4,
    model: body.model,
    mode,
    seconds: body.seconds,
    size: body.size,
    aspect_ratio: body.aspect_ratio,
  };
}
