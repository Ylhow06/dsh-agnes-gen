/**
 * 离线自检：确认插件在任何 workspace 里都能被装进 profile。
 *
 * 跑法：
 *   node dsh-agnes-gen/selfcheck.mjs
 *
 * 检查七件事：
 *   1) 依赖只用 node: 内置、相对路径与**声明过的** @deepseek-ai/* 第一方包；
 *   2) 插件与 manifest 的静态形状正确（含发行用的元数据）；
 *   3) 两个工具定义能通过真实 defineTool 的形状与参数校验；
 *   4) settings schema（真实 Schemastery）能生成合法信封，机密字段被正确标记；
 *   5) 默认配置只有一份来源，且可一键恢复默认；
 *   6) 浏览器半侧是可加载的 lazy-CJS bundle，slot 键与包名一致；
 *   7) 诊断路由的鉴权、方法与响应形状。
 *
 * 第 1 条现在**允许** bare import：从 npm 安装的插件在 profile 里是真实目录，
 * Node 的祖先目录查找能命中 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。
 * 但未在 `peerDependencies` 里声明的包必须报错——那才是别人装不上的原因。
 *
 * 注意：浏览器半侧（lib/client-bundle.js）**不参与**第 1 条扫描——
 * 它的 `require(...)` 由浏览器模块表解析，不经 Node 解析器。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? "  " + extra : ""}`);
  }
};

/** 浏览器半侧的入口，不参与 Node 侧 import 扫描。 */
const CLIENT_BUNDLE = path.join(root, "lib", "client-bundle.js");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// ---- 1. import 卫生 ----
// 允许：node: 内置、相对路径、以及 peerDependencies 里声明过的第一方包。
// 声明过的才允许，是因为「能 import」和「别人装上能 import」是两件事：
// 本机 ancestors 里恰好有这个包，不代表 npm 安装时会有。
const pkgForDeps = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declaredDeps = new Set([
  ...Object.keys(pkgForDeps.peerDependencies ?? {}),
  ...Object.keys(pkgForDeps.dependencies ?? {}),
  ...Object.keys(pkgForDeps.devDependencies ?? {}),
]);

const files = walk(root);
const hostFiles = files.filter((f) => f !== CLIENT_BUNDLE);
const offenders = [];
const undeclared = [];
for (const file of hostFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)) {
    const spec = m[1];
    const isRelative = spec.startsWith("./") || spec.startsWith("../");
    const isBuiltin = spec.startsWith("node:");
    if (isRelative || isBuiltin) continue;
    // 取包名：@scope/name → @scope/name；name/sub → name
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!declaredDeps.has(pkgName)) undeclared.push(`${path.relative(root, file)} -> ${spec}`);
    offenders.push(`${path.relative(root, file)} -> ${spec}`);
  }
}
check(
  "Host 侧的 bare import 都在 peerDependencies/dependencies 里声明过",
  undeclared.length === 0,
  undeclared.join("; "),
);
check("源码文件数 > 0", files.length > 0, `${files.length} 个 .js`);
check("Host 侧确实用上了第一方依赖（否则自包含替代品又回来了）", offenders.length > 0, offenders.join("; "));

// ---- 2. manifest 形状 ----
const pkg = pkgForDeps;
check("package.json 有 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("patch 文件存在", fs.existsSync(path.join(root, pkg.dsh.bundle.patch)));
check("main 入口存在", fs.existsSync(path.join(root, pkg.main)));
check("声明了 peerDependencies（第一方包由宿主提供）", Boolean(pkg.peerDependencies));
check(
  "peerDependencies 覆盖 dsh-tools 与 schemastery",
  Boolean(pkg.peerDependencies?.["@deepseek-ai/dsh-tools"]) && Boolean(pkg.peerDependencies?.["@deepseek-ai/schemastery"]),
);
check("已删除手搓的 tool-schema.js", !fs.existsSync(path.join(root, "lib", "tool-schema.js")));

// 发行元数据：开源给别人装，这几项缺了会用不了或找不到出处。
check("有 LICENSE 文件", fs.existsSync(path.join(root, "LICENSE")));
check("license 是 SPDX 标识", /^[A-Za-z0-9.+-]+$/.test(pkg.license ?? ""), String(pkg.license));
check("有 repository", typeof pkg.repository === "object" || typeof pkg.repository === "string");
check("有 description", typeof pkg.description === "string" && pkg.description.length > 0);
check("有 keywords（含 dsh-plugin）", Array.isArray(pkg.keywords) && pkg.keywords.includes("dsh-plugin"));
check("files 白名单非空", Array.isArray(pkg.files) && pkg.files.length > 0);
check("engines.node 已声明", typeof pkg.engines?.node === "string");
check("版本是 0.1.0（尚未发布）", pkg.version === "0.1.0", pkg.version);

// 浏览器半侧声明：platform + ./client 导出 + 文件存在。
const clientRel = pkg.dsh?.client?.platform === "web" ? pkg.exports?.["./client"] : undefined;
check("声明 dsh.client.platform = web", pkg.dsh?.client?.platform === "web");
check("exports['./client'] 指向存在的文件", Boolean(clientRel) && fs.existsSync(path.join(root, clientRel)), String(clientRel));
check(
  "dsh.client.inject 是字符串数组",
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.every((s) => typeof s === "string"),
);

const patch = fs.readFileSync(path.join(root, pkg.dsh.bundle.patch), "utf8");
check("patch 的 name 与包名一致", patch.includes(`name: ${pkg.name}`), pkg.name);
check("patch 声明了 id", /id:\s*\S+/.test(patch));

// ---- 3. 工具定义形状（真实 defineTool） ----
const mod = await import(new URL("./index.js", import.meta.url).href);
check("导出 name", mod.name === "agnes-gen");
check("inject 只要求 tools", Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "tools");
check("导出 apply", typeof mod.apply === "function");
check("导出真实 Schemastery Config", typeof mod.Config === "function" && typeof mod.Config.toJSON === "function");

/** Host 侧 `settings.describe()` 的假实现：模拟一个含机密字段的用户层。 */
const FAKE_USER_LAYER = { apiKeyCn: "sk-super-secret-value", gifFps: 24 };

const registered = [];
const routes = [];
let installedSection = null;
const fakeCtx = {
  logger: () => ({ info() {}, warn() {} }),
  tools: { register: (def) => registered.push(def) },
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === "function" ? disposer : () => {};
  },
  inject: (deps, cb) => {
    if (deps.includes("skills")) {
      cb({ skills: { register() {} } });
      return;
    }
    if (deps.includes("settings")) {
      cb({
        settings: {
          installSection: (owner, ns, schema, entry, hooks) => {
            installedSection = { ns, schema, entry, hooks };
          },
          get: () => undefined,
          // 未脱敏的视图（Host 侧内部用），settingsUserKeys() 依赖它。
          describe: () => [{ ns: "agnes-gen", user: FAKE_USER_LAYER, value: {}, revision: 3 }],
        },
      });
      return;
    }
    if (deps.includes("webServer")) {
      cb({
        effect: (fn) => {
          const disposer = fn();
          return typeof disposer === "function" ? disposer : () => {};
        },
        webServer: {
          register: (route) => {
            routes.push(route);
            return () => {};
          },
        },
      });
    }
  },
};
mod.apply(fakeCtx, {});

check("注册了 2 个工具", registered.length === 2, registered.map((d) => d.name).join(", "));

// defineTool 的产物形状：parameters 是编译后的 JSON Schema，output.schema + render。
for (const def of registered) {
  const ok =
    typeof def.name === "string" &&
    def.name.length > 0 &&
    typeof def.description === "string" &&
    def.description.length > 0 &&
    def.parameters?.type === "object" &&
    typeof def.output?.schema === "object" &&
    typeof def.output?.render === "function" &&
    typeof def.execute === "function";
  check(`工具 ${def.name} 定义合法（defineTool 编译产物）`, ok);
}

