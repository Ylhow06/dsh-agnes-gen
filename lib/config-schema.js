/**
 * 配置 schema —— 基于真实 `@deepseek-ai/schemastery`。
 *
 * ## 为什么这里可以直接 import
 *
 * 从 npm 安装的插件在 profile 里是一个**真实目录**（不是 junction），
 * Node 的祖先目录查找因此能命中 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。
 * 已发布的第三方插件（如 `dsh-workbuddy-connect`）正是这样 import 的。
 *
 * 只有「本地路径安装」（pnpm `link:` → junction，真实文件在 profile 之外）
 * 会解析失败。开发时用本仓库内的 `node_modules/@deepseek-ai/*` junction 解决
 * （见 README「开发与测试回路」），发布物不受影响。
 *
 * ## 为什么全字段 `.volatile()`
 *
 * DSH 0.1.7 的设置表单**只投影 volatile 字段**：`dsh-settings` 的 `describe()`
 * 对每个活动条目调用 `volatileForm(schema)`，返回 `undefined` 的条目**整条被剔除**，
 * 配置卡因此拿不到任何数据（界面表现为「Host 没有在服务设置命名空间…」）。
 *
 * ```
 * volatileForm(schema):
 *   schema.meta.volatile  -> 整个 schema 变表单
 *   type === 'object'     -> 递归收集标了 volatile 的子字段
 *   否则                   -> undefined（条目被 describe 丢弃）
 * ```
 *
 * 这不是「官方插件才有的待遇」——判定条件与插件来源无关，只看 schema 里有没有
 * volatile 字段。第一方 `dsh-web-search-deepseek` 正是把 `apiKey` / `baseURL` /
 * `model` / `maxUses` 等**逐字段**标了 `.volatile()`，它的配置页才会出现。
 *
 * 不能改标在根节点（`z.object({...}).volatile()`）：那会让 schema 变成惰性引用，
 * 直接求值返回空壳（`RootVol({})` → `{}`），连默认值都拿不到。实测确认。
 * 所以**逐字段**标记。
 *
 * ## 默认值的唯一来源
 *
 * 默认值**只写在 schema 里**（`.default(...)`）。由于 volatile 字段求值时返回
 * 引用对象而不是值，`defaultConfig()` 改为直接读 `meta.default`（见该函数注释）；
 * 单一来源不变，两处数字不可能漂移。
 *
 * ## 关于 `loose()`
 *
 * 这里刻意**不使用** `.loose()`（与第一方 `dsh-web-search-deepseek` 一致）。
 * 语义差异是实质性的：
 *
 *   - 严格（本文件）：`settings.yaml` 里写了非法值时 `installSection` 抛错。
 *     `index.js` 捕获后打 logger.warn，插件行仍然加载，但**配置卡不可用**
 *     （设置节未注册），且用户层被忽略。
 *   - `loose()`：非法值静默回落成默认值，一切照常。
 *
 * RPM 是安全相关的设置（写错会导致 429 或超发），静默改写用户明确写下的数字
 * 比报错更危险。所以选严格 + 显式告警。
 *
 * @module dsh-agnes-gen/lib/config-schema
 */

import z from "@deepseek-ai/schemastery";

import { ENTERPRISE_RPM, FREE_RPM, TOKEN_PLAN_RPM } from "./rate-limit.js";
import { DEFAULT_SITE, IMAGE_MODEL, SITES, SITE_VALUES, VIDEO_MODEL } from "./client.js";

/**
 * 本插件的 settings namespace。小写 kebab-case 是 dsh-settings 的硬要求
 * （`/^[a-z][a-z0-9-]*$/`），非法会在 register 时直接抛错。
 */
export const AGNES_SETTINGS_NS = "agnes-gen";

/** 图像档位，与 client.js 的 IMAGE_SIZES 一致；也是 RPM 表的键。 */
export const RPM_TIERS = ["1K", "2K", "3K", "4K"];

/** 默认预设。 */
export const DEFAULT_PLAN = "free";

