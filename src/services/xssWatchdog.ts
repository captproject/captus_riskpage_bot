// ─────────────────────────────────────────────────────────────────────────────
// xssWatchdog.ts
// SEC-11 helper: installs page listeners that detect XSS execution in real time.
//
// Three signals indicate the payload actually ran (not just got stored):
//   1. dialog event   — alert(), confirm(), prompt() opens a native dialog
//   2. pageerror      — uncaught JS exception when our payload runs
//   3. console error  — sometimes injected JS logs an error
//
// The watchdog accumulates events. After each create/view cycle, the caller
// can read .events to see what fired during that window.
// ─────────────────────────────────────────────────────────────────────────────

import { Page } from "playwright";

export interface XssEvent {
  type: "dialog" | "pageerror" | "console";
  message: string;
  url: string;
  timestamp: number;
}

export class XssWatchdog {
  private events: XssEvent[] = [];
  private installed = false;

  install(page: Page): void {
    if (this.installed) return;
    this.installed = true;

    // ── dialog: alert(), confirm(), prompt() ──
    page.on("dialog", async (dialog) => {
      this.events.push({
        type: "dialog",
        message: `${dialog.type()}: ${dialog.message()}`,
        url: page.url(),
        timestamp: Date.now(),
      });
      // Critical: dismiss the dialog or Playwright will hang
      await dialog.dismiss().catch(() => {});
    });

    // ── pageerror: uncaught JS exception in the page ──
    page.on("pageerror", (err) => {
      this.events.push({
        type: "pageerror",
        message: err.message,
        url: page.url(),
        timestamp: Date.now(),
      });
    });

    // ── console error/warn ──
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        const text = msg.text();
        // Only capture script-execution-related messages, not network noise
        if (/script|eval|inject|onerror|javascript:/i.test(text)) {
          this.events.push({
            type: "console",
            message: text,
            url: page.url(),
            timestamp: Date.now(),
          });
        }
      }
    });
  }

  /** Get events captured since the last clear() call. */
  drain(): XssEvent[] {
    const out = [...this.events];
    this.events = [];
    return out;
  }

  /** Any signal at all? */
  hasFired(): boolean {
    return this.events.length > 0;
  }
}
