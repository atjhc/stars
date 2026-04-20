// Automated perf bench. Spawns the dev server, launches headless
// Chrome (system Chrome via puppeteer-core — no bundled chromium
// download), navigates to ?bench=1, waits for the deterministic
// trajectory to finish, and prints the resulting summary.
//
// Usage:
//   bun run bench            → sample current working tree
//   bun run bench --compare  → sample current, stash, sample baseline,
//                              pop stash, print delta table

import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { spawn, type Subprocess } from "bun";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 3030;
const URL = `http://localhost:${PORT}/?bench=1`;

interface Summary {
  frames: number;
  seconds: number;
  fps_avg: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(250);
  }
  throw new Error(`dev server did not come up on port ${PORT} in 15s`);
}

async function startServer(): Promise<Subprocess> {
  const proc = spawn({
    cmd: ["bun", "server.ts"],
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
  return proc;
}

async function benchOnce(browser: Browser, label: string): Promise<Summary> {
  const page: Page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
    await page.waitForFunction("window.__benchDone === true", { timeout: 60_000 });
    const summary = (await page.evaluate("window.__benchResults")) as Summary;
    console.log(`[${label}] ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    await page.close();
  }
}

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  const d = ((a - b) / b) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}

function printCompare(baseline: Summary, current: Summary) {
  const fields: Array<keyof Summary> = [
    "fps_avg", "mean_ms", "p50_ms", "p95_ms", "p99_ms", "min_ms", "max_ms",
  ];
  console.log("\n=== baseline vs current ===");
  console.log(
    `${"metric".padEnd(10)} ${"baseline".padStart(10)} ${"current".padStart(10)} ${"delta".padStart(8)}`,
  );
  for (const k of fields) {
    const b = baseline[k];
    const c = current[k];
    // For ms metrics lower is better; fps higher is better.
    const d = k === "fps_avg" ? pct(c, b) : pct(b, c);
    console.log(
      `${String(k).padEnd(10)} ${String(b).padStart(10)} ${String(c).padStart(10)} ${d.padStart(8)}`,
    );
  }
}

async function sh(cmd: string[]): Promise<{ stdout: string; code: number }> {
  const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

async function main() {
  const compare = process.argv.includes("--compare");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    if (!compare) {
      await benchOnce(browser, "current");
      return;
    }

    const current = await benchOnce(browser, "current");

    const hasChanges = (await sh(["git", "diff", "--quiet"])).code !== 0
      || (await sh(["git", "diff", "--cached", "--quiet"])).code !== 0;
    if (!hasChanges) {
      console.log("No uncommitted changes — can't stash for baseline comparison.");
      console.log("Commit or revert first, or run without --compare.");
      return;
    }

    console.log("Stashing uncommitted changes for baseline run…");
    const stash = await sh(["git", "stash", "push", "-u", "-m", "bench-auto-stash"]);
    if (stash.code !== 0) throw new Error("git stash failed");

    try {
      const baseline = await benchOnce(browser, "baseline");
      printCompare(baseline, current);
    } finally {
      console.log("Restoring stashed changes…");
      await sh(["git", "stash", "pop"]);
    }
  } finally {
    await browser.close();
    server.kill();
    await server.exited;
  }
}

await main();
