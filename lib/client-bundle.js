/**
 * dsh-agnes-gen 的浏览器半侧：在「插件」页里给本插件渲染一张配置卡。
 *
 * ## 这个文件为什么长这样
 *
 * DSH 的客户端模块系统加载的是 **lazy-CJS factory bundle**，不是 ESM：
 * 文件顶层调用 `window.__ModuleLoader__.load({ id, factory })`，`factory`
 * 内部用 `require(...)` 取依赖。`id` **必须严格等于包名**——`dsh-client-modules`
 * 把浏览器半侧挂在「说明符恰为包名」的那一行 Loader row 上，对不上会报
 * 「bundle loaded without registering」。
 *
 * 官方仓库内的包由 `tsdown` 的 `clientBundle` 预设产出这个格式，而该预设
 * 并未作为独立包发布，因此仓库之外的插件得自己复刻。本文件就是手工复刻的
 * 结果——**没有构建步骤**，改完直接生效（浏览器端 HMR 会重载）。
 *
 * ## 为什么用 React.createElement 而不是 JSX
 *
 * 没有构建步骤，就没有 JSX 转换。`h()` 只是同一件事的显式写法。
 *
 * ## 依赖面
 *
 * 只 `require("react")`，它在 shell 的平台模块基线表（`PLATFORM_MODULES`）
 * 里，因此**不需要** `dsh.client.external`。样式用 `--dsw-*` 设计令牌，
 * 与随附插件卡片的观感一致，同时避免依赖 UI 组件库的具体 API。
 *
 * ## 配置读写
 *
 * 通过 `ctx.settingsScope.bind({ namespace: "agnes-gen" })` 读写，与 Host
 * 半侧注册的 settings namespace 同名——这个键就是两半配对的依据。
 *
 * 快照里的 `value` 是**已脱敏**的解析值（`apiKey` 被剥离），`user` 是原始
 * 用户层：某字段是否被用户覆盖，取决于它在 `user` 里**是否存在**，而不是
 * 它的值。机密字段「是否已配置」由 Host 的诊断路由告知，页面永远拿不到明文。
 *
 * @module dsh-agnes-gen/lib/client-bundle
 */

