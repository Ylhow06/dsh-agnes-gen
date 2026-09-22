/**
 * dsh-agnes-gen — Agnes AI 图像 / 视频生成插件（Host 半侧）。
 *
 * 注册两个模型可见工具：
 *   agnes_image  — agnes-image-2.5-flash 文生图 / 图生图 / 多图合成
 *   agnes_video  — agnes-video-2.5-flash 文生视频 / 首尾帧 / 参考，可选本地转 GIF
 *
 * 同时把两份内置技能（agnes-image、agnes-video）注册进 `ctx.skills`，
 * 因此插件装到任何 profile 后，任何 workspace 都能用。
 *
 * ## 配置
 *
 * 配置分两层，运行时可改：
 *
 *   1. **组合层**：profile 的 `cordis.patch.yml` 里该行的 `config:`。改它由
 *      HMR 决定是否热生效（web profile 是 live，其他要重启）。
 *   2. **用户层**：`$DSH_HOME/settings.yaml` 的 `agnes-gen:` 分节，由本插件
 *      注册的 settings namespace 承载。改它**不需要重启进程**——
 *      工具每次执行都重新读取。Web 上的配置卡（lib/client-bundle.js）
 *      写的也是这一层。
 *
 * 读出顺序是「schema 默认值 → 组合层 → 用户层」，由 dsh-settings 负责。
 *
 * ## 依赖
 *
 * 本插件**直接用**第一方的 `@deepseek-ai/dsh-tools`（`defineTool`）与
 * `@deepseek-ai/schemastery`（配置 schema），不再自带替代实现。
 *
 * 从 npm 安装的插件在 profile 里是真实目录，Node 的祖先目录查找能命中
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`，因此 bare import 正常；
 * 已发布的第三方插件也是这么做的。只有本地 `link:`（junction）开发时需要在
 * 本仓库内放 `node_modules/@deepseek-ai/*` junction，详见 README。
 *
 * @module dsh-agnes-gen
 */

import fs from "node:fs";
import path from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

import {
  IMAGE_MODEL,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  SITES,
  VIDEO_MODEL,
  VIDEO_RATIOS,
  VIDEO_SIZES_25,
  VIDEO_SIZES_FLASH,
  buildVideoBody,
  fetchModels,
  generateImage,
  generateVideo,
  keyStatus,
  siteOf,
} from "./lib/client.js";
import {
  AGNES_SETTINGS_NS,
  Config,
  PLANS,
  defaultConfig,
  effectiveLimits,
  keyFieldForSite,
  publicDefaults,
  resolveModels,
  siteKeyOf,
} from "./lib/config-schema.js";
import { ffmpegInfo, toGif } from "./lib/gif.js";
import { ensureDir, safeBaseName, slug, stamp } from "./lib/util.js";

export const name = "agnes-gen";

/** 硬依赖：工具注册表。技能与 settings 注册表按需注入（见下方 ctx.inject）。 */
export const inject = ["tools"];

export { Config };

/**
 * 只在组合层暴露的内部调优项。
 *
 * 它们不进 settings schema，所以界面上看不到、也不参与「恢复默认」——
 * 因此需要有这一份独立的默认值，不能从 schema 推导。
 */
const INTERNAL_DEFAULTS = {
  imageTimeoutMs: 300000,
  videoTimeoutMs: 1800000,
  videoPollMs: 2500,
};

/**
 * 配置默认值；行 config 里的字段会覆盖同名项。
 *
 * schema 覆盖的字段一律取自 `lib/config-schema.js` 的 `Config`——**默认值全项目
 * 只有那一处来源**，本对象只是把「schema 默认值」与「内部调优项」拼起来。
 * 这样界面上的「一键恢复默认」与 Host 的缺省值不可能指向两套数字。
 *
 * 设置服务缺席时（例如未挂载 settings provider 的部署）配置就退化成本对象。
 */
export const DEFAULT_CONFIG = { ...defaultConfig(), ...INTERNAL_DEFAULTS };

/**
 * 解析本次调用的输出目录：配置 outDir > 环境变量 > <cwd>/out/<kind>。
 *
 * 工具不再暴露 out_dir 参数（调用方不能乱填路径），输出位置只由操作者配置
 * （插件配置卡的 outDir、或 AGNES_OUT_DIR 环境变量）决定；都没设就用会话
 * 工作目录下的默认位置。目录自动创建。
 */
