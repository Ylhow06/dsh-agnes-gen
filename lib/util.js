/**
 * 通用小工具：时间戳、文件名 slug、本地文件 → Data URI、目录创建。
 *
 * @module dsh-agnes-gen/lib/util
 */

import fs from "node:fs";
import path from "node:path";

/** 生成用于文件名的时间戳，例如 2026-09-21T13-59-42。 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** 把任意文本压成安全的文件名片段（保留 Unicode 字母与数字）。 */
export function slug(text, max = 40, fallback = "output") {
  const s = String(text ?? "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return (s || fallback).slice(0, max);
}

/**
 * 把调用方给的自定义文件名主名清洗成一个**安全的文件名基名**。
 *
 * 只允许字母、数字、`-`、`_`，去掉路径分隔符与一切能越级/危险字符
 * （`/`、`\`、`..`、冒号等），并砍到上限长度。返回的是**不带扩展名**的基名；
 * 扩展名由插件按实际输出补。空值返回空串（表示没提供自定义名）。
 *
 * Windows 与 Unix 的保留名（NUL、CON 等）也要避开，避免生成不可用的文件。
 *
 * @param {string} [value] 调用方想用的文件名主名
 * @param {number} [max]   基名最大长度
 * @returns {string} 清洗后的安全基名，空输入为 ""
 */
export function safeBaseName(value, max = 60) {
  if (!value || !String(value).trim()) return "";
  const cleaned = String(value)
    .replace(/[\/\\:*?"<>|]/g, "") // 路径分隔符与 Windows 非法字符
    .replace(/[\u0000-\u001f]/g, "") // 控制符
    .replace(/\.+$/g, "") // 尾部点（Windows 会吞）
    .replace(/\s+/g, "-") // 空白 -> 连字符
    .trim()
    .slice(0, max);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned);
  if (!cleaned || reserved) return "";
  return cleaned;
}

/** 猜一个图片 MIME 子类型。 */
function imageMime(file) {
  const ext = path.extname(file).slice(1).toLowerCase() || "png";
  return ext === "jpg" ? "jpeg" : ext;
}

/**
 * 把素材引用转成 API 可接受的字符串：
 * 公网 URL / data: 原样返回，本地路径读成 Data URI。
 *
 * @param {string} ref 本地路径或 URL
 * @param {string} cwd 相对路径的解析基准
 */
export function toDataUri(ref, cwd = process.cwd()) {
  const value = String(ref ?? "").trim();
  if (!value) throw new Error("素材引用为空");
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  const abs = path.resolve(cwd, value);
  if (!fs.existsSync(abs)) throw new Error(`素材文件不存在: ${abs}`);
  return `data:image/${imageMime(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
}

/**
 * 确保输出目录存在。失败时给出可操作提示——插件在 Host 进程里运行，
 * 默认工作目录未必可写，这一点和 CLI 版本一样。
 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    throw new Error(
      `无法创建输出目录: ${dir}（${err.code}）。\n` +
        `请联系操作者在插件配置里设置 outDir，或设置环境变量 AGNES_OUT_DIR，或用可写的工作目录。`,
    );
  }
}

/**
 * 把调用方的取消信号与一个超时合成为一个新的信号。
 * 返回的 dispose() 必须在 finally 中调用，避免监听器与定时器泄漏。
 */
export function withTimeout(signal, ms) {
  const ac = new AbortController();
  const abort = (reason) => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  if (signal) {
    if (signal.aborted) abort(signal.reason);
    else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => abort(new Error(`请求超时（${Math.round(ms / 1000)}s）`)), ms) : null;
  if (timer?.unref) timer.unref();
  return {
    signal: ac.signal,
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

/** 可取消的 sleep；中断时不抛错，由调用方自行检查信号。 */
export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