/**
 * RPM 预设：对应 Agnes 的密钥档位。
 *
 * 数值不在这里另抄一份，而是直接引用 `lib/rate-limit.js` 的公开参考值表
 * ——两处数字必须永远一致。该表采用官方的 **「实际 RPM」**（而非更高的
 * 「允许发起 RPM」），理由见 `lib/rate-limit.js` 的 OFFICIAL_RPM 注释。
 *
 * 关键事实：**图像的 RPM 按输出档位区分**，而 3K/4K 在**任何**档位下都只有
 * 1 RPM。这正是「单个 imageRpm 数字」表达不清的根源：设成 30 会让 4K 也按
 * 30 发，必然撞 429。
 */
export const PLANS = {
  free: {
    label: "免费 / 默认密钥",
    image: FREE_RPM.image,
    video: FREE_RPM.video,
  },
  enterprise: {
    label: "企业（enterprise）密钥",
    image: ENTERPRISE_RPM.image,
    video: ENTERPRISE_RPM.video,
  },
  "token-plan": {
    label: "Token Plan 密钥",
    image: TOKEN_PLAN_RPM.image,
    video: TOKEN_PLAN_RPM.video,
  },
};

/** 预设的可选值，供 UI 与校验共用。 */
export const PLAN_VALUES = Object.keys(PLANS);

/** 逐档位 RPM 覆盖的字段名，如 `imageRpm1K`。 */
export const rpmKeyFor = (tier) => `imageRpm${tier}`;

/** 覆盖值语义：`> 0` 生效，`0` 表示跟随预设。 */
const FOLLOW_PRESET = 0;

/**
 * 插件配置 schema。
 *
 * RPM 用「预设 + 逐档位覆盖」两层表达：
 *   - `plan` 选基线（免费 / Token Plan），对应 Agnes 公布的档位；
 *   - `imageRpm1K` … `imageRpm4K` / `videoRpm` 是**逐档位覆盖**，
 *     0 = 跟随预设。
 *
 * 用 0 而不是「空」表示不覆盖：number 字段的空值语义在各层之间容易走样，
 * 而 0 在 RPM 场景下本来就没有意义（不可能限制成 0 请求/分钟）。
 */
