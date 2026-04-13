// ─── Login Service ────────────────────────────────────────────────────────────
// Shared login logic used by all route handlers.
// Matches the exact flow from the proven old server.ts:
// Login → Company Selection → Dashboard navigation

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import {
  getBrowser,
  saveSession,
  restoreSession,
  invalidateSession,
} from "./browserManager";

// ─── Resource Blocking (on context, not page) ────────────────────────────────

async function enableResourceBlocking(context: BrowserContext): Promise<void> {
  const BLOCKED_RESOURCE_TYPES = ["image", "media", "font"];
  const BLOCKED_URL_PATTERNS = [
    "google-analytics.com", "googletagmanager.com", "facebook.net",
    "hotjar.com", "intercom.io", "sentry.io", "mixpanel.com",
    "segment.io", "amplitude.com", "clarity.ms",
    "cdn.gpteng.co", "replit-cdn.com",
  ];

  await context.route("**/*", (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();
    if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) { route.abort().catch(() => {}); return; }
    if (BLOCKED_URL_PATTERNS.some((p) => url.includes(p))) { route.abort().catch(() => {}); return; }
    route.continue().catch(() => {});
  });
  console.log("[Resources] Blocking images, fonts, media, and trackers");
}

// ─── Company Selection ───────────────────────────────────────────────────────

async function selectCompany(page: Page, companyName = "demo"): Promise<boolean> {
  try {
    console.log(`[Company] Selecting company: "${companyName}"`);
    const companyBtn = page.getByTestId("button-company-selector");
    await companyBtn.waitFor({ state: "visible", timeout: 10_000 });
    await companyBtn.click();
    await page.locator('[role="menuitem"]').first().waitFor({ state: "visible", timeout: 5_000 });
    const companyOption = page.locator('[role="menuitem"]').filter({ hasText: companyName }).first();
    await companyOption.waitFor({ state: "visible", timeout: 5_000 });
    await companyOption.click();
    await page.waitForTimeout(2_000);
    console.log(`[Company] Selected "${companyName}" successfully`);
    return true;
  } catch (err) {
    console.log(`[Company] Failed to select "${companyName}": ${(err as Error).message}`);
    return false;
  }
}

// ─── Core Login (with retry) ─────────────────────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });

      const emailInput = page.locator('input[name="email"]');
      await emailInput.waitFor({ state: "visible", timeout: 15_000 });
      await emailInput.fill(username);

      const passwordInput = page.locator('input[name="password"]');
      await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
      await passwordInput.fill(password);

      const loginBtn = page.getByTestId("button-login");
      await loginBtn.waitFor({ state: "visible", timeout: 5_000 });
      await loginBtn.click();

      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});

      const loggedIn = !page.url().includes("/login");
      console.log(`[Login] ${loggedIn ? "Success" : "Failed"} — URL: ${page.url()}`);
      if (!loggedIn) throw new Error("Login failed — still on /login page");
      return true;
    } catch (err) {
      console.log(`[Login] Attempt ${attempt}/${maxAttempts} failed: ${(err as Error).message}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

// ─── Login With Session (Main Entry Point) ───────────────────────────────────

export async function createContextAndLogin(
  username: string,
  password: string
): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  context.setDefaultTimeout(config.navigationTimeout);

  // Enable resource blocking on context (same as old server.ts)
  await enableResourceBlocking(context);

  const page = await context.newPage();

  // Try session restore first
  const restored = await restoreSession(context, username);
  if (restored) {
    try {
      await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
      await page.waitForTimeout(1_500);

      const onLogin = page.url().includes("/login");
      if (!onLogin) {
        // Check if company is selected
        const companyBtn = page.getByTestId("button-company-selector");
        const btnText = await companyBtn.textContent().catch(() => "");
        if (btnText?.includes("All Companies")) {
          console.log("[Session] Company not selected — selecting demo");
          await selectCompany(page, "demo");
        }
        console.log(`[Session] Reused session for ${username} — skipped login`);
        return { context, page };
      }
      console.log("[Session] Session expired — falling back to login");
      invalidateSession();
    } catch {
      console.log("[Session] Restore navigation failed — falling back to login");
      invalidateSession();
    }
  }

  // Fresh login
  const loggedIn = await performLogin(page, username, password);
  if (!loggedIn) {
    throw new Error("Login failed after all retry attempts");
  }

  // Post-login: select company (critical step — old bot does this)
  console.log(`[Login] Post-login URL: ${page.url()}`);
  const companySelected = await selectCompany(page, "demo");
  // Post-login: select project
    try {
      console.log('[Project] Selecting project: "Test"');
      const projectBtn = page.getByTestId("button-project-selector");
      await projectBtn.waitFor({ state: "visible", timeout: 10_000 });
      await projectBtn.click();
      await page.locator('[role="menuitem"]').first().waitFor({ state: "visible", timeout: 5_000 });
      const projectOption = page.locator('[role="menuitem"]').filter({ hasText: "Test" }).first();
      await projectOption.waitFor({ state: "visible", timeout: 5_000 });
      await projectOption.click();
      await page.waitForTimeout(2_000);
      console.log('[Project] Selected "Test" successfully');
    } catch (err) {
      console.log(`[Project] Failed to select: ${(err as Error).message}`);
    }
  if (!companySelected) {
    console.log("[Login] WARNING: Could not select company — proceeding anyway");
  }

  // Save session for reuse
  await saveSession(context, username);

  return { context, page };
}