function resolveOutDir({ configOutDir, envVar, cwd, kind }) {
  const explicit = configOutDir || process.env[envVar];
  if (explicit) return ensureDir(path.resolve(cwd, explicit));
  return ensureDir(path.join(cwd, "out", kind));
}

/** 读入并解析技能正文（拆掉 frontmatter，只留 markdown 正文）。 */
function loadSkillBody(skillDir, baseUrl) {
  const file = new URL(`./skills/${skillDir}/SKILL.md`, baseUrl);
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const front = m ? m[1] : "";
  const body = (m ? text.slice(m[0].length) : text).trim();
  const field = (key) => {
    const line = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return line ? line[1].trim() : undefined;
  };
  return { body, description: field("description"), whenToUse: field("whenToUse") };
}

/** 判断请求来自本机回环地址——检测路由只服务于本机的配置页面。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** 读取请求体的原始文本（用于 POST JSON 的解体）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  const baseUrl = new URL("./", import.meta.url);
  const logger = ctx.logger("agnes-gen");

  /**
   * 用户设置层的读取函数。未挂载 settings provider 时保持「空覆盖」，
   * 配置完全由组合层与默认值决定——与注册设置服务之前的行为一致。
   */
  let settingsSource = () => ({});

  /**
   * 用户层**已覆盖字段的键名**（只有名字，没有值）。
   *
   * 为什么需要它：`redactSecrets()` 会把 `role('secret')` 字段从 `user` 层里
   * **整个删掉**（见 dsh-settings/lib/types/redact.js），所以浏览器拿到的
   * `snapshot.user` 里永远没有 `apiKey`——只靠「键是否存在」判断覆盖状态时，
   * 机密的「已覆盖」标记会永远不亮，用户也就没有入口去清除它。
   * 因此这里由 Host 侧补一份键名清单。**只回传键名**：值一律不出这一层。
   */
  let settingsUserKeys = () => [];

  /**
   * 本次执行的生效配置：组合层打底，用户设置层覆盖。
   *
   * 每次工具执行都重新求值，所以改 `settings.yaml` 不必重启进程；
   * 这正是把配置放进 settings namespace 而不是只读 `rawConfig` 的意义。
   */
  const effectiveConfig = () => ({ ...config, ...settingsSource() });

  /** 进度日志出口：走 Cordis logger，不污染 Host 进程的 stdout/stderr。 */
  const makeLog = (tool) => (msg) => logger.info(`[${tool}] ${msg}`);

  // ---------------- agnes_image ----------------

  ctx.tools.register(
    defineTool({
      name: "agnes_image",
      description:
        "使用 Agnes AI 图像模型（agnes-image-2.5-flash）生成或编辑图片。文生图、图生图（传 image 参考图）、多图合成都可；返回已下载到本地的图片绝对路径。",
      parameters: {
        prompt: {
          type: "string",
          required: true,
          description:
            "图像提示词。文生图建议结构：[主体]+[场景]+[风格]+[光照]+[构图]+[质量]；图生图建议：[改动]+[新风格/场景]+[增删元素]+[需保留元素]。",
        },
        model: {
          type: "string",
          description:
            `图像模型 ID，默认 ${IMAGE_MODEL}。必须在插件配置的模型清单内（可在配置卡「校验 Key」后用 /v1/models 拉取）。`,
        },
        size: {
          type: "string",
          enum: IMAGE_SIZES,
          description: "输出档位，默认 1K。3K/4K 每分钟仅 1 次请求，批量请用 1K/2K。",
        },
        ratio: {
          type: "string",
          enum: IMAGE_RATIOS,
          description: "宽高比，默认 1:1。不要传 1920x1080 这类精确尺寸，会被标准化。",
        },
        image: {
          type: "array",
          items: { type: "string" },
          description:
            "参考图路径或公网 URL，可传多张做合成。本地路径相对当前工作目录解析，会自动转 Data URI。传入即为图生图。",
        },
        output_name: {
          type: "string",
          description:
            "可选，自定义文件名主名（不含扩展名）。会给一个简短语义名，如 output_name={小猪打滚} → 生成 小猪打滚.png（单张直接用它；多张才追加 _0/_1）；注意每次生成的 output_name 要唯一，避免覆盖同目录同名文件。不传则用自动短名（时间戳_提示词前16字符）。会清洗掉路径分隔符/非法字符。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            files: {
              type: "array",
              required: true,
              items: { type: "string" },
              description: "本地图片绝对路径",
            },
            urls: { type: "array", required: true, items: { type: "string" }, description: "云端直链" },
            model: { type: "string", required: true },
            size: { type: "string", required: true },
            ratio: { type: "string", required: true },
            mode: { type: "string", required: true },
            task_id: { type: "string", required: true },
          },
        },
        render(_args, value) {
          const lines = [
            `模型: ${value.model}   档位: ${value.size}   比例: ${value.ratio}   模式: ${value.mode}`,
            ...value.files.map((f) => `本地文件: ${f}`),
            ...value.urls.map((u) => `云端直链: ${u}`),
          ];
          if (value.task_id) lines.push(`task_id: ${value.task_id}`);
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args, exec) {
        const cfg = effectiveConfig();
        // 工作目录来自会话 header（第一方工具如 dsh-tool-fs / dsh-tool-present 都用它）：
        // exec.agent.session.header.cwd 才是**当前对话所属的 workspace**。
        // 缺省回落 process.cwd()（dsh 进程起始目录），后者未必是对话目录。
        const cwd = exec.agent?.session?.header?.cwd || process.cwd();
        const outDir = resolveOutDir({
          configOutDir: cfg.outDir,
          envVar: "AGNES_OUT_DIR",
          cwd,
          kind: "agnes-images",
        });
        // 模型校验 + 默认值：允许当前站点可选集内的任意值，不传用选中项。
        const { list: imageAllow, selected: imageDefault } = resolveModels(cfg, "image");
        const model = args.model || imageDefault;
        if (imageAllow.length && !imageAllow.includes(model)) {
          throw new Error(`图像模型 ${model} 不在当前站的模型清单内，可选：${imageAllow.join(" ")}`);
        }
        const result = await generateImage({
          prompt: args.prompt,
          model,
          size: args.size || "1K",
          ratio: args.ratio || "",
          images: args.image ?? [],
          outputName: args.output_name,
          outDir,
          cwd,
          key: siteKeyOf(cfg),
          site: siteOf(cfg),
          timeout: cfg.imageTimeoutMs,
          limits: effectiveLimits(cfg),
          rateLimit: cfg.rateLimit !== false,
          signal: exec.signal,
          log: makeLog("agnes-image"),
        });
        return {
          files: result.files,
          urls: result.urls,
          model: result.model || model,
          size: result.size,
          ratio: result.ratio,
          mode: result.mode,
          task_id: result.task_id ?? "",
        };
      },
    }),
  );

  // ---------------- agnes_video ----------------

  ctx.tools.register(
    defineTool({
      name: "agnes_video",
      description:
        "使用 Agnes AI 视频模型（agnes-video-2.5-flash）生成视频：文生视频、首尾帧动画、图片/音频参考；可选用本机 ffmpeg 转成 GIF。异步任务，通常需 1–3 分钟。",
      parameters: {
        prompt: {
          type: "string",
          required: true,
          description:
            "视频提示词。顺序建议：主体与场景 → 动作变化 → 镜头语言 → 视觉风格 → 声音节奏 → 一致性要求。参考模式要写占位符如 <Picture 1> 并说明用途。",
        },
        seconds: { type: "integer", description: "时长秒数，4–12 的整数，默认 5。" },
        ratio: { type: "string", enum: VIDEO_RATIOS, description: "画幅比例，默认 16:9。" },
        size: {
          type: "string",
          description: `分辨率。Flash 模型只支持 ${VIDEO_SIZES_FLASH.join("/")}；agnes-video-2.5 可用 ${VIDEO_SIZES_25.join("/")}。`,
        },
        model: {
          type: "string",
          description:
            `视频模型 ID，默认 ${VIDEO_MODEL}。必须在插件配置的模型清单内（可在配置卡「校验 Key」后用 /v1/models 拉取）。如需要在 720P 之外的分辨率请选清单里的 agnes-video-2.5；Flash 只支持 720P。`,
        },
        mode: {
          type: "string",
          enum: ["text", "keyframe", "reference"],
          description: "生成模式。留空会按传入素材自动推断：有帧用 keyframe，有图/音频用 reference，否则 text。",
        },
        first_frame: { type: "string", description: "首帧图片路径或 URL（keyframe 模式）。" },
        last_frame: { type: "string", description: "尾帧图片路径或 URL（keyframe 模式）。" },
        image: {
          type: "array",
          items: { type: "string" },
          description: "参考图片路径或 URL（reference 模式），Flash 最多 5 张。",
        },
        audio: {
          type: "array",
          items: { type: "string" },
          description: "参考音频 URL（reference 模式），Flash 最多 3 段。",
        },
        seed: { type: "integer", description: "随机种子。" },
        gif: { type: "boolean", description: "是否用本机 ffmpeg 转成 GIF（纯本地，不额外计费）。ffmpeg 缺失/失败时会降级为仅返回 mp4，并通过 warning 提示。" },
        gif_width: { type: "integer", description: "GIF 宽度，默认 480。" },
        gif_fps: { type: "integer", description: "GIF 帧率，默认 12。" },
        gif_start: { type: "number", description: "GIF 起始秒数。" },
        gif_duration: { type: "number", description: "GIF 截取时长（秒）。" },
        keep_mp4: { type: "boolean", description: "转 GIF 后是否保留 mp4，默认 true。" },
        output_name: {
          type: "string",
          description:
            "可选，自定义文件名主名（不含扩展名）。会给一个简短语义名，如 output_name=\{小猪打滚\} → 生成 小猪打滚.mp4；注意每次生成的 output_name 要唯一，避免覆盖同目录同名文件。不传则用自动短名（时间戳_提示词前16字符）。mp4 与 gif 共用此名。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            video_id: { type: "string", required: true },
            task_id: { type: "string", required: true },
            url: { type: "string", required: true, description: "云端视频直链" },
            mp4: { type: "string", required: true, description: "本地 mp4 绝对路径" },
            gif: { type: "string", required: true, description: "本地 GIF 绝对路径（未转时为空串）" },
            gif_bytes: { type: "integer", required: true },
            model: { type: "string", required: true },
            mode: { type: "string", required: true },
            seconds: { type: "string", required: true },
            size: { type: "string", required: true },
            aspect_ratio: { type: "string", required: true },
            warning: { type: "string", description: "非致命警告（如 GIF 转换失败已降级）；无则空串" },
          },
        },
        render(_args, value) {
          const lines = [
            `模型: ${value.model}   模式: ${value.mode}   时长: ${value.seconds}s   分辨率: ${value.size}   画幅: ${value.aspect_ratio}`,
            `video_id: ${value.video_id}`,
            `本地 mp4: ${value.mp4 || "(无)"}`,
          ];
          if (value.gif) lines.push(`本地 GIF: ${value.gif}（${(value.gif_bytes / 1024 / 1024).toFixed(2)} MB）`);
          lines.push(`云端直链: ${value.url}`);
          return [{ type: "text", text: lines.join("\n") }].concat(
            value.warning ? [{ type: "text", text: `提示：${value.warning}` }] : [],
          );
        },
      },
      async execute(args, exec) {
        const cfg = effectiveConfig();
        // 工作目录来自会话 header（同图片工具）——exec.agent.session.header.cwd
        // 才是当前对话所属的 workspace；缺省回落 dsh 进程起始目录 process.cwd()。
        const cwd = exec.agent?.session?.header?.cwd || process.cwd();
        const log = makeLog("agnes-video");
        const outDir = resolveOutDir({
          configOutDir: cfg.outDir,
          envVar: "AGNES_OUT_DIR",
          cwd,
          kind: "agnes-videos",
        });

        // 模型校验 + 默认值：允许当前站点可选集内的任意值，不传用选中项。
        const { list: videoAllow, selected: videoDefault } = resolveModels(cfg, "video");
        const videoModel = args.model || videoDefault;
        if (videoAllow.length && !videoAllow.includes(videoModel)) {
          throw new Error(`视频模型 ${videoModel} 不在当前站的模型清单内，可选：${videoAllow.join(" ")}`);
        }

        // mp4 与 gif 必须共用同一个基名，避免视频轮询跨过秒级边界后两者错位。
        // 显式给了 output_name 就用纯名（不叠时间戳）；只有自动名才带时间戳防重名。
        const outBase =
          safeBaseName(args.output_name) || `${stamp()}_${slug(args.prompt, 16, "video")}`;
        const result = await generateVideo({
          prompt: args.prompt,
          model: videoModel,
          mode: args.mode || "",
          seconds: args.seconds ?? 5,
          size: args.size || "",
          ratio: args.ratio || "16:9",
          firstFrame: args.first_frame || "",
          lastFrame: args.last_frame || "",
          images: args.image ?? [],
          audios: args.audio ?? [],
          seed: args.seed,
          outDir,
          cwd,
          key: siteKeyOf(cfg),
          site: siteOf(cfg),
          timeout: cfg.videoTimeoutMs,
          poll: cfg.videoPollMs,
          limits: effectiveLimits(cfg),
          rateLimit: cfg.rateLimit !== false,
          signal: exec.signal,
          log,
          // 让 mp4 与 gif 共用同一个基名（含时间戳+安全名）。
          outputName: args.output_name,
          baseName: outBase,
        });

        let gifPath = "";
        let gifBytes = 0;
        let warning = "";
        if (args.gif) {
          const keepMp4 = args.keep_mp4 !== false;
          gifPath = path.join(outDir, `${outBase}.gif`);
          try {
            const out = toGif(
              result.mp4,
              gifPath,
              {
                // 单次调用的参数优先；缺省时用配置里的默认值。
                gifWidth: args.gif_width ?? cfg.gifWidth,
                gifFps: args.gif_fps ?? cfg.gifFps,
                gifStart: args.gif_start ?? null,
                gifDuration: args.gif_duration ?? null,
                ffmpeg: cfg.ffmpegPath,
              },
              log,
            );
            gifBytes = out.bytes;
            if (!keepMp4) {
              try {
                fs.unlinkSync(result.mp4);
                result.mp4 = "";
              } catch {
                /* 保留 mp4 也无妨 */
              }
            }
          } catch (err) {
            // GIF 是可选增强：ffmpeg 缺失/失败时降级，不连累已生成的视频。
            gifPath = "";
            warning = `GIF 转换失败，已降级为仅返回 mp4：${err instanceof Error ? err.message : String(err)}`;
            log(warning);
          }
        }

        return {
          video_id: result.video_id,
          task_id: result.task_id,
          url: result.url,
          mp4: result.mp4,
          gif: gifPath,
          gif_bytes: gifBytes,
          model: result.model,
          mode: result.mode,
          seconds: result.seconds,
          size: result.size,
          aspect_ratio: result.aspect_ratio,
          warning,
        };
      },
    }),
  );

  // ---------------- 设置 namespace（按需注入 settings 服务） ----------------

  // 与技能同样的理由：未挂载 settings provider 的部署里，插件仍要能工作，
  // 此时配置完全由组合层与默认值决定（settingsSource 保持空覆盖）。
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      // `get()` 是服务内的同步字典查找，代价可以忽略；因此工具执行时直接读，
      // 不做任何缓存——缓存只会引入「配置改了但没生效」这类问题。
      settingsSource = () => settingsCtx.settings.get(AGNES_SETTINGS_NS) ?? {};

      /**
       * 读用户层的原始键名。`describe()` 是 dsh-settings 明示给配置界面用的
       * 接口（注释原文：把组合 base 与 raw user 一起给出，「so a form can mark
       * which fields the user overrode」），这里用它取**未脱敏**的用户层，
       * 随后只保留键名。代价是它会克隆每个已注册命名空间的 base/user，
       * 但这条路径只在用户点「检测」/打开配置页时走到，可以接受。
       */
      settingsUserKeys = () => {
        try {
          const views = settingsCtx.settings.describe?.();
          const view = Array.isArray(views) ? views.find((v) => v.ns === AGNES_SETTINGS_NS) : undefined;
          const user = view?.user;
          return typeof user === "object" && user !== null && !Array.isArray(user) ? Object.keys(user) : [];
        } catch {
          // describe 不可用（例如更早的 DSH 版本）时退化为「没有覆盖」。
          return [];
        }
      };

      const describe = (value) => {
        const limits = effectiveLimits(value);
        return (
          `站点 ${siteOf(value).label}，档位 ${limits.planLabel}，限流 ${value.rateLimit !== false ? "开" : "关"}，` +
          `图片 ${Object.entries(limits.image)
            .map(([tier, rpm]) => `${tier}=${rpm}`)
            .join(" ")}，视频 ${limits.video} RPM`
        );
      };

      settingsCtx.settings.installSection(ctx, AGNES_SETTINGS_NS, Config, config, {
        // setSource 收到「当前解析值」的读取函数：服务在场时读用户层，
        // 服务消失时自动回落到组合层 entry。这里不用它，因为直接读服务
        // 更简单；但回调必须提供，installSection 会调用它。
        setSource() {},
        onChange() {
          logger.info(`配置已更新（${describe(effectiveConfig())}）`);
        },
      });
      logger.info(`设置 namespace "${AGNES_SETTINGS_NS}" 已注册（${describe(effectiveConfig())}）`);
    } catch (err) {
      // schema 无 `.loose()`，所以用户层里一个非法值（例如 imageRpm1K: -5）
      // 会让 register() 抛错。这里刻意**只警告不抛出**：插件行照常加载、
      // 两个工具照常可用，配置退化为组合层 + 默认值；只是配置卡不可用。
      // 相比静默改写成默认值，这样用户能看见自己写错了什么。
      logger.warn(
        `设置 namespace "${AGNES_SETTINGS_NS}" 注册失败，配置卡不可用（将使用默认/组合层配置）: ${err.message}`,
      );
    }
  });

  // ---------------- 诊断路由（供 Web 配置卡的「检测」按钮调用） ----------------

  // 只读探测：报告 Key 与 ffmpeg 的可用性，绝不返回密钥本身。
  // 用 ctx.inject 而非顶层 inject：没有 webServer 的部署（CLI/headless）
  // 不该因此整行加载失败。
  ctx.inject(["webServer"], (webCtx) => {
    try {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: "/plugins/dsh-agnes-gen/status",
            handler: (req, res) => {
              // 只服务本机的配置页面。回环地址不是强认证（本机任何进程都能伪造
              // Host 头），但这条路由是只读的、不消耗额度、也不回传机密，
              // 因此按「够用」处理，不做更重的令牌校验。
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: "loopback only" });
                return;
              }
              if (req.method !== "GET" && req.method !== "HEAD") {
                res.writeHead(405, { Allow: "GET, HEAD" });
                res.end();
                return;
              }
              const cfg = effectiveConfig();
              let payload;
              try {
                const limits = effectiveLimits(cfg);
                const site = siteOf(cfg);
                payload = {
                  settingsNamespace: AGNES_SETTINGS_NS,
                  // 站点决定 Key 的环境变量优先级与请求主机，界面要显示它，
                  // 否则用户会对着「已配置」却 401 的结果无从判断。
                  site: cfg.site,
                  siteLabel: site.label,
                  siteBase: site.base,
                  consoleUrl: site.consoleUrl,
                  // 当前站点实际使用的密钥字段名——界面据此只给「那一站」的
                  // 输入框打「已配置」标记，避免两站互相误导。
                  keyField: keyFieldForSite(cfg),
                  key: keyStatus(siteKeyOf(cfg), site),
                  ffmpeg: ffmpegInfo(cfg.ffmpegPath),
                  rateLimit: cfg.rateLimit !== false,
                  // 界面显示的数值与实际限流用的数值同源，因此不会互相矛盾。
                  plan: limits.plan,
                  planLabel: limits.planLabel,
                  imageRpm: limits.image,
                  videoRpm: limits.video,
                  rpmOverridden: limits.overridden,
                  // 供界面给机密字段补「已覆盖」标记；只有键名，绝不含值。
                  overriddenKeys: settingsUserKeys(),
                  // 出厂默认值，供界面在空输入框里做占位提示。不含机密字段。
                  defaults: publicDefaults(),
                  outDir: cfg.outDir,
                };
              } catch (err) {
                sendJson(res, 500, { error: err.message });
                return;
              }
              if (req.method === "HEAD") {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end();
                return;
              }
              sendJson(res, 200, payload);
            },
          }),
        "dsh-agnes-gen: status route",
      );

      // 单发的 Key + 模型校验路由：填了 Key 时实际调一次 `/v1/models`。
      // 与 status 分离，避免每次打开配置页都触发一次外部请求。
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: "/plugins/dsh-agnes-gen/check",
            handler: async (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: "loopback only" });
                return;
              }
              if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
                res.writeHead(405, { Allow: "GET, HEAD, POST" });
                res.end();
                return;
              }
              try {
                // 校验的是「用户当前要用的站点 + Key」——优先用请求带来的（表单草稿），
                // 而不是已保存配置。否则用户切了站点、在输入框里刚填了 key 但没保存时，
                // 会拿旧站点/旧 key 去校验，得出误导结论。
                let bodyParams = { site: "", key: "" };
                if (req.method === "POST") {
                  try {
                    const text = await readBody(req);
                    bodyParams = text ? JSON.parse(text) : {};
                  } catch {
                    sendJson(res, 400, { error: "请求体必须是 JSON" });
                    return;
                  }
                } else if (req.method === "GET" && req.url) {
                  try {
                    const q = new URL(req.url, "http://local").searchParams;
                    bodyParams = { site: q.get("site") ?? "", key: q.get("key") ?? "" };
                  } catch {
                    /* 忽略解析失败，回落已保存配置 */
                  }
                }
                const cfg = effectiveConfig();
                const siteKey = typeof bodyParams.site === "string" && SITES[bodyParams.site] ? bodyParams.site : cfg.site;
                const effCfg = { ...cfg, site: siteKey };
                const site = siteOf(effCfg);
                // 显式带上的 key（草稿）优先；否则回落该站已保存 key。
                const draftKey = typeof bodyParams.key === "string" ? bodyParams.key.trim() : "";
                const key = draftKey || siteKeyOf(effCfg);
                if (!key) {
                  sendJson(res, 200, {
                    configured: false,
                    // keyField 用 effCfg（站点可能来自草稿）——message 里告诉用户填的是哪一站。
                    message: `未填写 ${keyFieldForSite(effCfg)}，无法校验。在该站配置页申请 Key：${site.consoleUrl}`,
                  });
                  return;
                }
                const result = await fetchModels(site, key, { timeout: 15000 });
                const im = resolveModels(effCfg, "image");
                const vm = resolveModels(effCfg, "video");
                sendJson(res, 200, {
                  configured: true,
                  site: siteKey,
                  siteLabel: site.label,
                  ok: result.ok,
                  keyValid: result.ok,
                  httpStatus: result.httpStatus ?? null,
                  error: result.error ?? "",
                  // 当前站点拉到的模型（按 id 分类）。
                  imageModels: result.imageModels,
                  videoModels: result.videoModels,
                  // 当前站点配置里“选中生效”的模型，供界面高亮。
                  selectedImage: im.selected,
                  selectedVideo: vm.selected,
                });
              } catch (err) {
                sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
              }
            },
          }),
        "dsh-agnes-gen: check key/models route",
      );
    } catch (err) {
      logger.warn(`诊断路由注册失败: ${err.message}`);
    }
  });

  // ---------------- 内置技能（按需注入 skills 服务） ----------------

  // 用 ctx.inject 而不是放进顶层 inject：没有技能注册表的组合里，
  // 插件仍能提供两个工具，不会整行加载失败。
  // 技能无条件内置（不再提供开关）：agnes-image / agnes-video 两份技能正文
  // 是工具的使用说明，模型靠它们学会怎么调用；没必要让使用者关掉。
  ctx.inject(["skills"], (skillCtx) => {
    for (const dir of ["agnes-image", "agnes-video"]) {
      try {
        const skill = loadSkillBody(dir, baseUrl);
        skillCtx.skills.register({
          name: dir,
          description: skill.description || `Agnes ${dir}`,
          ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
          content: skill.body,
          source: "bundled",
        });
      } catch (err) {
        logger.warn(`内置技能 ${dir} 注册失败: ${err.message}`);
      }
    }
  });

  {
    const limits = effectiveLimits(config);
    logger.info(
      `已注册 agnes_image / agnes_video（档位 ${limits.planLabel}，限流 ${config.rateLimit !== false ? "开" : "关"}，` +
        `图片池 ${Object.entries(limits.image)
          .map(([tier, rpm]) => `${tier}=${rpm}`)
          .join(" ")}，视频池 ${limits.video} RPM）`,
    );
  }
}

export {
  AGNES_SETTINGS_NS,
  IMAGE_MODEL,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  PLANS,
  SITES,
  VIDEO_MODEL,
  VIDEO_RATIOS,
  VIDEO_SIZES_25,
  VIDEO_SIZES_FLASH,
  buildVideoBody,
  defaultConfig,
  effectiveLimits,
  ffmpegInfo,
  generateImage,
  generateVideo,
  publicDefaults,
  siteOf,
  toGif,
};