window.__ModuleLoader__.load({
  id: "dsh-agnes-gen",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Host 半侧注册的 settings namespace，也是本卡与 Host 配对的键。 */
    const SETTINGS_NS = "agnes-gen";
    /** Host 半侧注册的诊断路由。 */
    const STATUS_PATH = "/plugins/dsh-agnes-gen/status";
    /** Host 半侧注册的 Key+模型校验路由。 */
    const CHECK_PATH = "/plugins/dsh-agnes-gen/check";

    /**
     * RPM 预设。数值与 Host 侧 `lib/rate-limit.js` 的公开参考值一致
     * （原始出处为 Agnes Token Plan FAQ），这里用于在界面上**展示**每个
     * 档位的实际上限，并支撑「跟随预设」的提示；真正生效的限流上限由
     * Host 侧的 `effectiveLimits()` 计算，两者同源，因此不会互相矛盾。
     *
     * 注意 3K / 4K：两种档位下都只有 1 RPM。这是「单个 RPM 数字」表达
     * 不清的根源——统一设成 30 会让 4K 也按 30 发，必然撞 429。
     */
    const PLANS = {
      free: { label: "免费 / 默认密钥", image: { "1K": 20, "2K": 10, "3K": 1, "4K": 1 }, video: 1 },
      "token-plan": { label: "Token Plan 密钥", image: { "1K": 100, "2K": 80, "3K": 1, "4K": 1 }, video: 5 },
    };
    /** 预设的可选值，顺序即下拉顺序。 */
    const PLAN_VALUES = ["free", "token-plan"];
    /** 图像档位，顺序即界面顺序。 */
    const TIERS = ["1K", "2K", "3K", "4K"];

    /**
     * Agnes 的两个独立站点。与 Host 侧 `lib/client.js` 的 SITES 必须保持一致
     * （浏览器半侧不能 import Host 代码，所以这里是各写一份的约定，
     * 由 selfcheck 校验两半的键名契约）。
     *
     * 两站的 API 路径完全相同，但**主机与令牌体系是独立的**——拿国际站的 Key
     * 打国内站的域名只会得到 401。所以这个选择项是必需的，不是可选装饰。
     */
    const SITES = {
      cn: { label: "中国站", base: "https://api.agnes-ai.cn", consoleUrl: "https://platform.agnes-ai.cn/settings/apiKeys" },
      intl: { label: "国际站", base: "https://apihub.agnes-ai.com", consoleUrl: "https://platform.agnes-ai.com/settings/apiKeys" },
    };
    /** 站点可选值，顺序即下拉顺序。 */
    const SITE_VALUES = ["cn", "intl"];

    /** 预设中各档位的默认上限（非正数或未知预设时回落到免费档）。 */
    function planLimits(plan) {
      return PLANS[plan] ?? PLANS.free;
    }

    /**
     * 每个站点对应的密钥字段名。与 Host 侧 `config-schema.js` 的
     * `SITE_KEY_FIELDS` 必须一致（selfcheck 会校验）。
     *
     * 两站的 Key 各存一份、各用一份：选了哪一站就只读那一站的键，
     * 因此切换站点不会让另一站的 Key 生效或互相覆盖。
     */
    /** 当前站点该用的密钥字段名。 */
    function keyFieldForSite(site) {
      return KEY_FIELDS.find((f) => f.site === site)?.key ?? "apiKeyCn";
    }

    const CSS = [
      // 关键：DSH 的 shell 没有全局 box-sizing 兜底，而下面这些控件都是
      // 「width:100% + padding + border」。用 content-box 时实际渲染宽度
      // = 列宽 + 左右 padding + 边框，会溢出网格列、压到下一列上
      // （RPM 输入框与「重置」按钮重叠就是这么来的）。整张卡片统一 border-box。
      ".agn-card,.agn-card *{box-sizing:border-box}",
      ".agn-card{display:flex;flex-direction:column;gap:14px}",
      ".agn-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
      ".agn-field{display:flex;flex-direction:column;gap:6px}",
      ".agn-field+.agn-field{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px}",
      ".agn-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".agn-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".agn-badges{display:inline-flex;align-items:center;gap:8px}",
      ".agn-tag{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}",
      ".agn-reset{font:inherit;font-size:12px;line-height:1.5;background:0 0;border:0;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
      ".agn-reset:disabled{cursor:default;opacity:.5}",
      ".agn-input{height:34px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
      ".agn-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".agn-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
      ".agn-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}",
      ".agn-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
      ".agn-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}",
      ".agn-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".agn-footer{display:flex;align-items:center;gap:8px;padding-top:4px}",
      ".agn-save{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
      ".agn-save:disabled{opacity:.4;cursor:default}",
      ".agn-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".agn-ghost{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;border-radius:8px;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}",
      ".agn-ghost:disabled{opacity:.5;cursor:default}",
      ".agn-danger{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;border-radius:8px;cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      ".agn-danger:disabled{opacity:.5;cursor:default}",
      ".agn-status{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".agn-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
      ".agn-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}",
      ".agn-probe{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
      ".agn-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      // RPM 行：三列 —— 标签（弹性）/ 输入框（定宽）/ 操作位（定宽）。
      //
      // 两个坑都在这里：
      //   1. 输入框必须 `min-width:0`。grid item 默认 `min-width:auto`，
      //      会把 input 撑到内容固有宽度（约 178px），溢出 88px 的列宽，
      //      直接压到右侧的「重置」按钮上——这就是重叠的根因。
      //   2. 第三列用**定宽**而不是 auto。每个 .agn-rpmRow 都是独立 grid，
      //      auto 列的宽度取决于「有没有重置按钮」，会让有按钮和没按钮的
      //      两行算出不同的前两列宽度，输入框左右错位。定宽 + 同宽占位符
      //      保证所有行的输入框严格对齐。
      ".agn-rpmRow{display:grid;grid-template-columns:minmax(0,1fr) 88px 52px;align-items:center;gap:8px 10px}",
      ".agn-rpmLabel{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".agn-rpmName{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".agn-rpmPlanValue{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
      ".agn-rpmInput{width:100%;min-width:0;text-align:right;font-variant-numeric:tabular-nums}",
      ".agn-rpmSpacer{display:block;width:100%}",
      ".agn-rpmReset{justify-self:end;white-space:nowrap}",
      ".agn-rpmHint,.agn-rpmError{grid-column:1 / -1;margin:0}",
      ".agn-select{height:34px;padding:0 8px;font:inherit;font-size:13px;line-height:1.5;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
      ".agn-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".agn-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
      ".agn-modelCheck{margin-top:2px}",
      ".agn-modelCustom{margin-top:6px}",
    ].join("");

    function installStyles() {
      const id = "dsh-agnes-gen/card.css";
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-agnes-gen";
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------- 字段表（与 Host 半侧 lib/config-schema.js 一一对应） ----------------

    /**
     * 每个字段的 UI 元信息。`kind` 决定控件类型与解析方式。
     * Host 才是值是否被接受的唯一裁判，这里只做「明显不合法就别提交」的拦截。
     *
     * RPM 相关字段不在这里：它们由「预设选择器 + 逐档位覆盖」这一组专门渲染，
     * 因为它们的语义是耦合的（覆盖值 0 表示跟随预设）。
     */
    const FIELDS = [
      {
        key: "rateLimit",
        label: "启用本地 RPM 限流",
        kind: "boolean",
        desc: "关闭后完全依赖服务端的 429 退避；并发调用时更容易撞上限。",
      },
      {
        key: "ffmpegPath",
        label: "ffmpeg 路径",
        kind: "text",
        desc: "留空则按 PATH 查找。",
      },
      {
        key: "gifWidth",
        label: "GIF 默认宽度",
        kind: "number",
        min: 64,
        max: 1920,
        desc: "像素。单次调用仍可用 gif_width 参数覆盖。",
      },
      {
        key: "gifFps",
        label: "GIF 默认帧率",
        kind: "number",
        min: 1,
        max: 60,
        desc: "单次调用仍可用 gif_fps 参数覆盖。",
      },
      {
        key: "outDir",
        label: "默认输出目录",
        kind: "text",
        desc: "输出根目录。留空 = 会话工作目录下的 out/agnes-images 与 out/agnes-videos。",
      },
      // 每站的模型【可选集 + 选中项】。它们的渲染放在 SiteField 里（下拉，紧跟 Key），
      // 不在这里的通用循环里；kind "model" 让通用循环跳过，但 specFor 仍能解析它们
      // （否则编辑保存会被静默丢弃）。
      // 可选集（数组）
      { key: "imageModelsCn", kind: "model", site: "cn", type: "image", role: "set", label: "中国站图像模型集" },
      { key: "imageModelsIntl", kind: "model", site: "intl", type: "image", role: "set", label: "国际站图像模型集" },
      { key: "videoModelsCn", kind: "model", site: "cn", type: "video", role: "set", label: "中国站视频模型集" },
      { key: "videoModelsIntl", kind: "model", site: "intl", type: "video", role: "set", label: "国际站视频模型集" },
      // 选中项（生效模型，字符串）
      { key: "imageModelCn", kind: "model", site: "cn", type: "image", role: "selected", label: "中国站图像生效模型" },
      { key: "imageModelIntl", kind: "model", site: "intl", type: "image", role: "selected", label: "国际站图像生效模型" },
      { key: "videoModelCn", kind: "model", site: "cn", type: "video", role: "selected", label: "中国站视频生效模型" },
      { key: "videoModelIntl", kind: "model", site: "intl", type: "video", role: "selected", label: "国际站视频生效模型" },
    ];

    const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

    /**
     * 两站的密钥字段。它们**不**在 FIELDS 里（那样会同时渲染两个 Key 框），
     * 而是由 SiteField 按当前站点只显示对应的那一个。
     *
     * 但它们在 SECRET_KEYS 里——否则「覆盖状态只能靠 Host 报告」的机密字段
     * 不会被当成机密处理（值会被当作普通字段读取、覆盖状态无法由
     * `overriddenKeys` 补足）。
     */
    const KEY_FIELDS = [
      {
        key: "apiKeyCn",
        label: "中国站 API Key",
        site: "cn",
        kind: "secret",
        desc: "中国站（api.agnes-ai.cn）的 Key。在此填写后在「中国站」config 与生图/生视频时使用。",
      },
      {
        key: "apiKeyIntl",
        label: "国际站 API Key",
        site: "intl",
        kind: "secret",
        desc: "国际站（apihub.agnes-ai.com）的 Key。两站 Key 不通用，各存一份、各用一份；在此填写后在「国际站」时使用。",
      },
    ];

    /** 密钥字段名 → 站点。 */
    function siteForKey(key) {
      const f = KEY_FIELDS.find((k) => k.key === key);
      return f?.site;
    }

    /**
     * RPM 覆盖字段的键名。必须与 Host 侧 config-schema.js 完全一致——
     * `imageRpm${tier}` 与 `videoRpm` 是这个两半之间的约定。
     */
    const rpmKeyFor = (tier) => `imageRpm${tier}`;
    const VIDEO_RPM_KEY = "videoRpm";

    /** 机密字段：它们被 Host 从 `user` 层里剥掉，因此覆盖状态只能由 Host 告知。 */
    const SECRET_KEYS = new Set([...FIELDS.filter((f) => f.kind === "secret").map((f) => f.key), ...KEY_FIELDS.map((f) => f.key)]);

    /**
     * 「恢复默认」要清除的字段。
     *
     * 刻意**不含机密字段**：清除整个用户分节（`unset path:[]`）会把已存的
     * API Key 一起删掉——为了重置 GIF 宽度而丢掉密钥是很糟的意外。密钥有
     * 自己那一行的「清除已配置的 Key」，由用户显式清除。
     *
     * 同样**不含 `site`、站点下的模型字段（可选集/选中项）**：站点、Key、模型
     * 属于「环境/凭据」类，「恢复默认」应完全保留它们——Key 靠输入框旁的
     * 「清除已配置的 Key」，模型靠下拉手动改。这里只含运行参数类字段。
     */
    const RESETTABLE_KEYS = [
      ...FIELDS.map((f) => f.key).filter(
        (key) => !SECRET_KEYS.has(key) && FIELD_BY_KEY.get(key)?.kind !== "model",
      ),
      "plan",
      ...TIERS.map(rpmKeyFor),
      VIDEO_RPM_KEY,
    ];

    /**
     * RPM 覆盖字段的合成字段描述。
     *
     * 它们不在 FIELDS 里（由专门的分组控件渲染），但校验与提交流程都要按
     * 普通 number 字段处理，所以在这里补一份等价描述。`min: 0` 允许 0，
     * 因为 0 的语义是「跟随预设」。
     */
    function rpmFieldSpec(key, label) {
      return { key, label, kind: "number", min: 0, desc: "0 = 跟随预设。" };
    }

    /** 预设选择器的字段描述：字符串型，取值限于 PLAN_VALUES。 */
    const PLAN_FIELD_SPEC = { key: "plan", label: "密钥档位预设", kind: "text", values: PLAN_VALUES };

    /**
     * 站点选择器的字段描述。
     *
     * `site` 在 FIELDS 里**不**出现——它和 `plan` 一样由专门控件渲染，
     * 但必须能被 `specFor()` 查到，否则编辑会被静默丢弃（`plan` 曾因此保存不上）。
     */
    const SITE_FIELD_SPEC = { key: "site", label: "Agnes 站点", kind: "text", values: SITE_VALUES };

    /**
     * 解析任意字段键——包括 RPM 覆盖字段与预设——对应的字段描述。
     *
     * 这个函数是 `plan()` / `invalidFields()` 的唯一查找入口，因此任何
     * 在这里拿不到描述的键都会被**静默丢弃**。新增字段时必须同步这里，
     * 否则它的编辑保存不了（本项目实测踩过：`plan` 曾因此保存不上）。
     */
    function specFor(key) {
      const known = FIELD_BY_KEY.get(key);
      if (known) return known;
      const keyField = KEY_FIELDS.find((f) => f.key === key);
      if (keyField) return keyField;
      if (key === "site") return SITE_FIELD_SPEC;
      if (key === "plan") return PLAN_FIELD_SPEC;
      if (key === VIDEO_RPM_KEY) return rpmFieldSpec(key, "视频 RPM 上限");
      for (const tier of TIERS) {
        if (key === rpmKeyFor(tier)) return rpmFieldSpec(key, `${tier} 图像 RPM 上限`);
      }
      return undefined;
    }

    /** 把字段值格式化成输入框文本（值缺失时用空串，让 placeholder 接管）。 */
    function formatValue(field, value) {
      if (value === undefined || value === null) return "";
      if (field.kind === "boolean") return value === true ? "true" : "false";
      if (field.kind === "textlist" && Array.isArray(value)) return value.join(", ");
      return String(value);
    }

    /** 深比较：支持标量与数组（模型集是数组，浅比较会把不同引用的同值数组误判为不等）。 */
    function deepEqualValue(left, right) {
      if (left === right) return true;
      if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        return left.every((v, i) => deepEqualValue(v, right[i]));
      }
      return false;
    }

    /**
     * 解析用户输入的文本。
     * @returns {{ok: true, value: unknown} | {ok: false, message: string}}
     */
    function parseValue(field, text) {
      const raw = String(text ?? "").trim();
      if (field.kind === "number") {
        if (raw === "") return { ok: false, message: "该字段不能为空。" };
        const num = Number(raw);
        if (!Number.isFinite(num)) return { ok: false, message: "请输入数字。" };
        if (!Number.isInteger(num)) return { ok: false, message: "请输入整数。" };
        if (typeof field.min === "number" && num < field.min) return { ok: false, message: `不能小于 ${field.min}。` };
        if (typeof field.max === "number" && num > field.max) return { ok: false, message: `不能大于 ${field.max}。` };
        return { ok: true, value: num };
      }
      if (field.kind === "boolean") {
        if (raw === "true") return { ok: true, value: true };
        if (raw === "false") return { ok: true, value: false };
        return { ok: false, message: "请输入 true 或 false。" };
      }
      if (field.kind === "textlist" || field.role === "set") {
        // 逗号 / 换行 / 空白分隔多个值，去空去重后存成数组。
        const items = text
          .split(/[\s,，\n]+/)
          .map((s) => String(s).trim())
          .filter(Boolean);
        const uniq = [...new Set(items)];
        return { ok: true, value: uniq };
      }
      return { ok: true, value: text };
    }

    /**
     * 校验并解析一条草稿。
     *
     * 数字字段的空值视为「未改动」而非错误——清空输入框是编辑途中的常见
     * 状态，为此报错会很吵。布尔字段由复选框驱动，同样不可能手输错误。
     *
     * @returns {{ok: true, value?: unknown} | {ok: false, message: string}}
     */
    function checkDraft(field, draft) {
      const raw = String(draft ?? "").trim();
      if (field.kind === "boolean") {
        // 复选框只会给出 "true" / "false"；其它值说明状态异常，按未改动处理。
        if (raw === "true") return { ok: true, value: true };
        if (raw === "false") return { ok: true, value: false };
        return { ok: true };
      }
      // 枚举字段（预设）由下拉框驱动，只接受声明过的取值。
      if (Array.isArray(field.values)) {
        if (!field.values.includes(raw)) return { ok: false, message: `只能是 ${field.values.join(" / ")} 之一。` };
        return { ok: true, value: raw };
      }
      if (raw === "") return { ok: true };
      return parseValue(field, draft);
    }

    // ---------------- 控制器：暂存、校验、保存 ----------------

    /**
     * 一次编辑会话：把用户输入暂存在内存里，只有 save() 才写回 Host。
     *
     * 这是随附插件的既有约定——「只有保存才写入」，离开页面即丢弃草稿。
     * 每次写入都带上读取时的 revision 设栅，因此已与文档脱节的表单会被拒绝，
     * 而不是覆盖并发变更。
     */
    class CardController {
      constructor(scope) {
        this.scope = scope;
        this.listeners = new Set();
        this.drafts = new Map();
        this.saving = false;
        this.failed = "";
        this.notice = "";
        this.status = null;
        this.statusLoading = false;
        this.statusError = "";
        this.resetArmed = false;
        this.checkLoading = false;
        this.checkError = "";
        this.checkResult = null;
        // 模型下拉当前处于「自定义」模式的可选集键（需在本页内记住，因选中值可能
        // 恰好在可选集里而丢了自定义意图）。
        this.customs = new Set();
        // 订阅回调只负责通知重渲染——所有状态读取都直读 scope（见 read()），
        // 因此不存在「缓存快照过期导致用上一帧状态做决定」的问题。
        this.unsubscribe = scope.subscribe(() => this.emit());
        // 注意：bound scope 上**没有** ensure()，bind() 内部已经 ensure 过镜像。
      }

      /** 某字段当前生效的值（直读 scope）。 */
      storedValue(key) {
        return this.read().value?.[key];
      }

      dispose() {
        if (this.unsubscribe) this.unsubscribe();
        this.listeners.clear();
      }

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }

      emit() {
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch (err) {
            // 一个坏掉的订阅者不该拖垮其他订阅者。
            console.error("[dsh-agnes-gen] card listener failed:", err);
          }
        }
      }

      /** 当前快照（来自 settings scope）。所有状态判断都直读它，不做缓存。 */
      read() {
        return this.scope.getSnapshot();
      }

      /**
       * 用户层里**实际存在**的键集合。
       *
       * `snapshot.user` 是权威来源，但它缺一类字段：机密字段被 Host 的
       * `redactSecrets()` 从 user 层里**整个删掉**，所以 `apiKey` 永远不在其中。
       * 因此再并上 Host 诊断路由补报的键名——但**只取机密字段那些**：
       * 非机密字段本来就在 `snapshot.user` 里看得见，而诊断报告是上一次
       * 「检测」时的缓存，把过期的非机密键也并进来会让「恢复默认」按钮
       * 在已经清空之后仍然亮着。
       *
       * 少了机密那一半，API Key 行的「已覆盖 / 重置」就永远不会出现。
       */
      userKeys() {
        const user = this.read().user;
        const visible = typeof user === "object" && user !== null ? Object.keys(user) : [];
        const reported = Array.isArray(this.status?.overriddenKeys) ? this.status.overriddenKeys : [];
        return new Set([...visible, ...reported.filter((key) => SECRET_KEYS.has(key))]);
      }

      /** 该字段是否被用户层覆盖——看它是否**出现**在用户层里，而非法它的值。 */
      isOverridden(key) {
        return this.userKeys().has(key);
      }

      /** 是否有任何可恢复默认的字段被覆盖（机密字段不计入，它不会被一起重置）。 */
      hasResettableOverrides() {
        const keys = this.userKeys();
        return RESETTABLE_KEYS.some((key) => keys.has(key));
      }

      /** 出厂默认值（由 Host 下发，不含机密字段）；未取到时为空对象。 */
      get defaults() {
        const value = this.status?.defaults;
        return typeof value === "object" && value !== null ? value : {};
      }

      /** 某字段的默认值，用作空输入框的占位提示。 */
      defaultFor(key) {
        const value = this.defaults[key];
        if (value === undefined || value === "") return "";
        return String(value);
      }

      /** 输入框应显示的文本：草稿优先，其次是已解析值。 */
      textOf(field) {
        const draft = this.drafts.get(field.key);
        if (draft === undefined) return formatValue(field, this.storedValue(field.key));
        // 重置标记不是可渲染的文本：清空输入框，让 placeholder 接管。
        if (CardController.isClear(draft)) return "";
        return String(draft);
      }

      edit(key, text) {
        this.drafts.set(key, text);
        this.failed = "";
        this.notice = "";
        // 任何编辑都撤销「恢复默认」的待确认状态，避免误触。
        this.resetArmed = false;
        this.emit();
      }

      resetField(key) {
        this.drafts.set(key, { clear: true });
        this.failed = "";
        this.notice = "";
        this.resetArmed = false;
        this.customs.delete(key);
        this.emit();
      }

      /**
       * 立即清除某个 API Key 并给即时反馈（不需要再点「保存」）。
       *
       * 与 resetField 不同：resetField 只是把 key 标记为「清除」草稿，要等用户点
       * 「保存」才落地；而这里点击「清除已配置的 Key」当下就执行一次 unset 并回报。
       * 机密值不下发，落地与否靠 `.userKeys()`（叠加 Host 回报的 overriddenKeys）判断。
       *
       * @param {string} key    该站的 key 字段名（如 apiKeyCn）
       * @param {string} label  可读名，用于反馈文案
       */
      async clearKey(key, label) {
        if (this.saving) return;
        if (!this.userKeys().has(key)) {
          this.notice = `${label} 尚未配置，无需清除。`;
          this.emit();
          return;
        }
        this.saving = true;
        this.failed = "";
        this.notice = "";
        this.drafts.delete(key);
        this.resetArmed = false;
        this.customs.delete(key);
        this.emit();
        try {
          const ops = [{ op: "unset", path: [key] }];
          const accepted = await this.scope.mutate(ops, this.read().revision);
          // force：清除后必须拿到**最新**的 overriddenKeys，否则「已配置」标记
          // 会停留在清除之前的状态（若这次刷新被进行中的请求挡掉）。
          await this.refreshStatus(true);
          // 判据顺序很重要：`mutate()` 的返回值是 Host 的**权威答复**
          //（0.1.7 起返回 boolean：false = Host 拒绝）。回读只能作为补充，
          // 因为机密字段的值/键都不下发，回读永远看不到它。
          if (accepted === false) {
            this.failed = `${label} 清除未生效：Host 拒绝了这次写入，请重试。`;
          } else if (accepted === undefined && this.userKeys().has(key)) {
            // 0.1.6 的 mutate 不返回布尔值，只能靠回读判断。
            this.failed = `${label} 清除未生效：可能需要重新打开配置页重试。`;
          } else {
            this.notice = `${label} 已清除。`;
          }
        } catch (err) {
          this.failed = err instanceof Error ? err.message : String(err);
        } finally {
          this.saving = false;
          this.emit();
        }
      }

      /** 记录某个模型下拉进入「自定义」模式。 */
      setCustom(key) {
        this.customs.add(key);
        this.emit();
      }

      /** 退出「自定义」模式（改选可选集里的模型）。 */
      clearCustom(key) {
        this.customs.delete(key);
        this.emit();
      }

      /** 是否处于「自定义」模式。 */
      isCustom(key) {
        return this.customs.has(key);
      }

      /**
       * 草稿的两种形态：普通输入是字符串；「重置」是 `{ clear: true }` 标记。
       * 判断顺序有讲究——字符串是 object 之外的原始值，必须先排除。
       */
      static isClear(draft) {
        return typeof draft === "object" && draft !== null && draft.clear === true;
      }

      /** 当前生效的站点键（草稿优先于已存值）。 */
      currentSite() {
        const draft = this.drafts.get("site");
        if (typeof draft === "string" && SITES[draft]) return draft;
        const stored = this.storedValue("site");
        return SITES[stored] ? stored : "cn";
      }

      /** 当前生效的预设键（草稿优先于已存值）。 */
      currentPlan() {
        const draft = this.drafts.get("plan");
        if (typeof draft === "string" && PLANS[draft]) return draft;
        const stored = this.storedValue("plan");
        return PLANS[stored] ? stored : "free";
      }

      /** 当前预设的默认上限表。 */
      planLimits() {
        return planLimits(this.currentPlan());
      }

      /**
       * 某个档位**实际生效**的上限：覆盖值 > 0 时用覆盖值，否则跟随预设。
       *
       * 这与 Host 侧 `effectiveLimits()` 是同一套规则，因此界面显示的
       * 数字就是真正会被用来限流的数字。
       */
      effectiveRpm(key) {
        const draft = this.drafts.get(key);
        let override;
        if (CardController.isClear(draft)) override = 0;
        else if (draft !== undefined) {
          const parsed = checkDraft(rpmFieldSpec(key, key), draft);
          override = parsed.ok && Number.isFinite(parsed.value) ? parsed.value : 0;
        } else {
          const stored = this.storedValue(key);
          override = Number.isFinite(stored) ? stored : 0;
        }
        if (override > 0) return { value: override, overridden: true };

        const plan = this.planLimits();
        if (key === VIDEO_RPM_KEY) return { value: plan.video, overridden: false };
        for (const tier of TIERS) if (key === rpmKeyFor(tier)) return { value: plan.image[tier], overridden: false };
        return { value: 0, overridden: false };
      }

      /** 覆盖值是否为「跟随预设」（0 或空）。 */
      isFollowingPlan(key) {
        return !this.effectiveRpm(key).overridden;
      }

      /** 草稿是否构成一次真实改动。 */
      get dirty() {
        return this.plan().length > 0 || this.invalidFields().length > 0;
      }

      /** 哪些字段的草稿明显不合法——据此禁用保存按钮并就地报错。 */
      invalidFields() {
        const bad = [];
        for (const [key, draft] of this.drafts) {
          if (CardController.isClear(draft)) continue;
          const field = specFor(key);
          if (!field) continue;
          if (!checkDraft(field, draft).ok) bad.push(key);
        }
        return bad;
      }

      /** 把草稿翻译成 settings 的 path ops。 */
      plan() {
        const ops = [];
        for (const [key, draft] of this.drafts) {
          const field = specFor(key);
          if (!field) continue;

          if (CardController.isClear(draft)) {
            ops.push({ op: "unset", path: [key] });
            continue;
          }

          const raw = String(draft ?? "").trim();
          // 空草稿不提交：对机密字段这是「保留已存值」，对其它字段
          // 这是「用户清空了输入框、还没想好填什么」。
          if (raw === "" && field.kind !== "boolean") continue;

          const parsed = checkDraft(field, draft);
          if (!parsed.ok || parsed.value === undefined) continue;
          if (deepEqualValue(parsed.value, this.storedValue(key))) continue;
          ops.push({ op: "set", path: [key], value: parsed.value });
        }
        return ops;
      }

      /** 字段的可读名字，用于报错文案。 */
      labelOf(key) {
        return specFor(key)?.label ?? key;
      }

      /**
       * 回读核对一次 mutate 是否真的落地（**0.1.6 路径专用**）。
       *
       * **为什么不能靠 try/catch**：0.1.6 的 `scope.mutate()` 即使在 Host 拒绝了
       * 写入（revision 冲突、校验失败）时**也会 resolve**——它内部只是重新
       * 读一次镜像然后正常返回。因此「保存成功」必须靠回读用户层/生效值来
       * 判定，否则界面会对着一次被拒绝的写入报「已保存」。
       *
       * 0.1.7 的 `mutate()` 改为返回 boolean（false = Host 拒绝），那时应该用
       * 更权威的返回值判定，并改用 {@link verifyVisible}——本函数对机密字段的
       * 判定在 0.1.7 下必然为「未生效」，因为机密字段的键与值都不下发。
       *
       * @returns {string[]} 未能生效的字段标签
       */
      verify(ops) {
        const keys = this.userKeys();
        const value = this.read().value;
        const missed = [];
        for (const op of ops) {
          const key = op.path[0];
          const label = this.labelOf(key);
          if (op.op === "unset") {
            // 清除成功 = 用户层里不再有它。本身就没覆盖时也算满足。
            if (keys.has(key)) missed.push(label);
            continue;
          }
          if (SECRET_KEYS.has(key)) {
            // 机密字段的值永远不下发，只能看 Host 报的「用户层键名」。
            if (!keys.has(key)) missed.push(label);
            continue;
          }
          // 其余字段：以**生效值**为准——这正是用户真正关心的东西。
          if (!deepEqualValue(value?.[key], op.value)) missed.push(label);
        }
        return missed;
      }

      /**
       * 回读核对**浏览器看得见**的字段是否落地。
       *
       * 与 {@link verify} 的区别：跳过机密字段。当 `mutate()` 已经返回 `true`
       * （Host 明确接受）时，机密字段没有再核对的余地——它们的值和键都不下发，
       * 回读只会永远说「没看到」，把一次成功的写入误判成失败。
       *
       * 非机密字段仍然核对：`mutate()` 接受不代表所有字段都按预期落地
       * （例如 Host 对值做了规范化）。
       *
       * @returns {string[]} 未能生效的字段标签
       */
      verifyVisible(ops) {
        const value = this.read().value;
        const missed = [];
        for (const op of ops) {
          const key = op.path[0];
          if (op.op === "unset" || SECRET_KEYS.has(key)) continue;
          if (!deepEqualValue(value?.[key], op.value)) missed.push(this.labelOf(key));
        }
        return missed;
      }

      /** 保存：一次 mutate 提交全部草稿，共享同一个 revision 栅栏。 */
      async save() {
        if (this.saving) return;
        // 空操作要在进入 saving 之前就返回，避免闪一下「保存中…」。
        if (this.drafts.size === 0) {
          this.notice = "没有需要保存的改动。";
          this.emit();
          return;
        }
        this.saving = true;
        this.failed = "";
        this.notice = "";
        this.resetArmed = false;
        this.emit();
        try {
          const ops = this.plan();
          if (ops.length === 0) {
            this.drafts.clear();
            this.notice = "没有需要保存的改动。";
            return;
          }
          const accepted = await this.scope.mutate(ops, this.read().revision);
          // 诊断信息必须跟着刷新，两类改动都影响它：
          //   - 机密字段：值不下发，只能靠 Host 回报确认；
          //   - site：它决定 status.key 说的是哪一站的结论（见 TextField 注释）。
          // force：保存后「已配置」标记必须立刻反映最新状态，不能被进行中的
          // 请求挡掉（那会让标记停在保存之前）。
          if (ops.some((op) => SECRET_KEYS.has(op.path[0]) || op.path[0] === "site")) {
            await this.refreshStatus(true);
          }
          // `mutate()` 的返回值是 Host 的**权威答复**：
          //   - 0.1.7 起返回 boolean，false = Host 明确拒绝（revision 冲突 / 校验失败）。
          //     Host 接受时会同步 acceptView，镜像已是最新，无需再猜。
          //   - 0.1.6 返回 undefined，只能回读核对。
          //
          // 为什么不能只看回读：机密字段的值**和键**都被 redactSecrets() 从下发数据
          // 里抹掉，`userKeys()` 对它们永远回答「没有」。于是每次保存 API Key 都会
          // 误报「保存未生效」——写入其实是成功的。
          if (accepted === false) {
            this.failed = `保存未生效：Host 拒绝了这次写入。配置可能已被其它界面修改，请核对后重试。`;
            return;
          }
          const missed = accepted === undefined ? this.verify(ops) : this.verifyVisible(ops);
          if (missed.length === 0) {
            this.drafts.clear();
            this.notice = `已保存 ${ops.length} 项，立即生效。`;
          } else {
            // 回读发现没落地：多半是别的界面先改了配置（revision 冲突）。
            this.failed = `保存未生效：${missed.join("、")}。配置可能已被其它界面修改，请核对后重试。`;
          }
        } catch (err) {
          this.failed = err instanceof Error ? err.message : String(err);
        } finally {
          this.saving = false;
          this.emit();
        }
      }

      /**
       * 一键恢复默认：把用户层里**可恢复的**字段全部清除，让它们重新继承
       * 组合层与 schema 默认值。
       *
       * 实现要点：
       *   - 用**一个** mutate 提交全部 unset，因此是原子的（单次 RPC、
       *     单次 revision 校验、单次持久化）；
       *   - 刻意逐字段 unset，而不用 `{op:'unset', path:[]}` 整节清空——
       *     整节清空会把已存的 API Key 一起抹掉，而用户点这个按钮想要的是
       *     「把设置恢复成默认」，不是「删掉我的密钥」；
       *   - 两段式确认：第一下只进入待确认，第二下才提交；任何编辑都会撤销它。
       */
      async resetAll() {
        if (this.saving) return;
        if (!this.resetArmed) {
          this.resetArmed = true;
          this.notice = "";
          this.failed = "";
          this.emit();
          return;
        }
        this.resetArmed = false;
        // 要清除哪些字段完全取决于用户层的当前内容，因此直读 scope。
        const keys = this.userKeys();
        const ops = RESETTABLE_KEYS.filter((key) => keys.has(key)).map((key) => ({ op: "unset", path: [key] }));
        if (ops.length === 0) {
          this.drafts.clear();
          this.notice = "所有可恢复的设置都已经是默认值。";
          this.emit();
          return;
        }
        this.saving = true;
        this.failed = "";
        this.notice = "";
        this.emit();
        try {
          await this.scope.mutate(ops, this.read().revision);
          const missed = this.verify(ops);
          if (missed.length === 0) {
            this.drafts.clear();
            this.notice = `已恢复默认：清除 ${ops.length} 项覆盖。`;
          } else {
            this.failed = `恢复默认未完全生效：${missed.join("、")}。配置可能已被其它界面修改，请核对后重试。`;
          }
        } catch (err) {
          this.failed = err instanceof Error ? err.message : String(err);
        } finally {
          this.saving = false;
          this.emit();
        }
      }

      discard() {
        this.drafts.clear();
        this.failed = "";
        this.notice = "";
        this.resetArmed = false;
        this.emit();
      }

      /**
       * 拉取 Host 侧诊断：Key 与 ffmpeg 的可用性（不含任何机密明文）。
       *
       * @param {boolean} [force] 忽略"正在加载"的互斥，等当前那次结束后再拉一次。
       *   清除/保存 Key 之后必须用 `force`：诊断里的 `overriddenKeys` 决定
       *   「已配置 / 重置」标记，若这次刷新恰好被进行中的请求挡掉（`statusLoading`
       *   为真时原实现直接 return），`this.status` 会停留在**清除之前**的内容，
       *   界面就一直显示「已配置」——正是用户报告过的现象。
       */
      async refreshStatus(force = false) {
        if (this.statusLoading) {
          if (!force) return;
          // 等前一次结束（它自己会清 statusLoading），再往下走。
          while (this.statusLoading) await new Promise((r) => setTimeout(r, 10));
        }
        this.statusLoading = true;
        this.statusError = "";
        this.emit();
        try {
          const res = await fetch(STATUS_PATH, { headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.status = await res.json();
        } catch (err) {
          this.status = null;
          this.statusError = err instanceof Error ? err.message : String(err);
        } finally {
          this.statusLoading = false;
          this.emit();
        }
      }

      /**
       * 校验 Key 并拉取模型清单（调 Host 的 /check 路由 → GET /v1/models）。
       * 成功时把拉到的 image/video 模型合并进对应清单草稿（保留用户自定义项）。
       */
      async checkKey() {
        if (this.checkLoading) return;
        this.checkLoading = true;
        this.checkError = "";
        this.checkResult = null;
        this.emit();
        try {
          // 用「表单当前选中的站点 + 该站的 Key（含未保存的草稿）」去校验。
          // 只提交当前站的那一个 key 字段，避免把另一站的 key 也带过去。
          const site = this.currentSite();
          const keyField = KEY_FIELDS.find((f) => f.site === site);
          const keyFieldName = keyField ? keyField.key : "apiKeyCn";
          const keyDraft = this.drafts.get(keyFieldName);
          const key =
            typeof keyDraft === "string" && !CardController.isClear(keyDraft)
              ? keyDraft.trim()
              : typeof this.storedValue(keyFieldName) === "string"
                ? this.storedValue(keyFieldName)
                : "";
          const res = await fetch(CHECK_PATH, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ site, key }),
          });
          const data = res.ok ? await res.json() : { ok: false, error: `HTTP ${res.status}` };
          this.checkResult = data;
          if (res.ok && data.ok && !this.saving) {
            const suf = site === "intl" ? "Intl" : "Cn";
            const merge = (setKey, selKey, incoming) => {
              if (!Array.isArray(incoming) || !incoming.length) return;
              const current = Array.isArray(this.storedValue(setKey)) ? this.storedValue(setKey) : [];
              const combined = [...new Set([...current, ...incoming])];
              this.edit(setKey, combined.join(", "));
              // 尚未选生效模型时，自动选中拉到的第一个。
              const existing = this.storedValue(selKey);
              if (!existing) this.edit(selKey, combined[0]);
            };
            merge(`imageModels${suf}`, `imageModel${suf}`, data.imageModels);
            merge(`videoModels${suf}`, `videoModel${suf}`, data.videoModels);
          }
        } catch (err) {
          this.checkResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
          this.checkLoading = false;
          this.emit();
        }
      }
    }

    // ---------------- 控件 ----------------

    function FieldShell({ field, overridden, disabled, invalid, onReset, children, message }) {
      return h(
        "div",
        { className: "agn-field" },
        h(
          "div",
          { className: "agn-head" },
          h("label", { className: "agn-label", htmlFor: `agn-${field.key}` }, field.label),
          overridden
            ? h(
                "span",
                { className: "agn-badges" },
                h("span", { className: "agn-tag" }, "已覆盖"),
                h(
                  "button",
                  { type: "button", className: "agn-reset", disabled, onClick: onReset },
                  field.kind === "secret" ? "清除已配置的 Key" : "重置",
                ),
              )
            : null,
        ),
        children,
        message
          ? h("p", { className: invalid ? "agn-invalid" : "agn-desc" }, message)
          : field.desc
            ? h("p", { className: "agn-desc" }, field.desc)
            : null,
      );
    }

    function TextField({ field, controller, disabled, overridden }) {
      const text = controller.textOf(field);
      const check = checkDraft(field, text);
      const invalid = !check.ok;
      // 占位提示用出厂默认值。机密字段没有默认值可提示，用「已配置」指示状态。
      const def = controller.defaultFor(field.key);

      /**
       * 机密字段的占位文案。
       *
       * 只有**当前站点**的经验值能靠 Host 的 `status.key` 判断（综合了显式配置
       * 与凭据文件——**不含环境变量**，见 lib/client.js）。`status.key` 是
       * **上次检测时那个站点**的结论，而用户可能刚改了站点草稿、还没保存——此时
       * 两者不同站，若仍采信会把另一站的「已配置」误显示成当前站的。所以只有在
       * 状态站点与该字段所属站点一致时才用 `status.key`，否则只认用户层键名
       * （`overridden`）。
       *
       * 对开源使用者而言，凭据文件通常是**不存在的**，因此留空时的文案
       * 只提示「在此填写」，把它当作唯一的正路。
       */
      const fieldSite = siteForKey(field.key);
      const statusSite = controller.status?.site ?? controller.storedValue("site") ?? "cn";
      const statusMatches = fieldSite === undefined || statusSite === (fieldSite ?? controller.currentSite());
      const knownConfigured = overridden || (statusMatches && controller.status?.key?.set === true);
      const secretPlaceholder = knownConfigured ? "已配置（留空则保留）" : "在此填写";

      const placeholder =
        field.kind === "secret"
          ? secretPlaceholder
          : def
            ? `默认：${def}`
            : field.placeholder ?? "";

      return h(
        FieldShell,
        {
          field,
          overridden,
          disabled,
          invalid,
          onReset: () =>
            field.kind === "secret"
              ? controller.clearKey(field.key, field.label)
              : controller.resetField(field.key),
          message: invalid ? check.message : "",
        },
        h("input", {
          id: `agn-${field.key}`,
          className: "agn-input",
          type: field.kind === "secret" ? "password" : "text",
          autoComplete: field.kind === "secret" ? "off" : "on",
          inputMode: field.kind === "number" ? "numeric" : undefined,
          "aria-invalid": invalid || undefined,
          placeholder,
          value: text,
          disabled,
          onChange: (event) => controller.edit(field.key, event.target.value),
        }),
      );
    }

    function BooleanField({ field, controller, disabled, overridden }) {
      // 重置标记会让 textOf() 返回空串，这里显式区分「已重置」与「值为 false」。
      const draft = controller.drafts.get(field.key);
      const cleared = draft !== undefined && CardController.isClear(draft);
      const current = cleared ? false : controller.textOf(field) === "true";
      return h(
        FieldShell,
        { field, overridden, disabled, invalid: false, onReset: () => controller.resetField(field.key) },
        h(
          "label",
          { className: "agn-check" },
          h("input", {
            id: `agn-${field.key}`,
            type: "checkbox",
            checked: current,
            disabled,
            onChange: (event) => controller.edit(field.key, event.target.checked ? "true" : "false"),
          }),
          h("span", null, current ? "已启用" : "已关闭"),
        ),
      );
    }

    /** 诊断结果面板：Key 与 ffmpeg 的可用性。 */
    function StatusPanel({ controller, disabled }) {
      const { status, statusLoading, statusError } = controller;
      const lines = [];
      if (statusError) {
        lines.push(`检测失败：${statusError}（Host 是否已重启？该路由由插件注册。）`);
      } else if (status) {
        const key = status.key ?? {};
        lines.push(key.set ? "API Key：已配置" : "API Key：未配置");
        const ff = status.ffmpeg ?? {};
        if (ff.ok) {
          lines.push(`ffmpeg：可用（${ff.path}${ff.version ? "，" + ff.version : ""}，来源：${ff.source}）`);
        } else {
          lines.push(`ffmpeg：不可用 — ${ff.error || "未知原因"}`);
        }
        if (ff.error && ff.ok) lines.push(`注意：${ff.error}`);
        if (ff.hint) lines.push(ff.hint);

        // Host 报的是**实际生效**的限流值，与上面表单里的计算同源；
        // 两处若不一致，就是保存还没落地或表单里有未保存的草稿。
        const image = status.imageRpm ?? {};
        if (typeof image === "object") {
          lines.push(
            `Host 当前生效：档位 ${status.planLabel ?? status.plan ?? "?"}，` +
              `图片 ${Object.entries(image)
                .map(([tier, rpm]) => `${tier}=${rpm}`)
                .join(" ")}，视频 ${status.videoRpm} RPM`,
          );
        }
      } else if (!statusLoading) {
        lines.push("尚未检测。");
      }
      return h(
        "div",
        { className: "agn-field" },
        h(
          "div",
          { className: "agn-head" },
          h("span", { className: "agn-label" }, "环境检测"),
          h(
            "button",
            {
              type: "button",
              className: "agn-ghost",
              disabled: disabled || statusLoading,
              onClick: () => controller.refreshStatus(),
            },
            statusLoading ? "检测中…" : "检测 Key 与 ffmpeg",
          ),
        ),
        statusLoading && !status ? null : h("p", { className: "agn-probe" }, lines.join("\n")),
      );
    }

    // ---------------- RPM 分组控件 ----------------

    /**
     * 站点选择器 + 对应那一站的 Key 输入框。
     *
     * 两站 Key 不通用，所以**只显示当前选中那一站的 Key 框**：用户选「中国站」
     * 就看到 apiKeyCn，选「国际站」就看到 apiKeyIntl。切站点是不丢另一站的
     * 已存值的——两个值都存在 settings 里，只是界面上一次显示一个。
     *
     * 提示文案刻意不把「凭据文件 / 环境变量」当成新手路径：AGNES_CN_API_KEY 这类
     * 变量是作者本人才会有，开源使用者通常没有。所以留空时的说明只说「在此填写」。
     */
    /** 当前站点的模型集/选中项键名。 */
    function modelKeys(site, type) {
      const suf = site === "intl" ? "Intl" : "Cn";
      const stem = type === "video" ? "videoModel" : "imageModel";
      return { setKey: `${type === "video" ? "videoModels" : "imageModels"}${suf}`, selKey: `${stem}${suf}` };
    }

    /**
     * 单个模型下拉：可选集（该站）为选项，另加「自定义…」。
     * 选中项（selKey）即生效模型；选中不在可选集时进入自定义模式，可输入任意 ID。
     */
    function ModelField({ controller, label, type, disabled }) {
      const site = controller.currentSite();
      const { selKey } = modelKeys(site, type);
      // 可选集：草稿若已改用草稿，否则用已存值。
      const setKey = modelKeys(site, type).setKey;
      const setDraft = controller.drafts.get(setKey);
      let setList;
      if (CardController.isClear(setDraft)) setList = [];
      else if (typeof setDraft === "string") {
        setList = setDraft.split(/[\s,，\n]+/).map((s) => s.trim()).filter(Boolean);
      } else if (Array.isArray(setDraft)) setList = setDraft;
      else {
        const v = controller.storedValue(setKey);
        setList = Array.isArray(v) ? v : [];
      }
      setList = [...new Set(setList)];

      // 选中项：草稿优先，其次已存值（含为空时回落内置默认的解析值）。
      const selDraft = controller.drafts.get(selKey);
      let selected;
      if (CardController.isClear(selDraft)) selected = "";
      else if (typeof selDraft === "string") selected = selDraft.trim();
      else selected = typeof controller.storedValue(selKey) === "string" ? controller.storedValue(selKey) : "";

      const custom = "_custom_";
      const inList = Boolean(selected) && setList.includes(selected);
      const customMode = controller.isCustom(selKey) || (!selected && !inList);
      const options = selected && !setList.includes(selected) && selected !== custom ? [selected, ...setList] : setList;

      const onSelect = (value) => {
        if (value === custom) {
          controller.setCustom(selKey);
          controller.edit(selKey, selected || "");
        } else {
          controller.clearCustom(selKey);
          controller.edit(selKey, value);
        }
      };

      return h(
        "div",
        { className: "agn-field" },
        h(
          "div",
          { className: "agn-head" },
          h("label", { className: "agn-label", htmlFor: `agn-${selKey}` }, label),
        ),
        h(
          "select",
          {
            id: `agn-${selKey}`,
            className: "agn-select",
            value: customMode && !inList ? custom : selected || "",
            disabled,
            onChange: (e) => onSelect(e.target.value),
          },
          ...options.map((o, i) => h("option", { key: `${i}-${o}`, value: o }, o)),
          h("option", { key: custom, value: custom }, "自定义…"),
        ),
        customMode && selected !== custom
          ? h("input", {
              id: `agn-${selKey}-custom`,
              className: "agn-input agn-modelCustom",
              type: "text",
              placeholder: "自定义模型 ID…（工具允许可选集内任意值，默认用此选中项）",
              value: selected,
              disabled,
              onChange: (e) => controller.edit(selKey, e.target.value),
            })
          : null,
        h("p", { className: "agn-desc" }, `该站的${label}（下方选中项即生效模型；工具允许下拉可选集内任意值）。`),
      );
    }

    /** 站点区底部：图像/视频模型下拉 + 「校验 Key & 拉取模型」按钮。 */
    function ModelSection({ controller, disabled }) {
      const check = controller.checkResult;
      return h(
        "div",
        { className: "agn-field" },
        h(ModelField, { controller, label: "图像模型", type: "image", disabled }),
        h(ModelField, { controller, label: "视频模型", type: "video", disabled }),
        h(
          "button",
          {
            type: "button",
            className: "agn-ghost agn-modelCheck",
            disabled: disabled || controller.checkLoading,
            onClick: () => controller.checkKey(),
          },
          controller.checkLoading ? "校验中…" : "校验 Key & 拉取模型",
        ),
        check
          ? h(
              "p",
              { className: check.ok ? "agn-probe" : "agn-invalid" },
              check.ok
                ? `Key 有效 ✓ — 已并入当前站模型集（图像 ${check.imageModels?.length ?? 0} 个、视频 ${check.videoModels?.length ?? 0} 个）。`
                : `Key 无效 — ${check.error || "未知原因"}`,
            )
          : null,
      );
    }

    function SiteField({ controller, disabled }) {
      const site = controller.currentSite();
      const data = SITES[site] ?? SITES.cn;
      const siteOverridden = controller.isOverridden("site");
      const keyField = KEY_FIELDS.find((f) => f.site === site) ?? KEY_FIELDS[0];
      const overridden = controller.isOverridden(keyField.key);

      /**
       * 当前站 Key 的占位文案。
       * `status.key` 是上次检测时那个站点的结论；切到另一站（未保存）时
       * 站点来源不一致，只能靠用户层键名判断，因此对未保存的站只说「在此填写」。
       */
      const statusSite = controller.status?.site ?? controller.storedValue("site") ?? "cn";
      const statusMatches = statusSite === site;
      const configured =
        overridden || (statusMatches && controller.status?.key?.set === true);
      const placeholder = configured ? "已配置（留空则保留）" : "在此填写";

      return h(
        "div",
        { className: "agn-field" },
        h(
          "div",
          { className: "agn-head" },
          h("label", { className: "agn-label", htmlFor: "agn-site" }, "Agnes 站点"),
          siteOverridden
            ? h(
                "span",
                { className: "agn-badges" },
                h("span", { className: "agn-tag" }, "已覆盖"),
                h(
                  "button",
                  { type: "button", className: "agn-reset", disabled, onClick: () => controller.resetField("site") },
                  "重置",
                ),
              )
            : null,
        ),
        h(
          "select",
          {
            id: "agn-site",
            className: "agn-select",
            value: site,
            disabled,
            onChange: (event) => controller.edit("site", event.target.value),
          },
          ...SITE_VALUES.map((value) => h("option", { key: value, value }, SITES[value].label)),
        ),
        h(
          "p",
          { className: "agn-desc" },
          `请求发往 ${data.base}。密钥获取：${data.consoleUrl}。` +
            "两站的 Key **不通用**，必须选你注册的那一站；选错会得到 401。",
        ),
        // 只渲染当前站点的那一个 Key 输入框。
        h(TextField, {
          key: keyField.key,
          field: keyField,
          controller,
          disabled,
          overridden,
        }),
        h(ModelSection, { controller, disabled }),
      );
    }

    /**
     * 预设选择器 + 逐档位覆盖。
     *
     * 这一组是本插件配置里语义最绕的地方，所以单独成一个控件：
     *   - 预设决定基线（免费 / Token Plan），对应 Agnes 公布的档位；
     *   - 每个档位可以单独覆盖，0 = 跟随预设；
     *   - 每个档位旁边显示**实际生效**的数值，用户不用自己心算。
     *
     * 关键提示：3K / 4K 在两种预设下都只有 1 RPM。统一填一个大数字会
     * 让这些档位必然撞 429，所以界面上直接把实际值摆出来。
     */
    function RpmGroup({ controller, disabled }) {
      const plan = controller.currentPlan();
      const planData = planLimits(plan);
      const planOverridden = controller.isOverridden("plan");

      /** 一行：标签 + 覆盖输入 + 实际生效值。 */
      const tierRow = (key, label, planValue, hint) => {
        const overridden = controller.isOverridden(key);
        const text = controller.textOf(rpmFieldSpec(key, label));
        const spec = rpmFieldSpec(key, label);
        const check = checkDraft(spec, text);
        const invalid = !check.ok;
        const effective = controller.effectiveRpm(key);
        return h(
          "div",
          { className: "agn-rpmRow", key },
          h(
            "div",
            { className: "agn-rpmLabel" },
            h("span", { className: "agn-rpmName" }, label),
            h(
              "span",
              { className: "agn-rpmPlanValue" },
              effective.overridden ? `预设 ${planValue} → 覆盖为 ${effective.value}` : `跟随预设：${effective.value}`,
            ),
          ),
          h("input", {
            className: "agn-input agn-rpmInput",
            type: "text",
            inputMode: "numeric",
            "aria-label": `${label} 的 RPM 覆盖值，0 表示跟随预设`,
            "aria-invalid": invalid || undefined,
            placeholder: "0",
            value: text,
            disabled,
            onChange: (event) => controller.edit(key, event.target.value),
          }),
          overridden
            ? h(
                "button",
                {
                  type: "button",
                  className: "agn-reset agn-rpmReset",
                  disabled,
                  onClick: () => controller.resetField(key),
                  title: "清除覆盖，回到跟随预设",
                },
                "重置",
              )
            : h("span", { className: "agn-rpmSpacer", "aria-hidden": "true" }),
          invalid ? h("p", { className: "agn-invalid agn-rpmError" }, check.message) : hint ? h("p", { className: "agn-desc agn-rpmHint" }, hint) : null,
        );
      };

      return h(
        "div",
        { className: "agn-field" },
        h(
          "div",
          { className: "agn-head" },
          h("label", { className: "agn-label", htmlFor: "agn-plan" }, "密钥档位预设"),
          planOverridden
            ? h(
                "span",
                { className: "agn-badges" },
                h("span", { className: "agn-tag" }, "已覆盖"),
                h("button", { type: "button", className: "agn-reset", disabled, onClick: () => controller.resetField("plan") }, "重置"),
              )
            : null,
        ),
        h(
          "select",
          {
            id: "agn-plan",
            className: "agn-select",
            value: plan,
            disabled,
            onChange: (event) => controller.edit("plan", event.target.value),
          },
          ...PLAN_VALUES.map((value) => h("option", { key: value, value }, PLANS[value].label)),
        ),
        h(
          "p",
          { className: "agn-desc" },
          `${planData.label}的公开参考上限：1K=${planData.image["1K"]} / 2K=${planData.image["2K"]} / 3K=${planData.image["3K"]} / 4K=${planData.image["4K"]}，视频 ${planData.video} RPM。这些是 Agnes 的公开参考值，官方可能调整；可在控制台 Usage 页核对实际用量。`,
        ),
        h(
          "p",
          { className: "agn-desc" },
          "下面是逐档位覆盖。留 0 或清空即跟随预设；3K / 4K 在所有档位下都只有 1 RPM。",
        ),

        tierRow(rpmKeyFor("1K"), "图像 1K", planData.image["1K"]),
        tierRow(rpmKeyFor("2K"), "图像 2K", planData.image["2K"]),
        tierRow(rpmKeyFor("3K"), "图像 3K", planData.image["3K"], "3K 对所有档位都只有 1 RPM，批量任务请用 1K / 2K。"),
        tierRow(rpmKeyFor("4K"), "图像 4K", planData.image["4K"], "4K 对所有档位都只有 1 RPM，批量任务请用 1K / 2K。"),
        tierRow(VIDEO_RPM_KEY, "视频", planData.video, "创建任务与轮询共用这一个池：同一个视频从创建到完成会持续占用它。"),
      );
    }

    // ---------------- 卡片 ----------------

    /** 视图：`summary` 只给一句话，`page` 给完整表单。 */
    function AgnesConfigCard(props) {
      const { view } = props;
      const controller = props.controller;
      const [, force] = React.useState(0);
      const [probed, setProbed] = React.useState(false);

      React.useEffect(() => {
        const off = controller.subscribe(() => force((n) => n + 1));
        return () => {
          off();
          // 离开页面丢弃暂存——与随附插件的既有约定一致。
          controller.discard();
        };
      }, [controller]);

      // 首次渲染后自动探测一次，省去用户点击。
      React.useEffect(() => {
        if (view !== "page" || probed) return;
        setProbed(true);
        controller.refreshStatus();
      }, [view, probed, controller]);

      if (view === "summary") {
        return h(
          "span",
          null,
          controller.hasResettableOverrides()
            ? "配置 API Key、RPM 上限与 ffmpeg 路径（有已覆盖的设置，可一键恢复默认）。"
            : "配置 API Key、RPM 上限与 ffmpeg 路径。",
        );
      }

      const snapshot = controller.read();
      const unavailable = snapshot.status === "unavailable";
      if (unavailable) {
        return h(
          "div",
          { className: "agn-card" },
          h(
            "p",
            { className: "agn-notice" },
            `Host 没有在服务设置命名空间「${SETTINGS_NS}」。这通常意味着插件的 Host 半侧未加载，或该部署没有挂载 settings provider（例如 @deepseek-ai/dsh-settings-file）。改动不会生效。`,
          ),
        );
      }
      if (snapshot.status === "loading" && snapshot.value === undefined) {
        return h("p", { className: "agn-hint" }, "正在读取配置…");
      }

      const writable = snapshot.writable !== false;
      const disabled = !writable || controller.saving;
      const invalid = controller.invalidFields().length > 0;

      return h(
        "div",
        { className: "agn-card" },
        !writable
          ? h("p", { className: "agn-notice" }, "当前部署的设置存储是只读的，改动无法保存。")
          : null,

        h(SiteField, { controller, disabled }),

        ...FIELDS.map((field) =>
          // 模型字段在 SiteField 里以下拉渲染，这里跳过，避免重复出现成文本框。
          field.kind === "model"
            ? null
            : field.kind === "boolean"
              ? h(BooleanField, { key: field.key, field, controller, disabled, overridden: controller.isOverridden(field.key) })
              : h(TextField, { key: field.key, field, controller, disabled, overridden: controller.isOverridden(field.key) }),
        ),

        h(RpmGroup, { controller, disabled }),

        h(StatusPanel, { controller, disabled }),

        h(
          "div",
          { className: "agn-footer" },
          h(
            "button",
            {
              type: "button",
              className: "agn-save",
              disabled: disabled || !controller.dirty || invalid,
              onClick: () => controller.save(),
            },
            controller.saving ? "保存中…" : "保存",
          ),
          h(
            "button",
            {
              type: "button",
              className: "agn-ghost",
              disabled: disabled || !controller.dirty,
              onClick: () => controller.discard(),
            },
            "放弃修改",
          ),
          // 一键恢复默认：两段式确认。第一次点击变成「确认恢复」，避免误触；
          // 任何编辑都会撤销这个待确认状态（见 edit()）。
          h(
            "button",
            {
              type: "button",
              className: controller.resetArmed ? "agn-danger" : "agn-ghost",
              disabled: disabled || (!controller.resetArmed && !controller.hasResettableOverrides()),
              onClick: () => controller.resetAll(),
            },
            controller.resetArmed ? "确认恢复默认？" : "恢复默认",
          ),
          controller.failed
            ? h("p", { className: "agn-status", "data-tone": "error", role: "status" }, controller.failed)
            : controller.notice
              ? h("p", { className: "agn-status", "data-tone": "ok", role: "status" }, controller.notice)
              : controller.resetArmed
                ? h("p", { className: "agn-status", role: "status" }, "将清除上面所有已覆盖的字段（API Key 不受影响），恢复为出厂默认值。")
                : h("p", { className: "agn-status", role: "status" }, controller.dirty ? "有未保存的修改。" : ""),
        ),
      );
    }

    // ---------------- 插件入口 ----------------

    /**
     * 需要的浏览器服务：**只有** slot 注册表。
     *
     * `settingsScope` **绝不能**放进这个数组。它是 0.1.6 独有的服务，而
     * Loader 会把「声明了却拿不到」的服务当成激活依赖——0.1.7 上根本没有
     * `settingsScope`，于是插件一直 pending，web boot 直接报
     * `Failed to load plugins: 1 entry did not activate`（实测）。
     * 因此这里只声明两版都有的 `slots`，`settingsScope` 走下方 `ctx.get()`
     * 的可选查找。
     */
    const inject = ["slots"];

    /**
     * 注册配置卡。
     *
     * 整个函数体包在 try/catch 里：任何一处 API 漂移都不该让 Web 页面挂上
     * 「Failed to load plugins」红条。Host 侧的工具完全不受影响。
     */
    function apply(ctx) {
      try {
        // 取「配置读写面」。CardController 只依赖 getSnapshot/subscribe/mutate
        // 三个方法，以及快照的 status/value/user/base/revision/writable/mode
        // 字段——0.1.6 的 settingsScope.bind() 产物与 0.1.7 的 ConfigForm
        // 快照**字段完全一致**，所以卡片本体不用改，只换这个对象的来源。
        //
        // 两个版本都不能用 `inject` 声明来拿（0.1.7 会把拿不到的已声明服务
        // 当激活依赖 → 永久 pending → "Failed to load plugins"），统一走
        // ctx.get() 可选查找：不要求声明，缺席返回 undefined。
        const probe = (name) => (typeof ctx.get === "function" ? ctx.get(name) : undefined);
        const configForms = probe("configForms");
        const settingsScope = probe("settingsScope");

        let scope = null;
        // 0.1.7：configForms.get(entryId)。entryId 是插件在 profile 里的条目
        // id，实测（--dump-config-schema）为 "agnes-gen"；包名也一并试，防止
        // 上游改用它做键。
        if (configForms && typeof configForms.get === "function") {
          for (const entryId of ["agnes-gen", "dsh-agnes-gen"]) {
            const form = configForms.get(entryId);
            if (form && typeof form.getSnapshot === "function") {
              scope = form;
              break;
            }
          }
        }
        // 0.1.6：settingsScope.bind({ namespace })。
        if (!scope && settingsScope && typeof settingsScope.bind === "function") {
          scope = settingsScope.bind({ namespace: SETTINGS_NS });
        }
        // 两版都拿不到配置面时不注册卡（Host 侧工具不受影响）。
        if (!scope) return;

        installStyles();
        const controller = new CardController(scope);
        ctx.effect(() => () => controller.dispose(), "dsh-agnes-gen: card controller");

        // slot key 是**包名**：插件页按这个键把表单画在组合包页面上，
        // 位置在描述与组件行之间。
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            { name: "plugins.bundle.config", key: "dsh-agnes-gen" },
            (props) => h(AgnesConfigCard, { ...props, controller }),
          ),
        );
      } catch (error) {
        console.error("[dsh-agnes-gen] 配置卡注册失败（Host 侧不受影响）：", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
