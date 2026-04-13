// ─── Browser Manager ──────────────────────────────────────────────────────────
// Handles browser instance reuse, session management, request queue,
// and memory optimization for Render free tier (512MB limit)

import { chromium, Browser, BrowserContext, Page, Route } from "playwright";
import { config } from "../server";

// ─── Execution Queue (Single Concurrency) ────────────────────────────────────
// Prevents concurrent browser sessions that cause memory spikes

interface QueueItem {
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

class ExecutionQueue {
  private queue: QueueItem[] = [];
  public running = false;

  async add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute: task, resolve, reject });
      console.log(`[Queue] Task added. Pending: ${this.queue.length}`);
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const next = this.queue.shift()!;
    console.log(`[Queue] Executing task. Pending: ${this.queue.length}`);
    try {
      const result = await next.execute();
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      this.running = false;
      console.log(`[Queue] Task complete. Pending: ${this.queue.length}`);
      this.process();
    }
  }

  get pendingCount(): number { return this.queue.length; }
  get isRunning(): boolean { return this.running; }
}

export const executionQueue = new ExecutionQueue();

// ─── Browser Instance (Reused Across Requests) ───────────────────────────────

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserInstance && !browserInstance.isConnected()) {
    console.log("[Browser] Found stale instance — cleaning up");
    browserInstance = null;
    invalidateSession();
  }
  if (browserInstance?.isConnected()) return browserInstance;

  console.log("[Browser] Launching with memory-optimized flags");
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      // Sandbox & security (required for containers)
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Memory reduction
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--disable-notifications",
      "--disable-component-update",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-ipc-flooding-protection",
      // Rendering optimizations
      "--disable-canvas-aa",
      "--disable-2d-canvas-clip-aa",
      "--disable-accelerated-2d-canvas",
      "--disable-web-security",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process",
      // JS engine memory limits
      "--js-flags=--max-old-space-size=256 --max-semi-space-size=2 --gc-interval=100",
      // Media (not needed for form testing)
      "--autoplay-policy=no-user-gesture-required",
      "--disable-hang-monitor",
      "--mute-audio",
      "--no-first-run",
      // Font/image reduction
      "--font-render-hinting=none",
      "--disable-remote-fonts",
    ],
  });

  browserInstance.on("disconnected", () => {
    console.log("[Browser] Disconnected — clearing instance and session");
    browserInstance = null;
    invalidateSession();
  });

  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
    console.log("[Browser] Closed and memory released");
  }
}

export function isBrowserConnected(): boolean {
  return browserInstance?.isConnected() ?? false;
}

// ─── Session Reuse ───────────────────────────────────────────────────────────
// Caches login sessions per username to avoid repeated login overhead

interface CachedSession {
  cookies: any[];
  localStorage: Record<string, string>;
  username: string;
  loginTime: number;
}

const SESSION_TTL = 5 * 60 * 1000; // 5 minutes
let cachedSession: CachedSession | null = null;

export async function saveSession(
  context: BrowserContext,
  username: string
): Promise<void> {
  try {
    const cookies = await context.cookies();
    const pages = context.pages();
    let localStorage: Record<string, string> = {};
    if (pages.length > 0) {
      localStorage = await pages[0].evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key) data[key] = window.localStorage.getItem(key) || "";
        }
        return data;
      }).catch(() => ({}));
    }
    cachedSession = { cookies, localStorage, username, loginTime: Date.now() };
    console.log(`[Session] Saved for ${username} (TTL: ${SESSION_TTL / 1000}s)`);
  } catch (err) {
    console.error(`[Session] Save failed: ${(err as Error).message}`);
  }
}

export async function restoreSession(
  context: BrowserContext,
  username: string
): Promise<boolean> {
  if (
    !cachedSession ||
    cachedSession.username !== username ||
    Date.now() - cachedSession.loginTime > SESSION_TTL
  ) {
    return false;
  }
  try {
    await context.addCookies(cachedSession.cookies);
    console.log(`[Session] Restored for ${username}`);
    return true;
  } catch {
    return false;
  }
}

export function invalidateSession(): void {
  cachedSession = null;
  console.log("[Session] Invalidated");
}

export function getCachedSessionUsername(): string | null {
  return cachedSession?.username ?? null;
}

// ─── Resource Blocking ───────────────────────────────────────────────────────
// Blocks images, fonts, and media to reduce memory and speed up page loads

export async function blockResources(page: Page): Promise<void> {
  await page.route("**/*", (route: Route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

// ─── Context Helper ──────────────────────────────────────────────────────────

export async function safeClose(context: BrowserContext | null): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
  }
}
