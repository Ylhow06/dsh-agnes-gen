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
import os from "node:os";
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
 * 把配置里的路径值收敛成字符串。
 *
 * **为什么需要**：`Config` 的字段全部标了 `.volatile()`（0.1.7 配置表单只投影
 * volatile 字段），而 volatile 字段在**求值时返回的是引用对象而不是值**：
 *
 *     Config({}).outDir  ->  {}          // 不是 ""
 *     Config({}).site    ->  {}          // 不是 "cn"
 *
 * 正常路径下我们读的是 `meta.default`（见 config-schema.js 的 defaultConfig()），
 * 拿到的确是字符串。但只要有任何一环把**求值结果**当成配置值传进来（例如上游
 * 用 `Config(raw)` 的结果做中间层），`cfg.outDir` 就会是对象，随后
 * `path.resolve(cwd, {})` 会抛出与配置毫无关系的
 * `The "paths[1]" argument must be of type string`。
 *
 * 因此所有「配置 → 文件系统路径」的取值都必须过这道闸：非字符串、或空白字符串
 * 一律视为「未设置」。这样即使上游污染了配置，也只是回落到默认目录，
 * 而不是让工具彻底不可用。
 *
 * @param {unknown} value 配置里的原始值
 * @returns {string} 可安全交给 path.* 的字符串（未设置时为空串）
 */