// 编译后的 required 必须落在 object 根上（真实 defineTool 的约定）。
const img = registered.find((d) => d.name === "agnes_image");
check("真实 defineTool 把 required 编译到 object 根", Array.isArray(img?.parameters?.required) && img.parameters.required.includes("prompt"), JSON.stringify(img?.parameters?.required));
check("真实 defineTool 把 enum 保留在属性上", Array.isArray(img?.parameters?.properties?.size?.enum), JSON.stringify(img?.parameters?.properties?.size?.enum));

// 输出目录不接受调用方指定：两个工具都不得暴露 out_dir 参数（防乱填路径）。
// 输出位置只由操作者配置（outDir / AGNES_OUT_DIR）或默认会话 workspace 决定。
const noOutDir = registered.every((d) => !("out_dir" in (d.parameters?.properties ?? {})));
check("工具不再暴露 out_dir 参数（输出目录由操作者/默认决定）", noOutDir);

// 但允许 AI 自定义文件名主名：两个工具都暴露 output_name。
const bothOutputName = registered.every((d) => typeof d.parameters?.properties?.output_name?.type === "string");
check("两个工具都暴露 output_name（供 AI 自定义文件名，清洗为安全基名）", bothOutputName);

// safeBaseName 必须存在且能清洗掉路径/非法字符。
const { safeBaseName } = await import(new URL("./lib/util.js", import.meta.url).href);
check("safeBaseName 去掉路径分隔符与冒号", safeBaseName("a/b\\c: d") === "abc-d", safeBaseName("a/b\\c: d"));
check("safeBaseName 拒绝 Windows 保留名", safeBaseName("CON") === "" && safeBaseName("nul.txt") === "", safeBaseName("CON"));
check("safeBaseName 允许正常名字", /^[A-Za-z0-9_-]+$/.test(safeBaseName("city-sunset_2")), safeBaseName("city-sunset_2"));

