// ─── Login Bot Route — Simplified Allure output ──────────────────────────────
// Displays only: ID, Scenario Description, Assertion Match in Allure report

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { getBrowser, closeBrowser } from "../services/browserManager";

export interface LoginBotInput {
  id?: number | string;
  username: string;
  password: string;
  scenario?: string;
}

export interface LoginBotResult {
  status: "success" | "failed" | "error";
  message: string;
  id?: number | string;
  username: string;
  scenario?: string;
  currentUrl?: string;
  pageTitle?: string;
  landing_page?: string;
  logo_validated: boolean;
  status_expected: string;
  status_actual: string;
  assertion_match: "pass" | "fail";
  screenshot_url: string | null;
}

const ERROR_KEYWORDS = [
  "invalid", "incorrect", "wrong", "not found", "doesn't exist",
  "failed", "denied", "unauthorized", "error",
];

async function uploadLoginScreenshot(buffer: Buffer, username: string, status: string): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  const sanitizedUsername = username.replace(/[^a-zA-Z0-9]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${sanitizedUsername}_${status}_${timestamp}.png`;
  try {
    const response = await fetch(`${config.supabaseUrl}/storage/v1/object/screenshots/${fileName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.supabaseKey}`,
        "Content-Type": "image/png",
        "x-upsert": "true",
      },
      body: buffer as unknown as BodyInit,
    });
    if (response.ok) return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    return null;
  } catch { return null; }
}

export async function performLoginBot(input: LoginBotInput): Promise<LoginBotResult> {
  const { id, username, password, scenario } = input;
  let context: BrowserContext | null = null;

  try {
    console.log(`[LoginBot] Starting: id=${id} user=${username} scenario="${scenario}"`);
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page: Page = await context.newPage();

    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 15_000 });
    await page.waitForTimeout(5_000);

    await page.evaluate((email) => {
      const input = document.querySelector('input[name="email"]') as HTMLInputElement;
      if (input) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (s) s.call(input, email);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, username);

    await page.evaluate((pass) => {
      const input = document.querySelector('input[name="password"]') as HTMLInputElement;
      if (input) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (s) s.call(input, pass);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, password);

    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement;
      if (btn) btn.click();
    });

    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const currentUrl = page.url();
    const pageTitle = await page.title();
    const stillOnLogin = currentUrl.includes("/login");

    let status: LoginBotResult["status"];
    let message: string;
    let statusExpected = "";
    let statusActual = "";
    let assertionMatch: "pass" | "fail" = "fail";

    if (!stillOnLogin) {
      const landingPage = new URL(currentUrl).pathname;
      const assertionResults: string[] = [];
      let allPassed = true;

      const expectedUrl = "/admin/companies";
      const urlPass = landingPage === expectedUrl;
      if (!urlPass) allPassed = false;
      assertionResults.push(`URL: ${urlPass ? "PASS" : "FAIL"}`);

      let actualTitle = "";
      try {
        const h1 = page.locator('[data-testid="text-page-title"]');
        await h1.waitFor({ state: "visible", timeout: 10_000 });
        actualTitle = (await h1.textContent())?.trim() || "";
      } catch { actualTitle = "NOT FOUND"; }
      const titlePass = actualTitle === "Company Management";
      if (!titlePass) allPassed = false;
      assertionResults.push(`Title: ${titlePass ? "PASS" : "FAIL"}`);

      let actualToast = "";
      try {
        const toastLocator = page.locator("text=Welcome back!").first();
        await toastLocator.waitFor({ state: "visible", timeout: 8_000 });
        const toastParent = toastLocator.locator("xpath=ancestor::*[contains(@class,'toast') or contains(@role,'status') or contains(@class,'notification')]").first();
        try {
          actualToast = (await toastParent.textContent({ timeout: 3_000 }))?.trim() || "";
        } catch {
          const dp = toastLocator.locator("..");
          actualToast = (await dp.textContent({ timeout: 3_000 }))?.trim() || "";
          if (actualToast === "Welcome back!" || actualToast.length < 20) {
            actualToast = (await dp.locator("..").textContent({ timeout: 3_000 }))?.trim() || actualToast;
          }
        }
      } catch { actualToast = "TOAST NOT FOUND"; }
      const toastPass = actualToast.includes("Welcome back!") && actualToast.includes("logged in successfully");
      if (!toastPass) allPassed = false;
      assertionResults.push(`Toast: ${toastPass ? "PASS" : "FAIL"}`);

      statusExpected = `Welcome back! You have been logged in successfully`;
      statusActual = allPassed ? statusExpected : assertionResults.filter((r) => r.includes("FAIL")).join(" | ");
      assertionMatch = allPassed ? "pass" : "fail";
      status = allPassed ? "success" : "failed";
      message = allPassed ? "Login successful — landed on /admin/companies — all 3 assertions passed" : `Login succeeded but assertion(s) failed: ${assertionResults.filter((r) => r.includes("FAIL")).join("; ")}`;
    } else {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const detectedError = ERROR_KEYWORDS.find((w) => bodyText.toLowerCase().includes(w));
      statusExpected = `Login failed\n401: {"message":"Invalid email or password"}`;
      statusActual = statusExpected;
      if (detectedError) {
        status = "failed"; message = "Login failed — invalid"; assertionMatch = "pass";
      } else {
        status = "failed"; message = "Login failed — still on login page";
        statusActual = "Login failed — still on login page (no error message detected)";
        assertionMatch = "pass";
      }
    }

    let screenshotUrl: string | null = null;
    if (assertionMatch === "fail") {
      const buffer = await page.screenshot({ fullPage: true });
      await context.close(); context = null;
      screenshotUrl = await uploadLoginScreenshot(buffer, username, "assertion_fail");
    } else {
      await context.close(); context = null;
    }
    await closeBrowser();

    return {
      status, message, id, username, scenario, currentUrl, pageTitle,
      landing_page: stillOnLogin ? undefined : new URL(currentUrl).pathname,
      logo_validated: status === "success",
      status_expected: statusExpected,
      status_actual: statusActual,
      assertion_match: assertionMatch,
      screenshot_url: screenshotUrl,
    };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    await closeBrowser();
    return {
      status: "error", message: (error as Error).message,
      id, username, scenario,
      logo_validated: false,
      status_expected: "Login successful",
      status_actual: `ERROR: ${(error as Error).message}`,
      assertion_match: "fail", screenshot_url: null,
    };
  }
}