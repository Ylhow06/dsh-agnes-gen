/**
 * 并发布局回归测试：验证 `isConcurrencySafe` 分类器经 `defineTool` 之后仍然
 * 可用，并复刻 DSH 的 `executionMode()` 判定逻辑，确认各调用最终被正确归类为
 * `parallel` 或 `exclusive`。
 *
 * 为什么需要它：DSH 的调度器是 **fail-closed** 的——只有分类器返回严格 `true`
 * 才并行，未声明 / 抛错 / 参数非法一律独占。而 `defineTool` 会在参数校验失败时
 * 主动把分类器结果改成 `false`。这条链路任何一环断掉，都会静默退回串行，
 * 表面看不出任何异常，所以需要一条能在本地直接跑的断言。
 *
 * 用法：node scripts/verify-concurrency.mjs
 *
 * 注意：这里复刻的是 index.js 里两个分类器的**逻辑**（而非直接 import，
 * 因为 index.js 的 apply() 需要完整的 Cordis ctx）。改动分类器时两边要一起改。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

// 直接复刻 index.js 里两个工具的分类器，验证它们在真实 defineTool 下的行为。
const probes = [
  {
    label: "agnes_image 1K",
    args: { prompt: "x", size: "1K" },
    isConcurrencySafe: (a) => {
      const tier = String(a?.size ?? "1K").toUpperCase();
      if (tier === "3K" || tier === "4K") return false;
      return true;
    },
  },
  {
    label: "agnes_image 不传 size（默认 1K）",
    args: { prompt: "x" },
    isConcurrencySafe: (a) => {
      const tier = String(a?.size ?? "1K").toUpperCase();
      if (tier === "3K" || tier === "4K") return false;
      return true;
    },
  },
  {
    label: "agnes_image 3K",
    args: { prompt: "x", size: "3K" },
    isConcurrencySafe: (a) => {
      const tier = String(a?.size ?? "1K").toUpperCase();
      if (tier === "3K" || tier === "4K") return false;
      return true;
    },
  },
  {
    label: "agnes_image 非法 size（校验应拦下）",
    args: { prompt: "x", size: "999K" },
    isConcurrencySafe: (a) => {
      const tier = String(a?.size ?? "1K").toUpperCase();
      if (tier === "3K" || tier === "4K") return false;
      return true;
    },
  },
  { label: "agnes_video", args: { prompt: "x" }, isConcurrencySafe: () => false },
];

/** 复刻 dsh-tools 的 executionMode()（fail-closed）。 */
function executionMode(tool, args) {
  if (!tool?.isConcurrencySafe) return { kind: "exclusive", why: "未声明 isConcurrencySafe" };
  try {
    const safe = tool.isConcurrencySafe(args);
    return safe === true
      ? { kind: "parallel", why: "分类器返回严格 true" }
      : { kind: "exclusive", why: `分类器返回 ${JSON.stringify(safe)}` };
  } catch (e) {
    return { kind: "exclusive", why: `分类器抛错: ${e.message}` };
  }
}

let fail = 0;
for (const p of probes) {
  const tool = defineTool({
    name: "probe",
    description: "probe",
    parameters: { prompt: { type: "string", required: true }, size: { type: "string", enum: ["1K", "2K", "3K", "4K"] } },
    output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } }, render: () => [] },
    isConcurrencySafe: p.isConcurrencySafe,
    async execute() {
      return { ok: true };
    },
  });

  const mode = executionMode(tool, p.args);
  const unexpected = p.label.includes("非法") && mode.why.startsWith("分类器返回");
  const icon = mode.kind === "parallel" ? "PARALLEL  " : "exclusive ";
  console.log(`${icon} ${p.label.padEnd(28)} → ${mode.why}${unexpected ? "   <-- 注意：校验未拦下" : ""}`);
  if (p.label.startsWith("agnes_image 1K") && mode.kind !== "parallel") fail++;
  if (p.label.includes("不传 size") && mode.kind !== "parallel") fail++;
  if (p.label.includes("3K") && mode.kind !== "exclusive") fail++;
  if (p.label.includes("agnes_video") && mode.kind !== "exclusive") fail++;
}

console.log("");
if (fail) {
  console.error(`✗ ${fail} 项不符合预期`);
  process.exit(1);
}
console.log("✓ 分类器行为全部符合预期");
console.log("  - agnes_image 1K/2K → parallel（获得并行）");
console.log("  - agnes_image 3K/4K → exclusive（1 RPM，排队）");
console.log("  - agnes_video       → exclusive（1 RPM + 轮询抢配额）");
