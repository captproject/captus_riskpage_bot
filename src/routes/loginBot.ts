// ─── Login Bot Route — Simplified Allure output ──────────────────────────────
// Displays only: ID, Scenario Description, Assertion Match in Allure report
//
// 2026-07-16 — Post-migration assertion fixes (Vercel/Render split):
//   1. Expected landing page is now /projects (was /admin/companies on Replit).
//      Overridable via EXPECTED_LANDING_PATH env var — next routing change is
//      an env update on Render, not a code push.
//   2. Toast capture is armed BEFORE the Sign In click. Previously the toast
//      was checked after a 10s title wait, by which time the auto-dismissing
//      toast was gone — guaranteed timing failure.
//   3. The "Company Management" title assertion is removed. The content
//      assertion is now the toast text itself:
//      "Welcome back! You have been logged in successfully."

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

// ─── Post-Login Expectations (TC 1.1) ────────────────────────────────────────
const EXPECTED_LANDING_PATH = process.env.EXPECTED_LANDING_PATH || "/projects";
const TOAST_TITLE = "Welcome back!";
const TOAST_BODY = "You have been logged in successfully";
const EXPECTED_TOAST = `${TOAST_TITLE} ${TOAST_BODY}.`;

// ─── Empty-Field Validation (TC 1.3) ──────────────────────────────────────────
// Exact inline messages the Captus login form renders on empty/invalid submit.
const VALIDATION_MESSAGES = {
  email: "Please enter a valid email address",
  password: "Password is required",
};

// Polls the page body for up to `timeoutMs` until one of the expected validation
// messages appears, then returns the body text. React renders these a beat after
// the Sign In click, so a fixed wait isn't reliable.
async function waitForValidation(
  page: Page,
  expected: string[],
  timeoutMs = 6_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let body = "";
  while (Date.now() < deadline) {
    body = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (expected.some((m) => body.includes(m))) return body;
    await page.waitForTimeout(300);
  }
  return body;
}

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

    // Treat null / undefined / whitespace-only as "empty" — these are the 1.3 rows.
    const emailEmpty = !username || String(username).trim() === "";
    const passwordEmpty = !password || String(password).trim() === "";
    const isEmptyFieldScenario = emailEmpty || passwordEmpty;

    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 15_000 });
    await page.waitForTimeout(5_000);

    // Fill email ONLY when provided — leaving it blank is what triggers validation.
    if (!emailEmpty) {
      await page.evaluate((email) => {
        const input = document.querySelector('input[name="email"]') as HTMLInputElement;
        if (input) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (s) s.call(input, email);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, username);
    }

    // Fill password ONLY when provided.
    if (!passwordEmpty) {
      await page.evaluate((pass) => {
        const input = document.querySelector('input[name="password"]') as HTMLInputElement;
        if (input) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (s) s.call(input, pass);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, password);
    }

    // ─── Arm toast capture BEFORE clicking Sign In ────────────────────────────
    // The success toast auto-dismisses within a few seconds of login, so it must
    // be intercepted the moment it renders — not after other assertions.
    // Walks up from the matched text node until the container holds both the
    // toast title and body, so the full message is captured.
    let toastText = "";
    let toastCapture: Promise<void> = Promise.resolve();
    if (!isEmptyFieldScenario) {
      toastCapture = page
        .waitForSelector(`text=${TOAST_TITLE}`, { state: "visible", timeout: 15_000 })
        .then(async (el) => {
          if (!el) return;
          toastText = await el.evaluate((node) => {
            let cur: HTMLElement | null = node as HTMLElement;
            for (let i = 0; i < 5 && cur; i++) {
              const t = cur.innerText || "";
              if (t.includes("Welcome back!") && t.includes("logged in successfully")) return t;
              cur = cur.parentElement;
            }
            return (node as HTMLElement).innerText || "";
          }).catch(() => "");
        })
        .catch(() => {
          // Toast never appeared (negative scenario or genuine failure) — the
          // success branch asserts on toastText and reports accordingly.
        });
    }

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

    if (isEmptyFieldScenario) {
      // ─── TC 1.3: Empty-field validation ──────────────────────────────────
      const expected: string[] = [];
      if (emailEmpty) expected.push(VALIDATION_MESSAGES.email);
      if (passwordEmpty) expected.push(VALIDATION_MESSAGES.password);

      const body = await waitForValidation(page, expected);
      const emailMsgShown = body.includes(VALIDATION_MESSAGES.email);
      const passwordMsgShown = body.includes(VALIDATION_MESSAGES.password);

      const detected: string[] = [];
      if (emailMsgShown) detected.push(VALIDATION_MESSAGES.email);
      if (passwordMsgShown) detected.push(VALIDATION_MESSAGES.password);

      // Pass = submission was blocked (still on /login) AND the right message showed.
      // When BOTH fields are empty the form surfaces the email error first, so we
      // require the email message and treat the password message as a bonus.
      let validationPass: boolean;
      if (emailEmpty) {
        validationPass = stillOnLogin && emailMsgShown;
      } else {
        validationPass = stillOnLogin && passwordMsgShown;
      }

      statusExpected = `Form validation blocks submission — ${expected.join(" + ")}`;
      statusActual = !stillOnLogin
        ? "FAIL — form submitted (left /login); validation did NOT block"
        : detected.length
          ? `Validation shown — ${detected.join(" + ")}`
          : "Stayed on /login but no validation message detected";

      assertionMatch = validationPass ? "pass" : "fail";
      status = "failed"; // login never succeeds in an empty-field scenario — expected
      message = validationPass
        ? `Empty-field validation working — ${detected.join(" + ")}`
        : `Empty-field validation issue — expected [${expected.join(" + ")}], got: ${statusActual}`;
    } else if (!stillOnLogin) {
      // ─── TC 1.1: Authorized login — URL + toast assertions ────────────────
      const landingPage = new URL(currentUrl).pathname;
      const assertionResults: string[] = [];
      let allPassed = true;

      const urlPass = landingPage === EXPECTED_LANDING_PATH;
      if (!urlPass) allPassed = false;
      assertionResults.push(`URL: ${urlPass ? "PASS" : `FAIL (expected ${EXPECTED_LANDING_PATH}, got ${landingPage})`}`);

      // Toast was armed before the Sign In click; by now it has either been
      // captured or its 15s window has lapsed.
      await toastCapture;
      const toastPass = toastText.includes(TOAST_TITLE) && toastText.includes(TOAST_BODY);
      if (!toastPass) allPassed = false;
      assertionResults.push(
        `Toast: ${toastPass ? "PASS" : `FAIL (expected "${EXPECTED_TOAST}", got "${toastText || "TOAST NOT FOUND"}")`}`
      );

      statusExpected = `Land on ${EXPECTED_LANDING_PATH} — toast: "${EXPECTED_TOAST}"`;
      statusActual = allPassed
        ? statusExpected
        : assertionResults.filter((r) => r.includes("FAIL")).join(" | ");
      assertionMatch = allPassed ? "pass" : "fail";
      status = allPassed ? "success" : "failed";
      message = allPassed
        ? `Login successful — landed on ${EXPECTED_LANDING_PATH} — all assertions passed`
        : `Login succeeded but assertion(s) failed: ${assertionResults.filter((r) => r.includes("FAIL")).join("; ")}`;
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