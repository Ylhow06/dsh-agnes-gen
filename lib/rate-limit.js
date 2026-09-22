/**
 * Agnes API 跨进程滑动窗口限流器。
 *
 * Agnes 不公布 RPS，只公布 RPM（每分钟请求数），且「实际 RPM」低于「允许发起 RPM」。
 * 免费/默认（free/default）密钥的公开参考值见 FREE_RPM。
 *
 * 为什么用状态文件而不是各请求自己 sleep：
 *   Agnes 的限制按「密钥类型」共享，不按单个 key 计算。同一个 Host 进程里
 *   可能并发跑多个工具调用（甚至多个 session），各算各的必然合计超限。
 *   这里用一个滑动窗口状态文件做跨进程、跨 session 协调。
 *
 * 状态目录：$AGNES_RATELIMIT_DIR，默认 <os.tmpdir()>/agnes-ratelimit。
 *   注意 os.tmpdir() 在部分沙箱下是「会话级」临时目录，因此限流默认是
 *   「同会话内」生效；需要跨会话协调时把 AGNES_RATELIMIT_DIR 指到共享可写目录。
 *   若该目录不可写，限流自动退化为不限流（fail-open），避免把请求卡死。
 *
 * @module dsh-agnes-gen/lib/rate-limit
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sleep } from "./util.js";

const WINDOW_MS = 60_000;
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 120_000;

/** 免费/默认密钥的「实际 RPM」公开参考值（来源：Agnes Token Plan FAQ）。 */
export const FREE_RPM = {
  text: 20,
  image: { "1K": 20, "2K": 10, "3K": 1, "4K": 1 },
  video: 1,
};

/** Token Plan 密钥的「实际 RPM」，供 rpm 覆盖时参考。 */
export const TOKEN_PLAN_RPM = {
  text: 1000,
  image: { "1K": 100, "2K": 80, "3K": 1, "4K": 1 },
  video: 5,
};

// Atomics.wait 在 Node 主线程可用，用于锁自旋时的同步小睡。
const sab = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sab, 0, 0, ms);
}

function stateDir() {
  return process.env.AGNES_RATELIMIT_DIR || path.join(os.tmpdir(), "agnes-ratelimit");
}

function stateFile(bucket) {
  return path.join(stateDir(), `bucket-${bucket.replace(/[^\w.-]/g, "_")}.json`);
}

function readTimes(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(arr)) return arr.filter((t) => typeof t === "number");
  } catch {
    /* 文件不存在或损坏都当作空窗口 */
  }
  return [];
}

/**
 * 持锁状态下完成「判定 + 记账」。
 * 返回 0 表示已占到配额；否则返回需要等待的毫秒数。
 */
function tryTake(file, limit) {
  const now = Date.now();
  const times = readTimes(file).filter((t) => now - t < WINDOW_MS);
  if (times.length < limit) {
    times.push(now);
    fs.writeFileSync(file, JSON.stringify(times));
    return 0;
  }
  fs.writeFileSync(file, JSON.stringify(times)); // 顺手把过期记录写回去
  return WINDOW_MS - (now - Math.min(...times)) + 50;
}

/**
 * 用 wx 独占创建锁文件实现跨进程互斥。
 * 持锁期间不 await，保证临界区同步完成——否则锁会被其他进程抢走。
 */
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let owned = false;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      owned = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        /* 锁刚被对方释放，重试即可 */
      }
      // 超时后仍然执行 fn()（fail-open），但不持有锁，因此绝不能去删别人的锁。
      if (Date.now() > deadline) break;
      await sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    if (owned) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 申请一次请求配额。limit <= 0 或状态目录不可写时直接放行。
 *
 * @param {string} bucket 配额池名（同一接口的所有档位共用一个池，取最保守口径）
 * @param {number} limit  该池每分钟允许的请求数
 * @param {{label?: string, quiet?: boolean, signal?: AbortSignal, log?: (msg: string) => void}} [options]
 */
export async function acquire(bucket, limit, { label = "agnes", quiet = false, signal, log } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const file = stateFile(bucket);
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.accessSync(stateDir(), fs.constants.W_OK);
  } catch {
    return; // fail-open：状态目录不可写时宁可放开，也不要把请求卡死
  }
  for (;;) {
    if (signal?.aborted) return;
    const wait = await withLock(file, () => tryTake(file, limit));
    if (wait === 0) return;
    const note = `[${label}] 限流：${bucket} 已达 ${limit} RPM，等待 ${(wait / 1000).toFixed(1)}s`;
    if (log) log(note);
    else if (!quiet) process.stderr.write(`${note}\n`);
    await sleep(wait, signal);
  }
}

export { sleepSync, WINDOW_MS };