function pathFromConfig(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 取本次调用的会话工作目录。
 *
 * 第一方工具（dsh-tool-fs / dsh-tool-present）都用 `exec.agent.session.header.cwd`
 * 作为「当前对话所属的 workspace」，缺省回落 `process.cwd()`（dsh 进程起始目录，
 * 未必是对话目录）。
 *
 * 取值同样要过 {@link pathFromConfig} 那道闸：这个值会直接进 `path.resolve`，
 * 一旦不是字符串就会抛出与工具本身毫无关系的类型错误。
 *
 * @param {object} exec 工具执行上下文
 * @returns {string} 可安全交给 path.* 的工作目录
 */
function sessionCwd(exec) {
  return pathFromConfig(exec?.agent?.session?.header?.cwd) || process.cwd();
}

/**
 * 解析本次调用的输出目录：配置 outDir > 环境变量 > <cwd>/out/<kind>。
 *
 * 工具不再暴露 out_dir 参数（调用方不能乱填路径），输出位置只由操作者配置
 * （插件配置卡的 outDir、或 AGNES_OUT_DIR 环境变量）决定；都没设就用会话
 * 工作目录下的默认位置。目录自动创建。
 */
function resolveOutDir({ configOutDir, envVar, cwd, kind }) {
  const explicit = pathFromConfig(configOutDir) || pathFromConfig(process.env[envVar]);
  const root = pathFromConfig(cwd) || process.cwd();
  if (explicit) return ensureDir(path.resolve(root, explicit));
  return ensureDir(path.join(root, "out", kind));
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
  /**
   * 行配置清洗：丢掉**非标量且非数组**的值。
   *
   * 这不是防御性编程的洁癖，而是针对一个具体故障：`Config` 的字段全标了
   * `.volatile()`（0.1.7 表单只投影 volatile 字段），volatile 字段在**求值时
   * 返回引用对象而不是值**——
   *
   *     Config({}).outDir  ->  {}      // 不是 ""
   *     Config({}).site    ->  {}      // 不是 "cn"
   *
   * 于是只要上游任何一环把**求值结果**当作配置传进来（不同 DSH 版本的持久化
   * 与透传方式不同），我们就会收到 `outDir: {}` 这样的值，最终在
   * `path.resolve(cwd, {})` 里炸成
   * `The "paths[1]" argument must be of type string. Received an instance of Object`
   * ——一个与「生成图片」毫无关系、且每次调用都复现的错误。
   *
   * 丢掉这类值即可回落到 `DEFAULT_CONFIG` 里的正确默认值；标量与数组原样保留。
   * 被丢掉的值会记一条 warn，便于排查上游污染。
   */
  const incoming = Object.entries(rawConfig ?? {}).filter(([, value]) => {
    if (value === null || typeof value !== "object") return true;
    return Array.isArray(value);
  });
  const rejected = Object.entries(rawConfig ?? {})
    .filter(([key, value]) => !incoming.some(([k]) => k === key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  const config = { ...DEFAULT_CONFIG, ...Object.fromEntries(incoming) };
  const baseUrl = new URL("./", import.meta.url);
  const logger = ctx.logger("agnes-gen");

  if (rejected.length) {
    logger.warn(
      `行配置里有非标量值（很可能是 volatile 字段的引用空壳），已按「未设置」处理并回落到默认值：` +
        rejected.join("、"),
    );
  }

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
      /**
       * 把本工具标为「可并行」。
       *
       * DSH 的调度器是 **fail-closed** 的（dsh-tools 的 `executionMode`）：
       *
       *     if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
       *     return tool.isConcurrencySafe(args) === true ? { kind: "parallel" } : { kind: "exclusive" };
       *
       * 只有分类器返回严格 `true` 才算并行。未声明时，dsh-agent-loop 的
       * `executeToolCalls` 会把每个调用切成单元素组（`group = [first]`），
       * 于是同一步内的多个 agnes_image 严格串行：
       *
       *     4 张 1K 图 = 4 × 约 12s = 49.4s（实测）
       *
       * 图像可以并行的理由：
       * - 无共享可变状态：每次调用只写自己的输出文件，互不干扰。
       * - 限流已跨进程协调：`lib/rate-limit.js` 用状态文件 + `wx` 独占锁做滑动
       *   窗口记账，为并发设计；同档位共用池，并行调用合计仍不超配置 RPM。
       * - 失败互不牵连：每个调用有独立的 `exec.signal` 与重试链。
       *
       * @param {object} args 已通过参数校验的调用参数
       * @returns {boolean} 是否允许与同批其他调用并行
       */
      isConcurrencySafe(args) {
        // 3K / 4K 是 1 RPM 的极稀缺档位（见 FREE_RPM.image）：并发发出去只会
        // 让后到的调用在 acquire 里干等一个完整窗口，没有吞吐收益，还白占
        // 并行池名额、拖慢同批其他调用。这类调用退回独占，让它们老实排队。
        const tier = String(args?.size ?? "1K").toUpperCase();
        return !(tier === "3K" || tier === "4K");
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
        const cwd = sessionCwd(exec);
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
      /**
       * 视频**保持独占**（返回 false），与 agnes_image 的策略刻意不同。
       *
       * **1. 视频只有 1 RPM。** 见 `lib/rate-limit.js` 的 `FREE_RPM.video = 1`
       * （Token Plan 也只有 5）。并发发两个视频任务，第二个必然在 acquire 里
       * 等满一个 60s 窗口——没有吞吐收益，反而占住并行池名额。
       *
       * **2. 轮询与创建共用同一个配额池。** generateVideo 创建任务后要持续轮询
       * （默认 2.5s 一次，逐步降频到 10s）。一次视频调用在完成的几分钟里会
       * 反复申请 video 池配额。两个视频并行时，两边轮询互相抢那 1 RPM，会
       * 互相把对方的轮询推后，制造出 429 与「进度卡住」的假象。
       *
       * **3. 单次调用已经 1–3 分钟。** 瓶颈是模型生成时长，不是调度排队，
       * 并行的边际收益远小于它引入的配额争抢风险。
       *
       * @returns {boolean} 始终 false：视频调用串行执行
       */
      isConcurrencySafe() {
        return false;
      },
      async execute(args, exec) {
        const cfg = effectiveConfig();
        const cwd = sessionCwd(exec);
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
      const settings = settingsCtx.settings;

      // DSH 0.1.6 与 0.1.7 的 `settings` 服务是两套不兼容的实现：
      //   - 0.1.6 (`SettingsProvider`)：提供 `get(ns)` / `installSection(...)` /
      //     `describe()`；用户层叠加在组合 base 之上，读到解析值。
      //   - 0.1.7 (`SettingsForms`)：**没有** `get` / `installSection`；配置
      //     直接由当前插件的 Cordis 条目配置（rawConfig）承载，DSH 从我们导出
      //     的 `Config` schema 自动生成设置表单。这里的 `SettingsForms` 只负责
      //     表单读写与原生 config-editor，不参与工具读配置。
      // 按方法存在与否在运行期二选一，工具在两种版本下都能工作。
      if (typeof settings.get === "function") {
        // ---------------- DSH 0.1.6 路径 ----------------

        // `get()` 是服务内的同步字典查找，代价可以忽略；因此工具执行时直接读，
        // 不做任何缓存——缓存只会引入「配置改了但没生效」这类问题。
        settingsSource = () => settings.get(AGNES_SETTINGS_NS) ?? {};

        /**
         * 读用户层的原始键名。`describe()` 是 dsh-settings 明示给配置界面用的
         * 接口（注释原文：把组合 base 与 raw user 一起给出，「so a form can mark
         * which fields the user overrode」），这里用它取**未脱敏**的用户层，
         * 随后只保留键名。代价是它会克隆每个已注册命名空间的 base/user，
         * 但这条路径只在用户点「检测」/打开配置页时走到，可以接受。
         */
        settingsUserKeys = () => {
          try {
            const views = settings.describe?.();
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

        settings.installSection(ctx, AGNES_SETTINGS_NS, Config, config, {
          // setSource 收到「当前解析值」的读取函数：服务在场时读用户层，
          // 服务消失时自动回落到组合层 entry。这里不用它，因为直接读服务
          // 更简单；但回调必须提供，installSection 会调用它。
          setSource() {},
          onChange() {
            logger.info(`配置已更新（${describe(effectiveConfig())}）`);
          },
        });
        logger.info(`设置 namespace "${AGNES_SETTINGS_NS}" 已注册（${describe(effectiveConfig())}）`);
      } else {
        // ---------------- DSH 0.1.7 路径 ----------------

        // 配置由 rawConfig 承载：`effectiveConfig()` = 默认值 + 组合层(rawConfig)。
        //
        // ## 为什么必须让 settingsSource 实时读，而不是只吃 rawConfig
        //
        // `rawConfig` 是 **apply() 那一刻**的行配置快照。配置卡写入 profile patch
        // 之后，DSH 会更新条目配置，但**不会重新调用 apply()**——所以只认 rawConfig
        // 的话，界面上「保存」成功、patch 文件也真的变了，工具却仍然读旧值。
        // 实测症状：填好 Key 保存后，工具调用仍报「未找到 Agnes API Key」。
        //
        // 0.1.7 没有 `get(ns)`，但有 `describe()`：它给每个活动条目返回三层
        // **未脱敏**的值：
        //
        //   value —— 全字段「生效值」（默认 + 组合层 + 用户层）
        //   base  —— 组合层
        //   user  —— 用户**真正写下的覆盖层**（只有那几个键）
        //
        // 这里必须取 **`user`**，不能取 `value`。`settingsSource()` 的语义是
        // 「用户层覆盖」，它在 `effectiveConfig()` 里是 `{...config, ...source()}`——
        // 用一个含全部默认值的 `value` 去覆盖，会把 `rawConfig` 里的显式配置
        // 一并盖掉。实测过这个坑：
        //
        //   rawConfig = { site: "intl", apiKeyIntl: "sk-…" }
        //   value     = { site: "cn", gifWidth: 480, … }      // 默认值
        //   => 合并后 site 变回 "cn"，于是去中国站找 Key -> 「未找到 Agnes API Key」
        //
        // 用 `user` 层则只覆盖用户真正改过的键，`rawConfig` 的其余值原样保留。
        //
        // 另外**不能**传 `{ redactSecrets: true }`：那是给远程/浏览器调用方用的，
        // 会按 `role('secret')` 把密钥整个抹掉（实测 user 层只剩 site）。
        // 这里是 Host 进程内部读取，要的就是原值。
        //
        // 代价：`describe()` 遍历全部活动条目，实测约 3.4ms/次（约 30 个条目）。
        // 对一次几秒到几分钟的生成调用完全可以忽略。
        //
        // **刻意不做缓存**：缓存会引入「刚保存的配置读不到」这类问题——配置卡
        // 保存与工具调用之间可能只隔几十毫秒，任何 TTL 都会让用户看到
        // 「保存了却没生效」。3.4ms 换掉这类 bug 是划算的。
        settingsSource = () => {
          let layer = {};
          try {
            const views = settings.describe?.();
            const row = Array.isArray(views)
              ? views.find((v) => v.ns === AGNES_SETTINGS_NS)
              : undefined;
            if (row?.user && typeof row.user === "object" && !Array.isArray(row.user)) {
              layer = row.user;
            }
          } catch {
            // describe 不可用（更早的 DSH 版本）时退化为「无用户层覆盖」，
            // 配置回落 rawConfig + 默认值 —— 与注册设置服务之前的行为一致。
            layer = {};
          }
          // 只保留 schema 声明过的字段，并挡掉对象值：volatile 字段在别处可能
          // 以引用空壳形式出现，进了 effectiveConfig() 会污染下游的路径/数值
          // 读取（见本文件关于 `The "paths[N]" argument must be of type string` 的说明）。
          const clean = {};
          for (const key of Object.keys(Config.dict ?? {})) {
            const v = layer[key];
            if (v === undefined) continue;
            if (v !== null && typeof v === "object" && !Array.isArray(v)) continue;
            clean[key] = v;
          }
          return clean;
        };

        // 「用户已覆盖了哪些字段」——**只以实时的 `describe().user` 层为准**。
        //
        // 为什么需要它：机密的 `role('secret')` 字段会被 `redactSecrets()` 从
        // 下发给浏览器的 user 层里**整个删掉**（实测：override 里有 apiKeyIntl，
        // 但浏览器收到的 user 只有 site/plan/gifWidth）。若只靠 `snapshot.user`
        // 判断覆盖状态，机密字段的「已覆盖 / 重置」永远不亮，**而且每次保存
        // API Key 都会误报「保存未生效」**——因为确认通道恒为「没有这个键」。
        // 因此由 Host 侧补一份键名清单。**只回传键名**：值一律不出这一层。
        //
        // 注意**不要**再并上 `Object.keys(rawConfig)`：那是 apply() 那一刻的
        // 快照，用户之后在配置卡里**清除** Key 时它不会跟着消失，界面就会一直
        // 显示「已配置」——实测复现过。而 `describe().user` 读的就是 profile
        // patch 的当前内容，与 rawConfig 同源且**实时**，单个来源即可覆盖
        // 「patch 里写的」与「配置卡刚改的」两种情况。
        settingsUserKeys = () => Object.keys(settingsSource());

        // 关于配置卡：0.1.7 的 `SettingsForms.describe()` 遍历活动条目，
        // 对每个条目调用 `volatileForm(schema)`；**返回 undefined 的条目整条被
        // 剔除**，客户端因此拿不到任何数据。而 volatileForm 只有当 schema 里
        // 存在 `.volatile()` 字段时才不返回 undefined：
        //
        //     volatileForm(schema):
        //       schema.meta.volatile  -> 整个 schema 变表单
        //       type === 'object'     -> 递归收集标了 volatile 的子字段
        //       否则                   -> undefined（条目被 describe 丢弃）
        //
        // 所以 `lib/config-schema.js` 的 Config **逐字段**标了 `.volatile()`
        // ——这是配置卡能在 0.1.7 显示的前提，不是可选项。判定条件与插件来源
        // 无关（第一方 `dsh-web-search-deepseek` 同样如此标记）。
        //
        // `configure({ auto: true })` 在这里**不是**「让条目可见」的开关
        // （可见性由 volatile 决定）；它只声明本插件的页面策略为「按 schema
        // 自动生成」。默认值本就是 true，显式声明一次是为了让策略归属明确
        // （策略绑定到本插件的 fiber）。
        if (typeof settings.configure === "function") {
          ctx.effect(
            () => {
              // configure 在「本条目已注册过页面策略」时会抛；我们是唯一调用方，
              // 不应触发，但仍放 try 里兜底。
              const dispose = settings.configure({ auto: true });
              return typeof dispose === "function" ? dispose : () => {};
            },
            "dsh-agnes-gen: settings auto-form",
          );
        }
        logger.info(
          `运行于 DSH 0.1.7+ 设置接口：配置取自插件条目配置（rawConfig），` +
            `配置表单由 DSH 从 Config 的 volatile 字段投影生成。`,
        );
      }
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