export const Config = z.object({
  site: z
    .union(SITE_VALUES)
    .default(DEFAULT_SITE)
    .description(
      `Agnes 服务站点。中国站 ${SITES.cn.base}（平台 ${SITES.cn.consoleUrl}）；` +
        `国际站 ${SITES.intl.base}（平台 ${SITES.intl.consoleUrl}）。` +
        "两站的 Key 不通用，必须选你注册的那一站；各站的 Key 分别保存在 apiKeyCn / apiKeyIntl。",
    ).volatile(),
  apiKeyCn: z
    .string()
    .role("secret")
    .description(
      `中国站（${SITES.cn.base}）的 API Key。申请：${SITES.cn.consoleUrl}。` +
        "在此填写，是唯一的密钥来源。",
    ).volatile(),
  apiKeyIntl: z
    .string()
    .role("secret")
    .description(
      `国际站（${SITES.intl.base}）的 API Key。申请：${SITES.intl.consoleUrl}。` +
        "在此填写，是唯一的密钥来源。",
    ).volatile(),
  /**
   * 旧版的单键字段，保留**只为继续脱敏**。
   *
   * 它不能再被当作有效配置读取（两站各自的键已取代它），但**必须继续声明**：
   * `redactSecrets()` 只剥离 schema 声明过的机密槽位，一旦把 `apiKey` 从 schema
   * 里删掉，老用户 settings.yaml 里已存的明文 Key 就会原样出现在
   * `settings.describe()` 的响应里，直接泄给浏览器。
   *
   * 实测确认：
   *   schema 只声明 apiKeyCn/apiKeyIntl 时
   *   resolved = {"apiKeyCn":"sk-new","apiKey":"sk-LEGACY"}
   *   redacted = {"apiKey":"sk-LEGACY"}        ← 明文泄露
   *
   * `hidden()` 让通用表单跳过它（配置卡只渲染 apiKeyCn / apiKeyIntl），
   * 但保留 `role('secret')` 的脱敏行为。
   */
  apiKey: z.string().role("secret").hidden().volatile(),
  plan: z
    .union(PLAN_VALUES)
    .default(DEFAULT_PLAN)
    .description("密钥档位预设（免费/默认、企业、Token Plan），决定各档位的默认 RPM 上限；下面的逐档位覆盖可再单独调整。").volatile(),
  imageRpm1K: z
    .number()
    .min(0)
    .step(1)
    .default(FOLLOW_PRESET)
    .description("覆盖 1K 档位的 RPM 上限。0 = 跟随预设。").volatile(),
  imageRpm2K: z
    .number()
    .min(0)
    .step(1)
    .default(FOLLOW_PRESET)
    .description("覆盖 2K 档位的 RPM 上限。0 = 跟随预设。").volatile(),
  imageRpm3K: z
    .number()
    .min(0)
    .step(1)
    .default(FOLLOW_PRESET)
    .description("覆盖 3K 档位的 RPM 上限。0 = 跟随预设（两种档位下都是 1）。").volatile(),
  imageRpm4K: z
    .number()
    .min(0)
    .step(1)
    .default(FOLLOW_PRESET)
    .description("覆盖 4K 档位的 RPM 上限。0 = 跟随预设（两种档位下都是 1）。").volatile(),
  videoRpm: z
    .number()
    .min(0)
    .step(1)
    .default(FOLLOW_PRESET)
    .description("覆盖视频 RPM 上限。0 = 跟随预设。创建任务与轮询共用这一个池。").volatile(),
  rateLimit: z
    .boolean()
    .default(true)
    .description("启用本地跨进程 RPM 限流。关闭后完全依赖服务端 429 退避。").volatile(),
  ffmpegPath: z
    .string()
    .default("")
    .description("ffmpeg 可执行文件路径。留空则按 PATH 查找。").volatile(),
  gifWidth: z
    .number()
    .min(64)
    .max(1920)
    .step(1)
    .default(480)
    .description("GIF 默认宽度（像素）。单次调用仍可用 gif_width 参数覆盖。").volatile(),
  gifFps: z
    .number()
    .min(1)
    .max(60)
    .step(1)
    .default(12)
    .description("GIF 默认帧率。单次调用仍可用 gif_fps 参数覆盖。").volatile(),
  outDir: z
    .string()
    .default("")
    .description("默认输出根目录。留空 = <工作目录>/out/agnes-images 与 out/agnes-videos。").volatile(),
  /**
   * 每站的图像/视频模型「可选集 + 选中项」。
   *
   * 由于两站的可选模型不同（实测：国际站含 agnes-image-2.0-flash，中国站没有；
   * 国际站没有 agnes-video-v2.0 的兄弟项），所以**按站点各存一份**：
   *   - `imageModels<Site>` / `videoModels<Site>`：该站「可选的模型 ID」集合。
   *     填了 key 点「校验 Key」可用 `/v1/models` 拉取并按 id 自动填充；
   *     没填 key、或拉取失败时回落到内置的文档已知模型 ID 作兜底。
   *   - `imageModel<Site>` / `videoModel<Site>`：该站的**生效（选中）模型**。
   *
   * 工具校验：`model` 参数允许该站点集内的任意值，不传则默认用选中项；
   * 集为空时回落内置 IMAGE_MODEL / VIDEO_MODEL。
   */
  imageModelsCn: z.array(z.string()).default([IMAGE_MODEL]).volatile(),
  imageModelsIntl: z.array(z.string()).default([IMAGE_MODEL]).volatile(),
  imageModelCn: z.string().default(IMAGE_MODEL).volatile(),
  imageModelIntl: z.string().default(IMAGE_MODEL).volatile(),
  videoModelsCn: z.array(z.string()).default([VIDEO_MODEL]).volatile(),
  videoModelsIntl: z.array(z.string()).default([VIDEO_MODEL]).volatile(),
  videoModelCn: z.string().default(VIDEO_MODEL).volatile(),
  videoModelIntl: z.string().default(VIDEO_MODEL).volatile(),
});