// 显式给了 output_name 用**纯名**（不叠时间戳）；只有自动名才带时间戳防重名。
const clientNaming = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");
const idxNaming = fs.readFileSync(path.join(root, "index.js"), "utf8");
check(
  "图片基名：有 output_name 就用纯名，否则才叠时间戳",
  /custom \? custom : `\$\{stamp\(\)\}_\$\{slug/.test(clientNaming),
  "",
);
check(
  "视频基名：有 output_name 就用纯名（index.js 的 outBase 同理）",
  /safeBaseName\(args\.output_name\) \|\| `\$\{stamp\(\)\}_\$\{slug/.test(idxNaming),
  "",
);

// ---- 自定义模型：/v1/models 拉取 + 按 id 分类 + 站点区分白名单 ----
const vid = registered.find((d) => d.name === "agnes_video");
check("图片工具暴露 model 参数（供选择图像模型）", typeof img?.parameters?.properties?.model?.type === "string");
check("图片工具默认模型=当前站选中项（触发 resolveModels）", /resolveModels\(cfg, "image"\)/.test(idxNaming));
check("视频工具用 resolveModels 校验 model", /resolveModels\(cfg, "video"\)/.test(idxNaming));

// resolveModels：每站一套可选集 + 选中项；空集回落内置默认，选中项不在集内回落集首项。
const { resolveModels } = await import(new URL("./lib/config-schema.js", import.meta.url).href);
const rmEmpty = resolveModels({}, "image");
check("resolveModels 空配置回落内置图像默认", rmEmpty.selected === "agnes-image-2.5-flash" && rmEmpty.list.length === 0, rmEmpty.selected);
const rmCn = resolveModels({ site: "cn", imageModelsCn: ["A", "B", "A"], imageModelCn: "B" }, "image");
check("resolveModels 中国站正确读 imageModelsCn/选中项", rmCn.list.join(",") === "A,B" && rmCn.selected === "B", rmCn.list.join(",") + "/" + rmCn.selected);
const rmIntl = resolveModels({ site: "intl", imageModelsIntl: ["X"], imageModelIntl: "X" }, "image");
check("resolveModels 国际站读 imageModelsIntl（与国内站隔离）", rmIntl.list.join(",") === "X" && rmIntl.selected === "X", rmIntl.list.join(","));
const rmVideo = resolveModels({ site: "cn", videoModelsCn: ["agnes-video-2.5-flash", "agnes-video-2.5"], videoModelCn: "agnes-video-2.5" }, "video");
check("resolveModels 视频站点集同法（选中项优先于默认）", rmVideo.list.join(",") === "agnes-video-2.5-flash,agnes-video-2.5" && rmVideo.selected === "agnes-video-2.5", rmVideo.selected);

// execute 里白名单校验在调用外部 API 之前：给了清单外的模型应立即抛错，无需 key/网络。
// （mod.apply 用的是空配置，筛选出的默认集 = 内置 [IMAGE_MODEL]，'agnes-nope' 不在其中。）
let modelThrow = null;
try {
  await img.execute({ prompt: "x", model: "agnes-nope-not-in-list" }, { signal: new AbortController().signal });
} catch (err) {
  modelThrow = err.message;
}
check("execute: 清单外模型立即被拒（白名单生效）", /不在当前站的模型清单内/.test(String(modelThrow)), String(modelThrow));

// fetchModels：/v1/models 响应里按 id 前缀分类 image / video。
const clientSrcForModels = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");
check("client.js 实现了 fetchModels 并含 /v1/models", /fetchModels/.test(clientSrcForModels) && /\/v1\/models/.test(clientSrcForModels));
check(
  "schema 含每站 image/video 模型的可选集+选中项字段",
  /imageModelsCn: z\.array/.test(fs.readFileSync(path.join(root, "lib", "config-schema.js"), "utf8")) &&
    /videoModelsIntl: z\.array/.test(fs.readFileSync(path.join(root, "lib", "config-schema.js"), "utf8")) &&
    /imageModelCn: z\.string/.test(fs.readFileSync(path.join(root, "lib", "config-schema.js"), "utf8")),
);
check("index.js 注册 /check 校验路由", /\/plugins\/dsh-agnes-gen\/check/.test(idxNaming) && /fetchModels\(site, key/.test(idxNaming));

// ffmpeg 缺失/失败必须降级，不连累已生成的视频：GIF 分支包在 try/catch 里，
// 结果走 warning（非致命），不把整条 agnes-video 调用变成错误。
check("视频输出 schema 含 warning 字段（非致命提示）", /warning:\s*\{ topic: "string"/.test(idxNaming) || /warning: \{ type: "string"/.test(idxNaming));
check(
  "GIF 转换包在 try/catch（ffmpeg 缺失降级，不报错）",
  /catch \(err\) \{\s*?\/\/ GIF 是可选增强/.test(idxNaming) ||
    /catch \(err\) \{\s*?gifPath = "";/.test(idxNaming),
  "",
);

// 参数校验确实生效（由真实 defineTool 的 ToolArgsError 抛出）。
let threw = false;
try {
  await img.execute({}, { signal: new AbortController().signal });
} catch (err) {
  threw = /prompt/i.test(err.message);
}
check("缺必填参数时校验报错", threw);

let badEnum = false;
try {
  await img.execute({ prompt: "x", size: "8K" }, { signal: new AbortController().signal });
} catch (err) {
  badEnum = /1K/.test(err.message);
}
check("非法枚举值被拒", badEnum);

let badType = false;
try {
  await img.execute({ prompt: 123 }, { signal: new AbortController().signal });
} catch (err) {
  badType = /string/i.test(err.message);
}
check("参数类型错误被拒", badType);

// ---- 4. settings schema（真实 Schemastery） ----
check("注册了 settings namespace", installedSection !== null, installedSection?.ns ?? "");
check("namespace 名合法（小写 kebab-case）", /^[a-z][a-z0-9-]*$/.test(installedSection?.ns ?? ""));
check("settings schema 可调用", typeof installedSection?.schema === "function");
check("settings schema 有 toJSON()", typeof installedSection?.schema?.toJSON === "function");
check(
  "注册的是真实的 Schemastery 实例（不是手搓替身）",
  installedSection?.schema === mod.Config && typeof mod.Config.role === "function",
);

const envelope = installedSection?.schema?.toJSON?.();
const rootNode = envelope?.refs?.[envelope?.uid];
check("信封是 { uid, refs } 形状", Boolean(envelope) && typeof envelope.uid === "number" && typeof envelope.refs === "object");
check("根节点是 object", rootNode?.type === "object", String(rootNode?.type));

// 活节点：redactSecrets() 遍历的是它们，不是 toJSON 的结果。
check("schema 暴露活节点 dict（机密剥离依赖它）", installedSection?.schema?.dict !== undefined);
const secretNode = installedSection?.schema?.dict?.apiKeyCn;
check("apiKeyCn 标记为 secret（值不会出现在任何响应里）", secretNode?.meta?.role === "secret", String(secretNode?.meta?.role));

// 每个字段都要能解析出值，否则表单会渲染成空控件。
// 注意：三个密钥字段与 outDir 等无 default 的 string 字段解析后可能缺键，
// 这是正常的；这里只要求 **有 default 的字段** 一定出现。
const fieldKeys = Object.keys(rootNode?.dict ?? {});
check("信封声明了字段", fieldKeys.length > 0, fieldKeys.join(","));
const resolvedDefaults = installedSection.schema({});
check(
  "三个密钥字段解析后都不出现（未配置即缺省）",
  resolvedDefaults.apiKey === undefined &&
    resolvedDefaults.apiKeyCn === undefined &&
    resolvedDefaults.apiKeyIntl === undefined,
);
const expectedDefaultKeys = fieldKeys.filter((k) => !k.startsWith("apiKey"));
check(
  "所有非机密字段都能解析出默认值",
  expectedDefaultKeys.every((k) => resolvedDefaults[k] !== undefined),
  expectedDefaultKeys.filter((k) => resolvedDefaults[k] === undefined).join(","),
);

// 严格语义：非法值必须抛错，而不是被静默改写成默认值。
// 这是刻意选择（见 config-schema.js 顶部注释）：RPM 是安全相关设置，
// 静默改写用户写下的数字比报错更危险。index.js 会把 register 失败降级成
// logger.warn，插件行照常加载，只是配置卡不可用。
let strictError = "";
try {
  installedSection.schema({ imageRpm1K: -5 });
} catch (err) {
  strictError = err.message;
}
check("非法值抛错而不是静默回落", /imageRpm1K/.test(strictError), strictError);

let strictEnum = "";
try {
  installedSection.schema({ plan: "bogus" });
} catch (err) {
  strictEnum = err.message;
}
check("非法枚举值抛错", /plan/.test(strictEnum), strictEnum);

// 严格语义的后果必须被认识到：一份手改坏的 settings.yaml 会让 register() 抛错。
// index.js 把它降级成 logger.warn，插件行照常加载、工具照常可用，只是配置卡消失。
// 这条用真实 Provider 单独验证过（见 README「验证」一节）。
const badSection = { imageRpm1K: -5 };
let registerWouldThrow = false;
try {
  installedSection.schema({ ...defaultConfig(), ...badSection });
} catch {
  registerWouldThrow = true;
}
check("非法 user 层会让 schema 求值抛错（注册失败→降级为 warn）", registerWouldThrow);

// 未声明的键：Schemastery 会**保留**在解析结果里，但不会声明进 dict。
// 实测行为（不是猜测）：`Config({ nope: 1 })` → `{ ...defaults, nope: 1 }`。
// 也就是说 settings.yaml 里拼错的键名不会报错、也不会被表单渲染出来，
// 但会留在 resolved 值里。对我们无害（只读已知键），但值得记下来。
const withExtra = installedSection.schema({ nope: 1 });
check("未声明的键不会被声明进 schema", rootNode?.dict?.nope === undefined);
check("未声明的键会保留在解析结果里（实测行为）", withExtra.nope === 1);
check("未声明的键不影响已知字段的默认值", withExtra.plan === "free" && withExtra.gifWidth === 480);

// ---- 4b. RPM 预设 ----
const { effectiveLimits, PLANS, PLAN_VALUES, defaultConfig, publicDefaults } = await import(
  new URL("./lib/config-schema.js", import.meta.url).href
);
check("预设可选值来自 PLANS", PLAN_VALUES.length === 2 && PLAN_VALUES.every((v) => PLANS[v]));

// 免费档与 Token Plan 档必须各自给出公布的数值。
// 用 defaultConfig() 作底：它已经包含全部 schema 默认值。
const baseDefaults = defaultConfig();
const freeLimits = effectiveLimits({ ...baseDefaults, plan: "free" });
const tokenLimits = effectiveLimits({ ...baseDefaults, plan: "token-plan" });
check(
  "免费档预设计算出正确的逐档位上限",
  freeLimits.image["1K"] === 20 && freeLimits.image["2K"] === 10 && freeLimits.image["3K"] === 1 && freeLimits.video === 1,
  `${JSON.stringify(freeLimits.image)} video=${freeLimits.video}`,
);
check(
  "Token Plan 档预设计算出正确的逐档位上限",
  tokenLimits.image["1K"] === 100 && tokenLimits.image["2K"] === 80 && tokenLimits.image["3K"] === 1 && tokenLimits.video === 5,
  `${JSON.stringify(tokenLimits.image)} video=${tokenLimits.video}`,
);
check(
  "两种预设下 3K/4K 都是 1 RPM（Agnes 的硬限制）",
  freeLimits.image["3K"] === 1 && freeLimits.image["4K"] === 1 && tokenLimits.image["3K"] === 1 && tokenLimits.image["4K"] === 1,
);

// 逐档位覆盖优先于预设，且 0 表示跟随。
const overridden = effectiveLimits({ ...baseDefaults, plan: "free", imageRpm1K: 5, videoRpm: 3 });
check("覆盖值 > 0 时优先于预设", overridden.image["1K"] === 5 && overridden.video === 3, `1K=${overridden.image["1K"]} video=${overridden.video}`);
check(
  "未覆盖的档位仍跟随预设",
  overridden.image["2K"] === 10 && overridden.image["4K"] === 1,
  `2K=${overridden.image["2K"]} 4K=${overridden.image["4K"]}`,
);
check(
  "被覆盖的档位被标记出来",
  overridden.overridden.includes("imageRpm1K") && overridden.overridden.includes("videoRpm"),
  overridden.overridden.join(","),
);
check("0 表示跟随预设（不标记覆盖）", effectiveLimits({ ...baseDefaults, imageRpm2K: 0 }).overridden.length === 0);

// 已知预设之外的取值要回落到免费档，而不是算出 NaN。
// 注意：schema 层已经拒绝未知 plan，但 effectiveLimits 仍要能容忍
// 组合层（cordis.patch.yml 的 config:）绕过 schema 直接塞进来的值。
const bogusPlan = effectiveLimits({ ...baseDefaults, plan: "nope" });
check("未知预设回落到免费档", bogusPlan.plan === "free" && bogusPlan.image["1K"] === 20, JSON.stringify(bogusPlan.image));

// 数值表必须与限流器的公开参考值同源（不能各抄一份）。
const { FREE_RPM, TOKEN_PLAN_RPM } = await import(new URL("./lib/rate-limit.js", import.meta.url).href);
check(
  "预设数值直接引用 rate-limit.js 的参考值表",
  PLANS.free.image === FREE_RPM.image &&
    PLANS.free.video === FREE_RPM.video &&
    PLANS["token-plan"].image === TOKEN_PLAN_RPM.image &&
    PLANS["token-plan"].video === TOKEN_PLAN_RPM.video,
);

// ---- 4c. 单一份默认配置 ----
// 现在默认值只写在真实 Schemastery 的 `.default(...)` 里，defaultConfig()
// 直接求值 `Config({})` 得到，index.js 的 DEFAULT_CONFIG 再由它拼出。
// 这里把「三者同源」钉死：任何一处另抄一份数字都会被这条抓住。
const schemaDefaults = installedSection.schema({});
// 数组字段用深比较（Object.is 按引用，两处各自生成的新数组会误判漂移）。
const driftedKeys = fieldKeys.filter(
  (key) =>
    !key.startsWith("apiKey") &&
    JSON.stringify(mod.DEFAULT_CONFIG[key]) !== JSON.stringify(schemaDefaults[key]),
);
check(
  "DEFAULT_CONFIG 的每个 schema 字段都等于 schema 默认值（单一来源）",
  driftedKeys.length === 0,
  driftedKeys.map((k) => `${k}: ${JSON.stringify(mod.DEFAULT_CONFIG[k])} vs ${JSON.stringify(schemaDefaults[k])}`).join("; "),
);
check(
  "defaultConfig() 就是 schema 的空输入求值结果",
  JSON.stringify(defaultConfig()) === JSON.stringify(schemaDefaults),
  JSON.stringify(defaultConfig()),
);
check(
  "DEFAULT_CONFIG 保留 schema 之外的内部调优项",
  mod.DEFAULT_CONFIG.imageTimeoutMs === 300000 && mod.DEFAULT_CONFIG.videoPollMs === 2500 && mod.DEFAULT_CONFIG.videoTimeoutMs === 1800000,
);

// 下发给浏览器的默认值不得含机密字段。
const pubDefaults = publicDefaults();
check(
  "publicDefaults 不含任何密钥字段",
  pubDefaults.apiKey === undefined && pubDefaults.apiKeyCn === undefined && pubDefaults.apiKeyIntl === undefined,
);
check("publicDefaults 含非机密的 ffmpegPath", pubDefaults.ffmpegPath === "");
check(
  "publicDefaults 覆盖其余的 schema 字段",
  fieldKeys.filter((k) => !k.startsWith("apiKey")).every((k) => k in pubDefaults),
);

// ---- 5. 浏览器半侧 bundle ----
const clientSource = fs.readFileSync(CLIENT_BUNDLE, "utf8");
const registrations = [];
const sandbox = {
  window: { __ModuleLoader__: { load: (r) => registrations.push(r) } },
  console: { log() {}, warn() {}, error() {} },
  fetch: async () => {
    throw new Error("offline selfcheck");
  },
  document: undefined,
};
sandbox.globalThis = sandbox;
let loaded = true;
let loadError = "";
try {
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox);
} catch (err) {
  loaded = false;
  loadError = err.message;
}
check("client bundle 可被求值", loaded, loadError);
check("client bundle 注册了恰好一个模块", registrations.length === 1, `${registrations.length} 个`);
check("模块 id 等于包名（否则 loader 会报未注册）", registrations[0]?.id === pkg.name, String(registrations[0]?.id));
check("factory 是函数", typeof registrations[0]?.factory === "function");

// 用最小 react 替身物化 bundle，确认导出面与 slot 注册形状。
let clientExports = null;
let materializeError = "";
try {
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  clientExports = registrations[0].factory(() => reactStub);
} catch (err) {
  materializeError = err.message;
}
check("factory 可用 react 替身物化", clientExports !== null, materializeError);
check("导出 apply", typeof clientExports?.apply === "function");
check("导出 inject", Array.isArray(clientExports?.inject));

// 浏览器半侧不该再调用 bound scope 上并不存在的 ensure()。
check("client bundle 不再调用不存在的 scope.ensure()", !/scope\.ensure/.test(clientSource));

// ---- 5a. 布局不变量（曾出过「重置按钮与输入框重叠」） ----
// 根因有两个，都必须钉住：
//   1. `<input>` 的固有宽度约 178px，而 grid item 默认 `min-width:auto`，
//      不会缩到 88px 的列宽以下，于是溢出压到右侧按钮上 → 必须 min-width:0；
//   2. 卡片内控件是 `width:100%` + padding + border，DSH shell 没有全局
//      box-sizing 兜底，content-box 下实际宽度会超出列宽 → 必须 border-box。
check("卡片内统一 border-box（否则 width:100% 的控件会溢出列宽）", /\.agn-card,\.agn-card \*\{box-sizing:border-box\}/.test(clientSource));
check(
  "RPM 输入框声明了 min-width:0（grid item 默认不缩，会压到重置按钮上）",
  /\.agn-rpmInput\{[^}]*min-width:0/.test(clientSource),
);
check(
  "RPM 行的操作列是定宽（用 auto 会让各行输入框错位）",
  /\.agn-rpmRow\{[^}]*grid-template-columns:minmax\(0,1fr\) 88px 52px/.test(clientSource),
);
check("未覆盖时用与按钮列同宽的占位符保持对齐", /\.agn-rpmSpacer\{display:block;width:100%\}/.test(clientSource));
check(
  "重置按钮靠右对齐（justify-self:end）",
  /\.agn-rpmReset\{justify-self:end/.test(clientSource),
);
// CSS 里不该出现会让 RPM 输入框重新溢出的写法。
check("RPM 行没有用 auto 作为最后一列", !/\.agn-rpmRow\{[^}]*88px auto/.test(clientSource));
check("agn-rpmInput 没有覆盖回 min-width:auto", !/\.agn-rpmInput\{[^}]*min-width:auto/.test(clientSource));

// ---- 5b. 两半的字段名契约 ----
// 浏览器半侧无法 import Host 的 schema（它是 lazy-CJS，只能 require("react")），
// 所以字段名是两边各写一份的**约定**。约定漂移不会报错，只会静默失效
// （表单写到不存在的键、覆盖状态认不出来）。这里把契约钉住：
//   - client 侧出现的每个配置键，Host schema 里必须存在；
//   - Host schema 里每个非 RPM 键，client 侧必须认识（否则界面上改不到）。
const hostFieldKeys = new Set([
  ...fieldKeys,
  "plan",
  "site",
  ...["1K", "2K", "3K", "4K"].map((t) => `imageRpm${t}`),
  "videoRpm",
]);
const clientKeyMatches = [...clientSource.matchAll(/\bkey:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const clientOnly = [...new Set(clientKeyMatches)].filter((k) => !hostFieldKeys.has(k));
check(
  "client bundle 里的每个 key 都存在于 Host schema",
  clientOnly.length === 0,
  clientOnly.join(","),
);

// Host 侧每个字段都要能在界面上改到（RPM 由分组控件渲染，故豁免）。
// hidden 字段（历史 apiKey）刻意不渲染，因此也豁免。
const rpmOnly = new Set(["imageRpm1K", "imageRpm2K", "imageRpm3K", "imageRpm4K", "videoRpm"]);
const hiddenInClient = new Set(["apiKey"]);
const missingInClient = [...fieldKeys].filter(
  (k) => !rpmOnly.has(k) && !hiddenInClient.has(k) && !clientKeyMatches.includes(k),
);
check(
  "Host schema 的每个可见非 RPM 字段都被界面渲染",
  missingInClient.length === 0,
  missingInClient.join(","),
);
check(
  "hidden 的 apiKey 不出现在界面字段里",
  !clientKeyMatches.includes("apiKey"),
  clientKeyMatches.join(","),
);

// RPM 覆盖键名的构造规则必须两边一致。
check(
  "client 侧用 imageRpm<tier> 拼键名（与 Host 一致）",
  /`imageRpm\$\{tier\}`/.test(clientSource) || clientSource.includes("imageRpm${tier}"),
);
check("client 侧的视频覆盖键名为 videoRpm", /VIDEO_RPM_KEY\s*=\s*"videoRpm"/.test(clientSource));

// ---- 5c. 站点两站契约 ----
// 站点决定请求主机与 Key 的环境变量优先级，两半各写一份，必须一致。
check("client bundle 声明了两个站点", /SITE_VALUES\s*=\s*\["cn",\s*"intl"\]/.test(clientSource));
check("client 侧站点选择器能被 specFor 查到（否则编辑会被静默丢弃）", /specFor\(key\)[\s\S]{0,200}key === "site"/.test(clientSource));
check("client 侧把 site 排除在可恢复默认的键之外", !/RESETTABLE_KEYS[\s\S]{0,140}"site"/.test(clientSource));
check("client 侧把模型字段排除在可恢复默认的键之外", /kind !== "model"/.test(clientSource));

const hostSites = mod.SITES;
check("Host 侧导出 SITES", Boolean(hostSites) && Boolean(hostSites.cn) && Boolean(hostSites.intl));
check(
  "两站的 base 与 client 侧写法一致",
  clientSource.includes(hostSites.cn.base) && clientSource.includes(hostSites.intl.base),
  `${hostSites.cn.base} | ${hostSites.intl.base}`,
);
check(
  "两站的 consoleUrl 与 client 侧写法一致",
  clientSource.includes(hostSites.cn.consoleUrl) && clientSource.includes(hostSites.intl.consoleUrl),
);

// 端点不再硬编码：必须由 site 推导。
check(
  "Host 侧不再硬编码单站点端点常量",
  !/export const (IMAGE_ENDPOINT|VIDEO_BASE) =/.test(fs.readFileSync(path.join(root, "lib", "client.js"), "utf8")),
);
const cnSite = mod.siteOf({ site: "cn" });
const intlSite = mod.siteOf({ site: "intl" });
check("siteOf(cn) 指向中国站", cnSite.base === "https://api.agnes-ai.cn", cnSite.base);
check("siteOf(intl) 指向国际站", intlSite.base === "https://apihub.agnes-ai.com", intlSite.base);
check("未知站点回落到中国站（不会算出 undefined）", mod.siteOf({ site: "bogus" }).base === "https://api.agnes-ai.cn");
check("siteOf 缺省也是中国站（向后兼容）", mod.siteOf({}).base === "https://api.agnes-ai.cn");
check("schema 声明了 site 字段", fieldKeys.includes("site"));
check("site 的默认值是中国站", schemaDefaults.site === "cn", String(schemaDefaults.site));

// Key 只有配置一个来源：不允许任何环境变量 / 凭据文件回退把老路悄悄带回来。
const clientSrc = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");
check("SITES 不再携带 keyEnvs（已删掉环境变量回退的根源）", !/keyEnvs/.test(clientSrc));
check(
  "readKey / keyStatus 不再读取 process.env 或 .credentials.yaml",
  !/\.credentials\.yaml["']/.test(clientSrc) &&
    !/process\.env\s*\[[^\]]+\]/.test(clientSrc),
  "",
);
check(
  "readKey 对缺失 Key 的报错只指引填配置（不再提示环境变量 / 凭据文件）",
  /readKey[\s\S]{0,300}apiKeyCn \/ apiKeyIntl/.test(clientSrc),
  "",
);

// ---- 5c-2. 默认输出目录来自会话 header ----
// 没配 outDir 时，默认目录必须是**当前对话的 workspace**，而不是 dsh 进程
// 的启动目录。第一方工具（dsh-tool-fs / dsh-tool-present / dsh-tool-pwsh）取工作目录
// 用的是 `exec.agent.session.header.cwd`。之前误写 `session.meta.cwd`，取不到就
// 回落 process.cwd()（进程起始目录），导致文件落到 C:\Users\36069\out 而非对话目录。
const idxSrc = fs.readFileSync(path.join(root, "index.js"), "utf8");
check("取工作目录用 exec.agent.session.header.cwd（而非 meta.cwd）", /session\?\.header\?\.cwd/.test(idxSrc), "");
check("不再误用不存在的 session.meta.cwd", !/session\?\.meta\?\.cwd/.test(idxSrc), "");

// ---- 5d. 两站密钥分离 ----
// 需求：两站的 Key 分别配置、各用各的。这里钉住三件事：
//   1) 两个密钥字段都存在且都是 secret；
//   2) 站点→字段的映射正确，且不会「回落到另一站的键」（那会造成必然 401）；
//   3) 历史单键 apiKey 仍被声明（否则老用户的明文 Key 会从脱敏中漏出去）。
const { SITE_KEY_FIELDS, keyFieldForSite, siteKeyOf, secretFieldNames } = await import(
  new URL("./lib/config-schema.js", import.meta.url).href
);
const secrets = secretFieldNames();
check("声明了 apiKeyCn 与 apiKeyIntl 两个机密字段", secrets.includes("apiKeyCn") && secrets.includes("apiKeyIntl"), secrets.join(","));
check("历史字段 apiKey 仍被声明为 secret（否则老密钥不再脱敏）", secrets.includes("apiKey"), secrets.join(","));
check("历史字段 apiKey 标记为 hidden（不被通用表单渲染）", mod.Config.dict?.apiKey?.meta?.hidden === true);
check("两个站点各有自己的密钥字段", SITE_KEY_FIELDS.cn === "apiKeyCn" && SITE_KEY_FIELDS.intl === "apiKeyIntl");
check("keyFieldForSite 未知站点回落中国站", keyFieldForSite({ site: "bogus" }) === "apiKeyCn");

const bothKeys = { site: "cn", apiKeyCn: "sk-cn", apiKeyIntl: "sk-intl" };
check("中国站只取 apiKeyCn", siteKeyOf(bothKeys) === "sk-cn", String(siteKeyOf(bothKeys)));
check("国际站只取 apiKeyIntl", siteKeyOf({ ...bothKeys, site: "intl" }) === "sk-intl");
check(
  "站点字段为空时不回落到另一站的键（避免错配 401）",
  siteKeyOf({ site: "intl", apiKeyCn: "sk-cn" }) === undefined,
  String(siteKeyOf({ site: "intl", apiKeyCn: "sk-cn" })),
);
check("publicDefaults 不含任何密钥字段", ["apiKey", "apiKeyCn", "apiKeyIntl"].every((k) => !(k in pubDefaults)));

// 浏览器半侧的映射必须与 Host 一致。
check(
  "client 侧 keyFieldForSite 由中国站回落",
  /function keyFieldForSite[\s\S]{0,160}\?\? "apiKeyCn"/.test(clientSource),
);
check(
  "client 侧 KEY_FIELDS 声明了两个站各自的密钥字段",
  /const KEY_FIELDS\s*=\s*\[/.test(clientSource) &&
    /key: "apiKeyCn"[\s\S]{0,120}site: "cn"/.test(clientSource) &&
    /key: "apiKeyIntl"[\s\S]{0,120}site: "intl"/.test(clientSource),
);
check(
  "client 侧两个密钥字段不在通用 FIELDS 里（按站点只显示一个）",
  !/const FIELDS = \[[\s\S]{0,200}apiKeyCn/.test(clientSource) &&
    !/const FIELDS = \[[\s\S]{0,400}apiKeyIntl/.test(clientSource),
);
check("client 侧不在通用渲染里出现 key: apiKeyCn（由 SiteField 负责）", !/key: "apiKeyCn"[\s\S]{0,60}label/.test(clientSource) || /SiteField/.test(clientSource));
check("client 侧不再把裸 apiKey 当作可编辑字段", !/key:\s*"apiKey"\s*,/.test(clientSource));
check("client 侧 RESETTABLE_KEYS 仍排除机密字段", /RESETTABLE_KEYS[\s\S]{0,220}!SECRET_KEYS\.has\(key\)/.test(clientSource));
check(
  "client 侧 SECRET_KEYS 同时覆盖 FIELDS 与 KEY_FIELDS 的机密字段",
  /SECRET_KEYS\s*=\s*new Set\(\[[\s\S]{0,60}FIELDS[\s\S]{0,120}KEY_FIELDS/.test(clientSource),
);

// 光比常量还不够：必须确认**实际发出的请求**落在选定站点的 host 上。
// 用一个本地服务器冒充 Agnes，把 base 换成带 marker 的本地地址，
// 这样「site 参数有没有被真正传下去」是可观测的。
{
  const http = await import("node:http");
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    // Connection: close —— undici 默认 keep-alive，长连接会让进程退出时
    // 触发 libuv 的 UV_HANDLE_CLOSING 断言。
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outDir = path.join(root, "out", "_selfcheck-site");
  try {
    const { generateImage } = mod;
    hits.length = 0;
    await generateImage({
      prompt: "t",
      size: "1K",
      outDir,
      key: "sk-test",
      site: { ...cnSite, base },
      rateLimit: false,
    });
    check("图像请求发往 site.base（不是硬编码主机）", hits.some((u) => u.includes("/v1/images/generations")), hits.join(","));

    hits.length = 0;
    await generateImage({
      prompt: "t",
      size: "1K",
      outDir,
      key: "sk-test",
      site: { ...cnSite, base: `${base}/marker` },
      rateLimit: false,
    });
    check("换 site 后请求 host 随之改变（marker 可区分）", hits.every((u) => u.startsWith("/marker/")), hits.join(","));
  } catch (err) {
    check("图像请求发往 site.base（不是硬编码主机）", false, err.message);
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(path.join(root, "out"), { recursive: true, force: true });
  }
}

const slotCalls = [];
let cardComponent = null;
const clientCtx = {
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === "function" ? disposer : () => {};
  },
  settingsScope: {
    bind: () => ({
      getSnapshot: () => ({ status: "loading", value: undefined, user: {}, base: {}, revision: 0, writable: true, mode: "host" }),
      subscribe: () => () => {},
      set: async () => {},
      unset: async () => {},
      mutate: async () => {},
    }),
  },
  slots: {
    inject: (name, cb) => {
      slotCalls.push(`inject:${name}`);
      cb();
    },
    register: (options, component) => {
      slotCalls.push(`register:${options.name}:${options.key}`);
      cardComponent = component;
      return () => {};
    },
  },
};
let applyError = "";
try {
  clientExports.apply(clientCtx);
} catch (err) {
  applyError = err.message;
}
check("client apply() 不抛错", applyError === "", applyError);
check(
  "注册进 plugins.bundle.config，key 为包名",
  slotCalls.includes(`register:plugins.bundle.config:${pkg.name}`),
  slotCalls.join(" | "),
);
check("通过 ctx.slots.inject 延迟注册（等待 slot 声明）", slotCalls.some((c) => c.startsWith("inject:plugins.bundle.config")));

// 组件要能为两种视图渲染出东西——这是插件页唯一会做的事。
let viewError = "";
let bothRender = true;
try {
  const controllerStub = {
    subscribe: () => () => {},
    discard() {},
    refreshStatus: async () => {},
    read: () => ({ status: "loading", value: undefined, user: {}, base: {}, revision: 0, writable: true, mode: "host" }),
    getSnapshot: () => ({ status: "loading" }),
    saving: false,
    failed: "",
    notice: "",
    resetArmed: false,
    status: null,
    statusLoading: false,
    statusError: "",
    dirty: false,
    invalidFields: () => [],
    isOverridden: () => false,
    hasResettableOverrides: () => false,
    defaultFor: () => "",
    resetAll: async () => {},
  };
  for (const view of ["summary", "page"]) {
    const tree = cardComponent({ view, controller: controllerStub });
    if (!tree) bothRender = false;
  }
} catch (err) {
  viewError = err.message;
}
check("组件可为 summary 与 page 渲染", bothRender && viewError === "", viewError);

// ---- 4d. 一键恢复默认 ----
// Host 侧没有任何「重置」原语：恢复默认就是把用户层里的覆盖逐条 unset
// （见 dsh-client-ui-settings 的 README 与 dsh-settings 的 applyPathOp）。
// 下面用**真实**的 CardController 配一个假 scope 验证这条路径。
const clientScope = {
  user: {},
  revision: 7,
  writable: true,
  noop: false,
  mutateCalls: [],
  // 模拟 Host：把 ops 应用到用户层；noop 为 true 时**静默丢弃**（模拟 revision 冲突）。
  applyOps(ops) {
    if (this.noop) return;
    for (const op of ops) {
      if (op.op === "unset") delete this.user[op.path[0]];
      else this.user[op.path[0]] = op.value;
    }
  },
  snapshot() {
    return {
      status: "ready",
      value: { ...pubDefaults, ...this.user },
      base: {},
      user: { ...this.user },
      revision: this.revision,
      writable: this.writable,
      mode: "host",
    };
  },
};

// 用真实 bundle 的 apply() 建控制器：slot 注册回调把内部 controller 放进 props。
let realCard = null;
let controllerError = "";
let realController = null;
try {
  const ctx2 = {
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    settingsScope: {
      bind: () => ({
        getSnapshot: () => clientScope.snapshot(),
        subscribe: () => () => {},
        set: async (field, value) => clientScope.applyOps([{ op: "set", path: [field], value }]),
        unset: async (field) => clientScope.applyOps([{ op: "unset", path: [field] }]),
        mutate: async (ops) => {
          clientScope.mutateCalls.push(ops);
          clientScope.applyOps(ops);
        },
      }),
    },
    slots: {
      inject: (name, cb) => cb(),
      register: (options, component) => {
        realCard = component;
        return () => {};
      },
    },
  };
  clientExports.apply(ctx2);
  realController = realCard({ view: "page" }).props.controller;
} catch (err) {
  controllerError = err.message;
}
check("可用真实的 CardController 建卡", realController !== null, controllerError);
check("CardController 暴露 resetAll()", typeof realController?.resetAll === "function");

// Host 回报的覆盖键名（含被 redactSecrets 剥掉的机密字段）。
realController.status = {
  overriddenKeys: ["apiKeyCn", "gifFps"],
  defaults: pubDefaults,
  site: "cn",
  keyField: "apiKeyCn",
  key: { set: true, source: "配置" },
};
clientScope.user = { apiKeyCn: "sk-x", gifFps: 24, plan: "token-plan" };

// 机密字段永远不在 user 层里（被 redactSecrets 删除），覆盖状态只能靠 Host 回报。
check("机密字段的覆盖状态由 Host 的 overriddenKeys 补足", realController.isOverridden("apiKeyCn") === true);
check("user 层里可见的覆盖同样被识别", realController.isOverridden("gifFps") === true);
check("未覆盖的字段不算覆盖", realController.isOverridden("gifWidth") === false);
check("另一站的密钥未被覆盖（不影响当前站）", realController.isOverridden("apiKeyIntl") === false);

// 两段式：第一次点击只进入待确认，不提交任何 ops。
clientScope.mutateCalls.length = 0;
realController.resetArmed = false;
await realController.resetAll();
check("恢复默认第一下只进入待确认（不写）", clientScope.mutateCalls.length === 0 && realController.resetArmed === true);

// 第二次点击才真正提交，且**只发一次** mutate（原子）。
clientScope.user = { apiKeyCn: "sk-x", gifFps: 24, plan: "token-plan" };
await realController.resetAll();
const resetOps = clientScope.mutateCalls[0] ?? [];
check("第二下才提交，且只用一次原子 mutate", clientScope.mutateCalls.length === 1, `${clientScope.mutateCalls.length} 次`);
check(
  "恢复默认逐字段 unset（不用 path:[] 整节清空）",
  resetOps.length > 0 && resetOps.every((op) => op.op === "unset" && op.path.length === 1),
  JSON.stringify(resetOps),
);
check(
  "恢复默认不触碰任何一站的 API Key（否则会删掉已存的密钥）",
  resetOps.every((op) => !op.path[0].startsWith("apiKey")),
  resetOps.map((o) => o.path[0]).join(","),
);
check(
  "恢复默认只清除确实存在的覆盖",
  resetOps.map((op) => op.path[0]).sort().join(",") === "gifFps,plan",
  resetOps.map((op) => op.path[0]).join(","),
);
check("恢复默认后所有覆盖都消失", Object.keys(clientScope.user).join(",") === "apiKeyCn", Object.keys(clientScope.user).join(","));

// 全清之后没有可恢复项，按钮应禁用。
clientScope.user = {};
check("覆盖清空后 hasResettableOverrides 为 false（按钮禁用）", realController.hasResettableOverrides() === false);
// 只有密钥被覆盖时也不该启用：该按钮不负责密钥。
clientScope.user = { apiKeyCn: "sk-x" };
check("仅有 API Key 覆盖时不启用「恢复默认」", realController.hasResettableOverrides() === false);

// 「清除已配置的 Key」应**立即**清除并给反馈，无需再点保存。
clientScope.user = { apiKeyCn: "sk-x" };
realController.refreshStatus = async () => {
  // 模拟 Host 在 key 被清除后不再回报它：overriddenKeys 里去掉 apiKeyCn。
  realController.status = { ...(realController.status ?? {}), overriddenKeys: realController.userKeys().has("apiKeyCn") ? [] : (realController.status?.overriddenKeys ?? []) };
};
realController.notice = "";
realController.failed = "";
realController.statusLoading = false;
await realController.clearKey("apiKeyCn", "中国站 API Key");
check(
  "clearKey 立即清除 key 并报「已清除」",
  realController.notice === "中国站 API Key 已清除。" && !clientScope.user.apiKeyCn && realController.failed === "",
  `notice=${JSON.stringify(realController.notice)} failed=${JSON.stringify(realController.failed)} user=${JSON.stringify(clientScope.user)}`,
);
// 未配置时点清除给「无需清除」提示。
realController.notice = "";
realController.failed = "";
await realController.clearKey("apiKeyIntl", "国际站 API Key");
check(
  "clearKey 对未配置的 key 提示「无需清除」",
  realController.notice.includes("尚未配置，无需清除") && realController.failed === "",
  `notice=${JSON.stringify(realController.notice)}`,
);

// ---- 4d-2. 站点与「已配置」提示的一致性 ----
// status.key 说的是**上一次检测时那个站点**的结论，而 currentSite() 跟着草稿走。
// 用户把站点切到国际站但还没保存时，若继续采信 status.key，就会把
// 「中国站已配置」误显示成「国际站已配置」。这里验证卡片渲染出的占位文案。
const { createElement: hStub } = { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }) };
/**
 * 递归找某个 input 的 placeholder（按 id 定位）。
 *
 * 替身 React 不会自动展开函数组件，所以这里手动调用它们——否则只会看到
 * 顶层的 `<AgnesConfigCard>` 而拿不到任何子元素（自检里踩过一次）。
 *
 * 两个细节都是必须的，缺一个就找不到 `<input>`：
 *   1. children 放回 **props**（真实 React 就这样传）：`FieldShell` 从 props
 *      解构 `children`，用 `type(props, ...children)` 会让它渲染成 undefined；
 *   2. 必须能穿过**数组**：`h(FieldShell, props, input)` 让 `children` 变成
 *      一层数组，包装组件再嵌一层就是数组套数组——数组没有 `.props`，
 *      不专门处理就会在里面提前返回。
 */
function placeholderOf(tree, id, depth = 0) {
  if (tree === null || tree === undefined || depth > 40) return undefined;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = placeholderOf(child, id, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof tree !== "object") return undefined;
  if (typeof tree.type === "function") return placeholderOf(tree.type(tree.props), id, depth + 1);
  if (tree.props?.id === id) return tree.props.placeholder;
  return placeholderOf(tree.props?.children, id, depth + 1);
}

clientScope.user = { apiKeyCn: "sk-saved-cn" };
realController.status = { site: "cn", keyField: "apiKeyCn", key: { set: true, source: "配置" }, defaults: pubDefaults, overriddenKeys: ["apiKeyCn"] };
realController.drafts.clear();

// 站点停留在 cn：中国站的 Key 应显示「已配置」。
const cnView = realCard({ view: "page", controller: realController });
check(
  "站点未变时，当前站的 Key 显示为已配置",
  /已配置/.test(placeholderOf(cnView, "agn-apiKeyCn") ?? ""),
  placeholderOf(cnView, "agn-apiKeyCn"),
);

// 把站点草稿改成 intl（未保存）：这时不能再拿 cn 的检测结论说 intl 已配置。
realController.edit("site", "intl");
const intlView = realCard({ view: "page", controller: realController });
check(
  "站点草稿切到国际站后，不把中国站的检测结论套到国际站 Key 上",
  !/已配置/.test(placeholderOf(intlView, "agn-apiKeyIntl") ?? ""),
  placeholderOf(intlView, "agn-apiKeyIntl"),
);
realController.drafts.clear();

// ---- 4e. mutate 静默失败必须被识破 ----
// scope.mutate() 在 Host 拒绝写入时**也会 resolve**（内部只重读镜像，
// 见 dsh-client-ui-settings/lib/client.js 的 mutate 分支：`if (!response.ok) { await this.recover(...); return; }`），
// 所以「保存成功」必须靠回读判定，不能靠 try/catch。
clientScope.mutateCalls.length = 0;
clientScope.noop = true; // 模拟 Host 拒绝：ops 被丢弃，用户层不变
clientScope.user = {};
realController.drafts.clear();
realController.failed = "";
realController.notice = "";
realController.edit("gifWidth", "320");
await realController.save();
check(
  "Host 静默拒绝写入时不会假报「已保存」",
  realController.notice === "" && /未生效/.test(realController.failed),
  `notice=${JSON.stringify(realController.notice)} failed=${JSON.stringify(realController.failed)}`,
);

// 正常落地时必须报成功，并清空草稿。
clientScope.noop = false;
realController.failed = "";
realController.notice = "";
realController.drafts.clear();
realController.edit("gifWidth", "320");
await realController.save();
check(
  "写入真正落地时报告成功并清空草稿",
  /已保存/.test(realController.notice) && realController.drafts.size === 0 && realController.failed === "",
  `notice=${JSON.stringify(realController.notice)}`,
);
check("保存后生效值确实变了", clientScope.snapshot().value.gifWidth === 320, String(clientScope.snapshot().value.gifWidth));

// 数组字段（模型集）落地后，verify 的回读核对不能把同值不同引用的数组误判为「未生效」。
clientScope.noop = false;
realController.drafts.clear();
realController.failed = "";
realController.notice = "";
realController.edit("imageModelsCn", "agnes-image-2.5-flash, agnes-image-2.1-flash");
await realController.save();
check(
  "数组字段（模型集）保存后不误报「未生效」",
  /已保存/.test(realController.notice) && realController.failed === "",
  `notice=${JSON.stringify(realController.notice)} failed=${JSON.stringify(realController.failed)}`,
);
realController.drafts.clear();

// 恢复默认也要识破静默失败。
clientScope.user = { gifFps: 24 };
clientScope.noop = true;
realController.failed = "";
realController.notice = "";
realController.resetArmed = false;
await realController.resetAll();
await realController.resetAll();
check(
  "恢复默认遇到静默失败时报错而不是假报成功",
  realController.notice === "" && /未完全生效/.test(realController.failed),
  `notice=${JSON.stringify(realController.notice)} failed=${JSON.stringify(realController.failed)}`,
);
clientScope.noop = false;

// 编辑动作要撤销待确认状态，避免误触。
clientScope.user = { gifFps: 24 };
realController.resetArmed = false;
await realController.resetAll();
realController.edit("gifWidth", "400");
check("任何编辑都会撤销「恢复默认」的待确认状态", realController.resetArmed === false);

// 卡片要真的把「恢复默认」按钮渲染出来（递归展开函数组件，替身 React 不做调度）。
let resetButtonRendered = false;
let modelDropdownHasDefault = false;
let renderWalkError = "";
try {
  const labels = [];
  const selectVals = [];
  const render = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(render);
      return;
    }
    if (typeof node.type === "function") {
      render(node.type(node.props));
      return;
    }
    if (node.type === "button") labels.push(String(node.props?.children));
    if (node.type === "select") {
      const options = Array.isArray(node.props?.children) ? node.props.children : [];
      selectVals.push({
        id: String(node.props?.id ?? ""),
        values: options.map((o) => (o?.type === "option" ? o.props?.value : undefined)).filter((v) => v !== undefined),
      });
    }
    render(node.props?.children);
  };
  render(realCard({ view: "page" }));
  resetButtonRendered = labels.some((label) => label.includes("恢复默认"));
  // 站点区模型下拉里应能看到默认图像模型（agnes-image-2.5-flash）。
  const imageSelect = selectVals.find((s) => s.id === "agn-imageModelCn");
  modelDropdownHasDefault = Array.isArray(imageSelect?.values) && imageSelect.values.includes("agnes-image-2.5-flash");
} catch (err) {
  renderWalkError = err.message;
}
check("卡片渲染出「恢复默认」按钮", resetButtonRendered, renderWalkError);
check("站点区渲染出图像模型下拉且含默认图像模型", modelDropdownHasDefault, renderWalkError || "");

// ---- 6. 诊断路由 ----
check("注册了 2 条诊断路由", routes.length >= 2, routes.map((r) => `${r.kind}:${r.path}`).join(", "));
check(
  "诊断路由是 exact 且路径固定在插件命名空间下",
  routes[0]?.kind === "exact" && routes[0]?.path === "/plugins/dsh-agnes-gen/status",
  String(routes[0]?.path),
);

/** 用假的 req/res 调一次路由。 */
function callRoute(route, { method = "GET", addr = "127.0.0.1" } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = { method, socket: { remoteAddress: addr } };
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        if (body) chunks.push(body);
        resolve({ status: this.status, body: chunks.join("") });
      },
    };
    route.handler(req, res);
  });
}

const loopback = await callRoute(routes[0]);
check("本机请求返回 200", loopback.status === 200, String(loopback.status));
let payload = null;
try {
  payload = JSON.parse(loopback.body);
} catch {
  /* 下面的检查会报错 */
}
check("响应是 JSON 且含 key / ffmpeg 段", Boolean(payload?.key) && Boolean(payload?.ffmpeg));

// 诊断响应必须给出恢复默认所需的两个事实：覆盖键名与出厂默认值。
check(
  "响应含 overriddenKeys（供界面标记机密字段的覆盖状态）",
  Array.isArray(payload?.overriddenKeys) && payload.overriddenKeys.includes("apiKeyCn"),
  JSON.stringify(payload?.overriddenKeys),
);
check(
  "响应含 defaults（供界面在空输入框里提示默认值）",
  payload?.defaults?.gifWidth === 480 && payload?.defaults?.gifFps === 12,
  JSON.stringify(payload?.defaults),
);
check(
  "响应里的 defaults 不含任何密钥字段",
  payload?.defaults?.apiKey === undefined &&
    payload?.defaults?.apiKeyCn === undefined &&
    payload?.defaults?.apiKeyIntl === undefined,
);
// 站点信息：Key 明明配了却 401 时，用户要能核对请求发往哪里。
check("响应含 siteBase（实际请求主机）", payload?.siteBase === "https://api.agnes-ai.cn", payload?.siteBase);
check("响应含 consoleUrl（该站点的 Key 申请地址）", payload?.consoleUrl === "https://platform.agnes-ai.cn/settings/apiKeys", payload?.consoleUrl);
check("响应含 keyField（当前站点使用的密钥字段名）", payload?.keyField === "apiKeyCn", payload?.keyField);
// 整个响应体里不得出现密钥明文。
check("诊断响应不泄露密钥明文", !loopback.body.includes(FAKE_USER_LAYER.apiKeyCn));
check("诊断响应不含历史 apiKey 槽位", !("apiKey" in (payload?.defaults ?? {})));

// 机密绝不能出现在诊断响应里。
const reject = await callRoute(routes[0], { addr: "10.1.2.3" });
check("非回环请求返回 403", reject.status === 403, String(reject.status));
const wrongMethod = await callRoute(routes[0], { method: "DELETE" });
check("非 GET/HEAD 请求返回 405", wrongMethod.status === 405, String(wrongMethod.status));

// ---- 7. /check 路由：Key + 模型校验 ----
const checkRoute = routes.find((r) => r.path === "/plugins/dsh-agnes-gen/check");
check("注册了 /check 路由", Boolean(checkRoute), routes.map((r) => r.path).join(", "));
const noKeyCheck = checkRoute ? await callRoute(checkRoute) : null;
check(
  "未配 Key 时 /check 返回 configured:false（不触发外部请求）",
  noKeyCheck?.status === 200 && JSON.parse(noKeyCheck.body ?? "{}")?.configured === false,
  JSON.stringify(noKeyCheck?.body),
);
if (checkRoute) {
  const loop = await callRoute(checkRoute, { addr: "10.1.2.3" });
  check("/check 非回环请求返回 403", loop.status === 403, String(loop.status));

  // 提交 body（草稿站点+key）：后端必须用请求带来的 site/key，而不用已保存配置。
  // 即使网络不可用，响应的 site 也应反映 body 里的 draft 站点（而非保存的 cn）。
  const body = JSON.stringify({ site: "intl", key: "sk-draft-intl" });
  const req = {
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/plugins/dsh-agnes-gen/check",
    _chunks: body,
    on(evt, cb) {
      if (evt === "data") cb(Buffer.from(this._chunks));
      if (evt === "end") cb();
      return this;
    },
  };
  const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { if (b) this.body += b; } };
  await checkRoute.handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* 见下 */
  }
  check(
    "/check 用请求带的站点/key 校验（intl 从 body 带入，不回落已保存的 cn）",
    parsed?.configured === true && parsed?.site === "intl",
    JSON.stringify(parsed),
  );
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
