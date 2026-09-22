/**
 * 本地 ffmpeg 转 GIF（两遍调色板法，画质明显优于单遍）。
 *
 * 纯本地转换，不走 Agnes 接口、不额外计费。
 *
 * 注意：某些沙箱禁止 Node 通过管道捕获子进程输出（spawn/spawnSync 默认
 * stdio 'pipe' 会报 EPERM），所以这里一律用 stdio 'inherit'/'ignore'
 * 直接继承父进程句柄，不捕获输出。代价是出错时只能报告退出码。
 *
 * @module dsh-agnes-gen/lib/gif
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 运行 ffmpeg，静默横幅与统计输出。 */
function runFfmpeg(ffmpeg, args) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new Error(`未找到可执行文件: ${ffmpeg}`);
    throw new Error(`执行 ${ffmpeg} 失败: ${r.error.code ?? r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`${ffmpeg} 退出码 ${r.status}，GIF 转换失败`);
}

/**
 * 解析 ffmpeg 可执行文件，并说明来源。
 *
 * 顺序：显式配置 → `PATH` 里的 `ffmpeg`。
 * 显式配置失败时会继续回落（保证转码仍可用），但把失败原因一并带回，
 * 让诊断能说清「你填的路径没用上，实际用的是这个」。
 *
 * @param {string} [explicit] 显式配置的路径
 * @returns {{cmd: string, source: string, explicitError: string}}
 * @throws {Error} 两者都不可用时
 */
export function resolveFfmpeg(explicit) {
  const configured = typeof explicit === "string" ? explicit.trim() : "";
  const attempts = [
    ...(configured ? [{ cmd: configured, source: "配置" }] : []),
    { cmd: "ffmpeg", source: "PATH" },
  ];

  let explicitError = "";
  for (const { cmd, source } of attempts) {
    const probe = spawnSync(cmd, ["-version"], { stdio: "ignore" });
    if (!probe.error) return { cmd, source, explicitError };
    if (probe.error.code === "ENOENT") {
      // 用户填的路径不存在：记下来，但继续尝试后面的来源。
      if (source === "配置") explicitError = `${source}指定的 ${cmd} 不存在（ENOENT）`;
      continue;
    }
    // 存在但受限（例如沙箱 EPERM）：交给实际调用报错，不再找下一个。
    return { cmd, source, explicitError };
  }
  throw new Error("未找到 ffmpeg，请安装并加入 PATH，或用 ffmpegPath 配置指定路径");
}

/** 定位 ffmpeg 可执行文件，只返回命令名。 */
export function ffmpegPath(explicit) {
  return resolveFfmpeg(explicit).cmd;
}

/**
 * 探测本机 ffmpeg 是否可用——供 Web 配置页的「检测」按钮调用。
 *
 * 这里的探测必须**不抛错**：它是诊断入口，结果本身就是返回值。
 * 探测分两步：先确认可执行文件能启动，再确认它真的是 ffmpeg（而不是
 * 一个恰好叫 ffmpeg 的其他程序）——`-version` 的首行形如 `ffmpeg version 7.1`。
 *
 * 某些沙箱禁止 Node 通过管道捕获子进程输出（spawnSync 默认 stdio 'pipe'
 * 报 EPERM）。那种情况下退化为「带 stdio 'ignore' 跑一次 -version，看退出码」，
 * 仍能确认它可执行且正常退出，只是读不到版本号。
 *
 * @param {string} [explicit] 显式配置的 ffmpeg 路径
 * @returns {{ok: boolean, path: string, version: string, source: string, error: string, hint: string}}
 */
export function ffmpegInfo(explicit) {
  const configured = typeof explicit === "string" ? explicit.trim() : "";

  let resolved;
  try {
    resolved = resolveFfmpeg(configured || undefined);
  } catch (err) {
    return {
      ok: false,
      path: configured,
      version: "",
      source: configured ? "配置" : "PATH",
      error: err.message,
      hint: "安装 ffmpeg 并加入 PATH，或在 ffmpegPath 配置项填入可执行文件的绝对路径。",
    };
  }
  const { cmd, source, explicitError } = resolved;

  const probe = spawnSync(cmd, ["-version"], { encoding: "utf8" });

  // 沙箱禁止捕获输出：退回只看退出码，仍能证明「可执行且正常退出」。
  if (probe.error?.code === "EPERM") {
    const run = spawnSync(cmd, ["-version"], { stdio: "ignore" });
    if (run.error) {
      return { ok: false, path: cmd, version: "", source, error: `执行 ${cmd} 失败: ${run.error.code ?? run.error.message}`, hint: "确认该路径是可执行文件。" };
    }
    const ok = run.status === 0;
    return {
      ok,
      path: cmd,
      version: "",
      source,
      error: ok ? explicitError : `${cmd} -version 退出码 ${run.status}`,
      hint: ok
        ? explicitError
          ? `已回落到 ${source} 的 ffmpeg；如要使用配置的路径请修正它。当前沙箱禁止捕获子进程输出，因此读不到版本号。`
          : "当前沙箱禁止捕获子进程输出，无法读取版本号；可执行文件本身正常。"
        : "该文件可能不是 ffmpeg，或已损坏。",
    };
  }
  if (probe.error) {
    return { ok: false, path: cmd, version: "", source, error: `执行 ${cmd} 失败: ${probe.error.code ?? probe.error.message}`, hint: "确认该路径是可执行文件，且当前用户有执行权限。" };
  }
  if (probe.status !== 0) {
    return { ok: false, path: cmd, version: "", source, error: `${cmd} -version 退出码 ${probe.status}`, hint: "该文件可能不是 ffmpeg，或已损坏。" };
  }

  const firstLine = String(probe.stdout || "").split(/\r?\n/)[0] ?? "";
  if (!/^ffmpeg version/i.test(firstLine.trim())) {
    return { ok: false, path: cmd, version: "", source, error: `输出不像 ffmpeg: ${firstLine.slice(0, 120)}`, hint: "该路径可能指向了另一个同名程序；请填入真正的 ffmpeg。" };
  }

  return {
    ok: true,
    path: cmd,
    version: firstLine.replace(/^ffmpeg version\s*/i, "").trim(),
    source,
    // 显式配置失效但回落到别处成功时，把原因说清楚。
    error: explicitError,
    hint: explicitError ? `已回落到 ${source} 的 ffmpeg；如要使用配置的路径请修正它。` : "",
  };
}

/**
 * 把 mp4 转成 GIF。
 *
 * @param {string} mp4
 * @param {string} gifPath
 * @param {{gifWidth?: number, gifFps?: number, gifStart?: number|null, gifDuration?: number|null, gifColors?: number, ffmpeg?: string}} opt
 * @param {(msg: string) => void} [log]
 */
export function toGif(mp4, gifPath, opt = {}, log = () => {}) {
  const ffmpeg = ffmpegPath(opt.ffmpeg);
  const width = opt.gifWidth ?? 480;
  const fps = opt.gifFps ?? 12;
  const colors = opt.gifColors ?? 256;

  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const trim = [];
  if (opt.gifStart !== null && opt.gifStart !== undefined) trim.push("-ss", String(opt.gifStart));
  if (opt.gifDuration !== null && opt.gifDuration !== undefined) trim.push("-t", String(opt.gifDuration));

  const palette = path.join(path.dirname(gifPath), `.palette-${path.basename(gifPath, ".gif")}.png`);
  log(`转换 GIF（${width}px / ${fps}fps）...`);
  try {
    // -frames:v 1：palettegen 只输出一张调色板图，否则 ffmpeg 会警告缺少序列模式。
    runFfmpeg(ffmpeg, [
      ...trim, "-i", mp4,
      "-vf", `${vf},palettegen=max_colors=${colors}:stats_mode=diff`,
      "-frames:v", "1", palette,
    ]);
    runFfmpeg(ffmpeg, [
      ...trim, "-i", mp4, "-i", palette,
      "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      "-loop", "0", gifPath,
    ]);
  } finally {
    try {
      fs.unlinkSync(palette);
    } catch {
      /* ignore */
    }
  }
  return { file: gifPath, bytes: fs.statSync(gifPath).size };
}
