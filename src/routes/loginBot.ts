// ─── Login Bot Route — matches old login-v2 endpoint exactly ──────────────────
// Used by 01B_Login_Bot n8n workflow.
// Reads credentials from Supabase SignIn_Task table, attempts login,
// runs 3 assertions for successful logins, returns structured result.
//
// 3 Assertions after successful login:
//   1. URL: must be /admin/companies
//   2. Page Title (h1): must be "Company Management"
//   3. Toast: must contain "Welcome back!" + "logged in successfully"
//
// For failed logins (invalid credentials) — captures screenshot of error state.

import { BrowserContext, Page } from "playwright";
import { config } from "../server";
import { getBrowser, closeBrowser } from "../services/browserManager";
import { uploadScreenshot } from "../utils/screenshot";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LoginBotInput {
  username: string;
  password: string;
}

export interface LoginBotResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
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

// ─── Custom screenshot upload (matches old login bot naming convention) ──────

async function uploadLoginScreenshot(
  buffer: Buffer,
  username: string,
  status: string
): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) return null;

  const sanitizedUsername = username.replace(/[^a-zA-Z0-9]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${sanitizedUsername}_${status}_${timestamp}.png`;

  try {
    const response = await fetch(
      `${config.supabaseUrl}/storage/v1/object/screenshots/${fileName}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.supabaseKey}`,
          "Content-Type": "image/png",
          "x-upsert": "true",
        },
        body: buffer as unknown as BodyInit,
      }
    );

    if (response.ok) {
      return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    }
    console.error(`[Login] Screenshot upload failed: ${await response.text()}`);
    return null;
  } catch (err) {
    console.error(`[Login] Screenshot upload error: ${(err as Error).message}`);
    return null;
  }
}

// ─── Main Login Bot Function ─────────────────────────────────────────────────

export async function performLoginBot(input: LoginBotInput): Promise<LoginBotResult> {
  const { username, password } = input;
  let context: BrowserContext | null = null;

  try {
    console.log(`[LoginBot] Starting login attempt for: ${username}`);
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    context.setDefaultTimeout(config.navigationTimeout);

    const page: Page = await context.newPage();

    // ── Step 1: Navigate to login page ───────────────────────────────────
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });

    await page.waitForSelector('input[name="email"]', {
      state: "visible",
      timeout: 15_000,
    });

    await page.waitForTimeout(5_000);

    // ── Step 2: Fill email (using native value setter for React compatibility)
    await page.evaluate((email) => {
      const input = document.querySelector('input[name="email"]') as HTMLInputElement;
      if (input) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) nativeSetter.call(input, email);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, username);

    // ── Step 3: Fill password ────────────────────────────────────────────
    await page.evaluate((pass) => {
      const input = document.querySelector('input[name="password"]') as HTMLInputElement;
      if (input) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) nativeSetter.call(input, pass);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, password);

    // ── Step 4: Click login button ───────────────────────────────────────
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement;
      if (btn) btn.click();
    });

    await page.waitForTimeout(3_000);

    // ── Step 5: Check if still on login page ─────────────────────────────
    const currentUrl = page.url();
    const pageTitle = await page.title();
    const stillOnLogin = currentUrl.includes("/login");

    let status: LoginBotResult["status"];
    let message: string;
    let statusExpected = "";
    let statusActual = "";
    let assertionMatch: "pass" | "fail" = "fail";

    if (!stillOnLogin) {
      // ── LOGIN SUCCEEDED — Run 3 Assertions ─────────────────────────────
      console.log(`[LoginBot] Login succeeded — running 3 assertions for ${username}`);

      const landingPage = new URL(currentUrl).pathname;
      const assertionResults: string[] = [];
      let allPassed = true;

      // ── Assertion 1: URL Check ──
      const expectedUrl = "/admin/companies";
      const actualUrl = landingPage;
      const urlPass = actualUrl === expectedUrl;
      if (!urlPass) allPassed = false;
      assertionResults.push(`URL: ${urlPass ? "PASS" : "FAIL"} (expected="${expectedUrl}" actual="${actualUrl}")`);
      console.log(`[LoginBot] Assertion 1 [URL]: ${urlPass ? "PASS" : "FAIL"} — expected="${expectedUrl}" actual="${actualUrl}"`);

      // ── Assertion 2: Page Title (h1) Check ──
      const expectedTitle = "Company Management";
      let actualTitle = "";
      try {
        const h1Element = page.locator('[data-testid="text-page-title"]');
        await h1Element.waitFor({ state: "visible", timeout: 10_000 });
        actualTitle = (await h1Element.textContent())?.trim() || "";
      } catch {
        actualTitle = "NOT FOUND";
      }
      const titlePass = actualTitle === expectedTitle;
      if (!titlePass) allPassed = false;
      assertionResults.push(`Page Title: ${titlePass ? "PASS" : "FAIL"} (expected="${expectedTitle}" actual="${actualTitle}")`);
      console.log(`[LoginBot] Assertion 2 [Title]: ${titlePass ? "PASS" : "FAIL"} — expected="${expectedTitle}" actual="${actualTitle}"`);

      // ── Assertion 3: Toast Message Check ──
      const expectedToast = "Welcome back! You have been logged in successfully.";
      let actualToast = "";
      try {
        const toastLocator = page.locator("text=Welcome back!").first();
        await toastLocator.waitFor({ state: "visible", timeout: 8_000 });

        // Get full toast text from parent container
        const toastParent = toastLocator.locator(
          "xpath=ancestor::*[contains(@class,'toast') or contains(@role,'status') or contains(@class,'notification')]"
        ).first();
        try {
          actualToast = (await toastParent.textContent({ timeout: 3_000 }))?.trim() || "";
        } catch {
          // Fallback: get text from immediate parent
          const directParent = toastLocator.locator("..");
          const parentText = (await directParent.textContent({ timeout: 3_000 }))?.trim() || "";
          if (parentText.length > actualToast.length) {
            actualToast = parentText;
          }
          // If still just "Welcome back!", go one more level up
          if (actualToast === "Welcome back!" || actualToast.length < 20) {
            const grandParent = directParent.locator("..");
            actualToast = (await grandParent.textContent({ timeout: 3_000 }))?.trim() || actualToast;
          }
        }
      } catch {
        actualToast = "TOAST NOT FOUND";
      }
      const toastPass = actualToast.includes("Welcome back!") && actualToast.includes("logged in successfully");
      if (!toastPass) allPassed = false;
      assertionResults.push(`Toast: ${toastPass ? "PASS" : "FAIL"} (expected="${expectedToast}" actual="${actualToast}")`);
      console.log(`[LoginBot] Assertion 3 [Toast]: ${toastPass ? "PASS" : "FAIL"} — expected="${expectedToast}" actual="${actualToast}"`);

      // ── Build status_expected and status_actual ──
      statusExpected = `Welcome back! You have been logged in successfully`;
      statusActual = allPassed
        ? `Welcome back! You have been logged in successfully`
        : assertionResults.filter((r) => r.includes("FAIL")).join(" | ");
      assertionMatch = allPassed ? "pass" : "fail";

      status = allPassed ? "success" : "failed";
      message = allPassed
        ? `Login successful — landed on /admin/companies — all 3 assertions passed`
        : `Login succeeded but assertion(s) failed: ${assertionResults.filter((r) => r.includes("FAIL")).join("; ")}`;

    } else {
      // ── LOGIN FAILED (Invalid credentials) ──────────────────────────────
      const bodyText = await page.evaluate(() => document.body.innerText);
      const bodyLower = bodyText.toLowerCase();
      const detectedError = ERROR_KEYWORDS.find((word) => bodyLower.includes(word));

      // For failed logins — compare against expected error behavior
      statusExpected = `Login failed\n401: {"message":"Invalid email or password"}`;
      statusActual = `Login failed\n401: {"message":"Invalid email or password"}`;

      if (detectedError) {
        status = "failed";
        message = `Login failed — invalid`;
        assertionMatch = "pass"; // Expected failure = assertion pass
      } else {
        status = "failed";
        message = "Login failed — still on login page";
        statusActual = "Login failed — still on login page (no error message detected)";
        assertionMatch = "pass";
      }
    }

    // ── Capture screenshot for failures or assertion mismatches ──────────
    let screenshotUrl: string | null = null;

    if (assertionMatch === "fail") {
      // Only capture screenshot when assertion FAILED (unexpected behavior)
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      await context.close();
      context = null;
      screenshotUrl = await uploadLoginScreenshot(screenshotBuffer, username, "assertion_fail");
    } else {
      // assertion_match = pass → expected behavior, no screenshot needed
      await context.close();
      context = null;
    }

    // Close browser to free memory (Render free tier = 512MB)
    await closeBrowser();

    return {
      status, message, username, currentUrl, pageTitle,
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
      status: "error",
      message: (error as Error).message,
      username,
      logo_validated: false,
      status_expected: "Login successful",
      status_actual: `ERROR: ${(error as Error).message}`,
      assertion_match: "fail",
      screenshot_url: null,
    };
  }
}