/** 字段顺序即表单顺序，因此单独固定一份，不依赖对象的键序。 */
export const CONFIG_FIELD_ORDER = [
  "site",
  // apiKeyCn / apiKeyIntl 是真正生效的两站密钥；apiKey 是仅供脱敏的历史槽位，
  // 因此排在最后，且界面上不渲染（hidden()）。
  "apiKeyCn",
  "apiKeyIntl",
  // 每站的模型「可选集 + 选中项」，紧随站点/Key，配置卡把它们放在 Key 框旁的下拉里。
  "imageModelsCn",
  "imageModelsIntl",
  "imageModelCn",
  "imageModelIntl",
  "videoModelsCn",
  "videoModelsIntl",
  "videoModelCn",
  "videoModelIntl",
  "plan",
  "imageRpm1K",
  "imageRpm2K",
  "imageRpm3K",
  "imageRpm4K",
  "videoRpm",
  "rateLimit",
  "ffmpegPath",
  "gifWidth",
  "gifFps",
  "outDir",
  // 仅供脱敏的历史槽位，排最后（界面上 hidden，不渲染）。
  "apiKey",
];

/**
 * 从 schema 的 `meta.default` 读出出厂默认值。
 *
 * ## 为什么不求值 `Config({})`
 *
 * **所有字段都标了 ``（见文件头「为什么全字段 volatile」），
 * 而 volatile 字段在求值时返回的是引用对象而不是值：**
 *
 * ```
 * Config({})  ->  { site: {}, apiKeyCn: {}, plan: {}, ... }   // 全是空壳
 * ```
 *
 * 这是 Schemastery 的正常语义——volatile 字段是「可变的活引用」，
 * 运行时必须 `.get()` 解包（第一方 `dsh-web-search-deepseek` 读配置时
 * 就是逐字段 `config.apiKey.get()`）。本插件自己不做 `.get()` 解包，
 * 而是把 schema 当**默认值声明表**读，因此改成直接取 `meta.default`。
 *
 * 单一来源原则不变：默认值仍然只写在 schema 的 `.default(...)` 里，
 * 这里只是换一种读法，两处数字不可能漂移。
 *
 * 没有 `.default()` 的字段（`apiKeyCn` / `apiKeyIntl` / `apiKey`）不出现在
 * 结果里，与旧行为一致。
 *
 * @returns {Record<string, unknown>} 出厂默认配置
 */
export function defaultConfig() {
  const read = (node) => {
    if (node.type === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        const value = read(child);
        if (value !== undefined) out[key] = value;
      }
      return Object.keys(out).length ? out : undefined;
    }
    const fallback = node.meta?.default;
    return fallback === undefined ? undefined : structuredClone(fallback);
  };
  return read(Config) ?? {};
}

/**
 * 可以下发给浏览器的默认值表，即 {@link defaultConfig} 去掉机密字段。
 *
 * 机密字段的默认值目前只是空串、泄露不了什么，但「默认值表」本身没有理由
 * 携带任何机密槽位——排除掉之后，将来即使默认值不再是空串也不会意外外泄。
 *
 * @returns {Record<string, unknown>} 不含机密字段的默认值
 */
export function publicDefaults() {
  const resolved = defaultConfig();
  const out = {};
  for (const key of CONFIG_FIELD_ORDER) {
    if (isSecretField(key)) continue;
    if (key in resolved) out[key] = resolved[key];
  }
  return out;
}

/** 某个字段是否被 schema 标记为机密。 */
export function isSecretField(key) {
  return Config.dict?.[key]?.meta?.role === "secret";
}

/** 全部机密字段名。 */
export function secretFieldNames() {
  return CONFIG_FIELD_ORDER.filter((key) => isSecretField(key));
}

/**
 * 每个站点对应的**密钥配置字段名**。
 *
 * 两站的 Key 不通用，所以各存一份、各用一份：选了哪一站，就只读那一站的键。
 * 这样切换站点不会让另一站的 Key 生效，也不会互相覆盖。
 */
export const SITE_KEY_FIELDS = {
  cn: "apiKeyCn",
  intl: "apiKeyIntl",
};

/**
 * 取当前站点该用的密钥字段名。
 *
 * @param {{site?: string}} [config]
 * @returns {string} 字段名（未知站点回落到默认站）
 */
export function keyFieldForSite(config) {
  return SITE_KEY_FIELDS[config?.site] ?? SITE_KEY_FIELDS[DEFAULT_SITE];
}

