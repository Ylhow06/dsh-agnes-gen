/**
 * 受控实测：隔离 DSH 调度层，只测 generateImage + 限流池的真实吞吐。
 *
 * 目的：分清「串行慢」到底来自
 *   (a) DSH 调度器 exclusive 排队 —— 靠工具声明 `isConcurrencySafe` 解决
 *   (b) 自家 rate-limit 池排队    —— 靠调大 RPM / 关限流解决
 *
 * 实测基线（4 张 1K / 单张约 11–14s）：
 *   serial   约 48.5s（4 × 11–14s，线性累加）
 *   parallel 约 15.6s（请求重叠，限流池 10 RPM 未成为瓶颈）
 *
 * 用法：
 *   node scripts/stress-parallel.mjs serial 4
 *   node scripts/stress-parallel.mjs parallel 4
 *
 * 环境：
 *   AGNES_API_KEY_OVERRIDE  必填，API Key
 *   AGNES_SITE              可选，cn（默认）/ intl
 *   AGNES_RATELIMIT_DIR     可选，限流状态目录；测吞吐时建议指到独立目录，
 *                           避免污染日常使用的窗口计数
 *
 * 注意：会真实消耗额度与时间。
 */

import path from "node:path";
import { SITES, generateImage } from "../lib/client.js";
import { defaultConfig, effectiveLimits } from "../lib/config-schema.js";

const mode = process.argv[2] ?? "serial";
const count = Number(process.argv[3] ?? 4);
const siteKey = process.env.AGNES_SITE ?? "cn";
const site = SITES[siteKey] ?? SITES.cn;

const key = process.env.AGNES_API_KEY_OVERRIDE;
if (!key) {
  console.error("缺少 AGNES_API_KEY_OVERRIDE");
  process.exit(2);
}

const cfg = defaultConfig();
const limits = effectiveLimits({ ...cfg, site: "intl" });
const outDir = path.resolve("out", `stress-${mode}`);

console.log(`模式=${mode} 数量=${count}`);
console.log(`限流: 图片池 ${JSON.stringify(limits.image)}  档位=1K  池上限=${limits.image["1K"]} RPM`);
console.log(`状态目录=${process.env.AGNES_RATELIMIT_DIR || "(默认 tmpdir)"}`);
console.log("");

const prompts = Array.from({ length: count }, (_, i) => `a simple red circle on white background, test ${i + 1}`);

/** 每个任务记录：开始、拿到额度后发出请求、结束 */
async function one(i) {
  const t0 = Date.now();
  const timeline = [];
  const res = await generateImage({
    prompt: prompts[i],
    model: "agnes-image-2.5-flash",
    size: "1K",
    site,
    key,
    outDir,
    cwd: process.cwd(),
    limits,
    rateLimit: true,
    log: (m) => timeline.push({ t: Date.now() - t0, msg: m }),
  });
  const file = res.files[0] ?? "(none)";
  return { i, ms: Date.now() - t0, file, timeline };
}

const t0 = Date.now();
const results =
  mode === "parallel"
    ? await Promise.all(prompts.map((_, i) => one(i).catch((e) => ({ i, error: e.message, ms: Date.now() - t0 }))))
    : await (async () => {
        const out = [];
        for (let i = 0; i < prompts.length; i++) out.push(await one(i).catch((e) => ({ i, error: e.message, ms: Date.now() - t0 })));
        return out;
      })();
const total = Date.now() - t0;

console.log("=".repeat(70));
for (const r of results.sort((a, b) => a.i - b.i)) {
  if (r.error) console.log(`#${r.i}  ✗ ${(r.ms / 1000).toFixed(1)}s  ${r.error.slice(0, 90)}`);
  else console.log(`#${r.i}  ✓ ${(r.ms / 1000).toFixed(1)}s  ${path.basename(r.file)}`);
}
console.log("=".repeat(70));
console.log(`总耗时 ${(total / 1000).toFixed(1)}s  成功 ${results.filter((r) => !r.error).length}/${count}`);
if (results[0]?.timeline?.length) {
  console.log(`\n#0 的进度日志（相对秒）：`);
  for (const e of results[0].timeline) console.log(`  ${(e.t / 1000).toFixed(1)}s  ${e.msg}`);
}
