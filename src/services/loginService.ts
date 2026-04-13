// ─── Login Service ────────────────────────────────────────────────────────────
// Shared login logic used by all route handlers

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { getBrowser, saveSession, restoreSession, blockResources } from "./browserManager";

export async function createContextAndLogin(
  username: string,
  password: string
): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(config.navigationTimeout);

  const page = await context.newPage();
  await blockResources(page);

  // Try session restore first
  const restored = await restoreSession(context, username);
  if (restored) {
    console.log(`[Login] Trying cached session for ${username}`);
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (!currentUrl.includes("/login")) {
      console.log(`[Login] Session restore successful — at ${currentUrl}`);

      // Handle company selection if needed
      await handleCompanySelection(page);
      return { context, page };
    }
    console.log("[Login] Session expired — doing fresh login");
  }

  // Fresh login
  console.log(`[Login] Navigating to login page for ${username}`);
  await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(1000);

  // Fill credentials
  const emailField = page.locator('input[name="email"], input[type="email"]');
  await emailField.waitFor({ state: "visible", timeout: 10_000 });
  await emailField.fill(username);

  const passwordField = page.locator('input[name="password"], input[type="password"]');
  await passwordField.waitFor({ state: "visible", timeout: 5_000 });
  await passwordField.fill(password);

  // Click login
  const loginButton = page.locator('button[type="submit"]');
  await loginButton.click();

  // Wait for navigation
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle").catch(() => {});

  const afterLoginUrl = page.url();
  if (afterLoginUrl.includes("/login")) {
    throw new Error("Login failed — still on login page after submit");
  }

  console.log(`[Login] Success — at ${afterLoginUrl}`);
  await saveSession(context, username);

  // Handle company selection
  await handleCompanySelection(page);

  return { context, page };
}

async function handleCompanySelection(page: Page): Promise<void> {
  try {
    // Check if company selection dialog appears
    const companySelector = page.locator('[data-testid="select-company"], [role="dialog"]');
    const visible = await companySelector.isVisible().catch(() => false);
    if (visible) {
      console.log("[Login] Company selection dialog detected");
      // Click first company option
      const firstOption = page.locator('[data-testid^="company-option-"], [role="option"]').first();
      const optionVisible = await firstOption.isVisible().catch(() => false);
      if (optionVisible) {
        await firstOption.click();
        await page.waitForTimeout(2000);
        console.log("[Login] Company selected");
      }
    }
  } catch {
    // No company selection needed
  }
}