/**
 * 取当前站点该用的密钥值——**只取该站点自己的那个字段**。
 *
 * 刻意不回落到另一站的键：那会让「中国站的 Key 被发到国际站」这种必然 401
 * 的错配变得可能。`readKey()` 只认配置里的显式 Key，没有其它兜底。
 *
 * @param {object} [config] 解析后的配置
 * @returns {string|undefined} 该站点的显式密钥（未配置时 undefined）
 */
export function siteKeyOf(config) {
  const value = config?.[keyFieldForSite(config)];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * 取某类工具在当前站点的「可选模型集 + 选中（生效）模型」。
 *
 * 每站各存一份（实测两站模型不同），按 `config.site`（缺省回落 DEFAULT_SITE）
 * 选字段：`imageModels<Site>` / `videoModels<Site>` 是可选集，
 * `imageModel<Site>` / `videoModel<Site>` 是选中项。
 *
 * @param {{site?: string, imageModelsCn?: string[], imageModelsIntl?: string[], imageModelCn?: string, imageModelIntl?: string, videoModelsCn?: string[], videoModelsIntl?: string[], videoModelCn?: string, videoModelIntl?: string}} [config] 解析后的配置
 * @param {"image"|"video"} kind
 * @returns {{list: string[], selected: string, fallback: string}}
 *   list：该站可选模型 ID，去重后（空则回落内置内置默认的单个元素清单）。
 *   selected：该站选中（生效）模型；不在 list 内时回落 list 第一项，再回落内置默认。
 *   fallback：内置默认 ID（IMAGE_MODEL / VIDEO_MODEL）。
 */
export function resolveModels(config, kind) {
  const site = SITES[config?.site] ? config.site : DEFAULT_SITE;
  // 站点键 'cn'/'intl' 对应字段后缀 'Cn'/'Intl'（首字母大写）。
  const suffix = site === "intl" ? "Intl" : "Cn";
  const fallback = kind === "video" ? VIDEO_MODEL : IMAGE_MODEL;
  const set = kind === "video" ? `videoModels${suffix}` : `imageModels${suffix}`;
  const sel = kind === "video" ? `videoModel${suffix}` : `imageModel${suffix}`;
  const raw = Array.isArray(config?.[set])
    ? config[set].filter((m) => typeof m === "string" && m.trim())
    : [];
  const list = [...new Set(raw)];
  if (!list.length) return { list: [], selected: fallback, fallback };
  const chosen = typeof config?.[sel] === "string" && config[sel].trim() ? config[sel].trim() : "";
  const selected = chosen && list.includes(chosen) ? chosen : list[0];
  return { list, selected, fallback };
}

/**
 * 把「预设 + 逐档位覆盖」折算成实际生效的 RPM 表。
 *
 * 这是整个 RPM 配置的**唯一**求解点：Host 的工具执行与诊断路由都用它，
 * 因此界面显示的数值与实际限流用的数值不可能不一致。
 *
 * 覆盖语义：某档位的覆盖值 `> 0` 时生效；`0` 或非正数表示跟随预设。
 * 被覆盖的档位会记进 `overridden`，界面据此标注「已覆盖」。
 *
 * @param {object} config 解析后的配置
 * @returns {{plan: string, planLabel: string, image: Record<string, number>, video: number, overridden: string[]}}
 */
export function effectiveLimits(config) {
  const planKey = PLANS[config?.plan] ? config.plan : DEFAULT_PLAN;
  const plan = PLANS[planKey];
  const overridden = [];

  const image = {};
  for (const tier of RPM_TIERS) {
    const key = rpmKeyFor(tier);
    const override = config?.[key];
    if (Number.isFinite(override) && override > 0) {
      image[tier] = override;
      overridden.push(key);
    } else {
      image[tier] = plan.image[tier];
    }
  }

  const videoOverride = config?.videoRpm;
  let video;
  if (Number.isFinite(videoOverride) && videoOverride > 0) {
    video = videoOverride;
    overridden.push("videoRpm");
  } else {
    video = plan.video;
  }

  return { plan: planKey, planLabel: plan.label, image, video, overridden };
}
