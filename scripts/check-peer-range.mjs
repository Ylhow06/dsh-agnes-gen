#!/usr/bin/env node
/**
 * 判断某个 DSH 版本是否需要为插件新增 peer 分支。
 *
 * 跑法：
 *   node scripts/check-peer-range.mjs 0.2.1-rc.1
 *   node scripts/check-peer-range.mjs            # 不给参数就检查本地 .dsh/node_modules 里的真实运行时
 *
 * 为什么单独成文件：自检（selfcheck.mjs）里那段判定是内联的，用不了 `node -e` 一行跑
 * （插件目录下解析不到 `semver`，见 docs/DEVELOPMENT.md）。这个脚本把同一套逻辑抽出来，
 * 供「DSH 发了新版本，我要不要发版」这个具体问题使用。
 *
 * 退出码：0 = 已覆盖（不用发版）；1 = 未覆盖（需要为该版本线追加分支）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// ---- 与 selfcheck.mjs 同源的极简 semver（含 prerelease 语义） ----
const parseVer = (s) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s ?? "");
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] } : null;
};
const cmpPre = (a, b) => {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};
const cmp = (a, b) =>
  a.major !== b.major
    ? a.major < b.major
      ? -1
      : 1
    : a.minor !== b.minor
      ? a.minor < b.minor
        ? -1
        : 1
      : a.patch !== b.patch
        ? a.patch < b.patch
          ? -1
          : 1
        : cmpPre(a.pre, b.pre);
// caret 上界带 `-0`：`^0.1.7-alpha.1` 实际是 `<0.2.0-0`（连 0.2.0 的 prerelease 都不含）。
const caretUpper = (v) =>
  v.major > 0
    ? { major: v.major + 1, minor: 0, patch: 0, pre: [0] }
    : v.minor > 0
      ? { major: 0, minor: v.minor + 1, patch: 0, pre: [0] }
      : { major: 0, minor: 0, patch: v.patch + 1, pre: [0] };
const branchCovers = (branch, ver) => {
  const body = branch.trim().replace(/^[\^~]/, "");
  const lo = parseVer(body);
  if (!lo) return false;
  return cmp(ver, lo) >= 0 && cmp(ver, caretUpper(lo)) < 0;
};

/** 从本地已安装的第一方包反推当前运行时版本。 */
const detectRuntime = () => {
  for (const dir of ["node_modules", path.join("..", "..", "profiles", "node_modules")]) {
    for (const name of ["@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-tools"]) {
      try {
        const p = path.join(root, dir, ...name.split("/"), "package.json");
        return { version: JSON.parse(fs.readFileSync(p, "utf8")).version, from: `${dir}/${name}` };
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
};

const arg = process.argv[2];
let version;
let origin;
if (arg) {
  version = arg;
  origin = "命令行参数";
} else {
  const found = detectRuntime();
  if (!found) {
    console.error("无法自动探测 DSH 版本：本地找不到 @deepseek-ai/dsh-app-boot 或 dsh-tools。");
    console.error("请显式指定，例如：node scripts/check-peer-range.mjs 0.2.1-rc.1");
    process.exit(2);
  }
  version = found.version;
  origin = `本地安装（${found.from}）`;
}

const ver = parseVer(version);
if (!ver) {
  console.error(`"${version}" 不是合法的 semver`);
  process.exit(2);
}

console.log(`包      : ${pkg.name}@${pkg.version}`);
console.log(`DSH 版本: ${version}   （来源：${origin}）`);
console.log("");

let anyMissing = false;
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  const covered = String(range)
    .split("||")
    .some((b) => branchCovers(b, ver));
  console.log(`${covered ? "覆盖  " : "未覆盖"}  ${name}`);
  console.log(`         范围: ${range}`);
  if (!covered) {
    anyMissing = true;
    // 给出可直接粘贴的建议分支：整条线用 `-0` 形式一次覆盖。
    console.log(`         建议: 追加 " || ^${ver.major}.${ver.minor}.0-0"`);
  }
}

console.log("");
if (anyMissing) {
  console.log("=> 需要发版：为该版本线追加 peer 分支后再升级 DSH。");
  console.log("   （注意：追加前先确认新版本线的运行时接口没变，见 docs/DEVELOPMENT.md）");
  process.exit(1);
}
console.log("=> 已覆盖，无需改动。同一条 0.x 线内的新 alpha/rc/正式版都不用跟进。");
