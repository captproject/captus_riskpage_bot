// ─── Orchestrator Config Loader ───────────────────────────────────────────────
// Replaces n8n 00_Config_Loader (CONFIG_OBJECT node).
// Source of truth: Supabase public."Config_Files" (category / key / value).
// Environment variables override table values so Render env vars win when set.

export interface OrchestratorConfig {
  environment: string;
  app: { baseUrl: string; loginUrl: string; riskPage: string };
  riskBot: { baseUrl: string; apiKey: string };
  loginBot: { apiKey: string }; // 01_Login_Module used a distinct key
  dependencyBot: { baseUrl: string; apiKey: string };
  users: { qa_user: { email: string; password: string }; admin: { email: string; password: string } };
  testData: { defaultImpact: string; defaultLikelihood: string; defaultRiskTitle: string };
  notifications: { slackWebhook: string };
  supabase: { url: string; key: string };
  legacyApp: { apiBase: string }; // SEC-2 target (ported 1:1 from n8n; currently the old Replit URL)
}

interface ConfigRow { category: string; key: string; value: string; }

async function fetchConfigRows(supabaseUrl: string, supabaseKey: string): Promise<ConfigRow[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/Config_Files?select=category,key,value`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  if (!res.ok) throw new Error(`Config_Files fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ConfigRow[];
}

export async function loadConfig(): Promise<OrchestratorConfig> {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY env vars are required (orchestrator reads Config_Files)");
  }

  const rows = await fetchConfigRows(supabaseUrl, supabaseKey);
  const get = (category: string, key: string, fallback = ""): string => {
    const row = rows.find((r) => r.category === category && r.key === key);
    return row?.value ?? fallback;
  };

  const cfg: OrchestratorConfig = {
    environment: process.env.QA_ENVIRONMENT || get("environment", "environment", "dev"),
    app: {
      baseUrl: get("app", "base_url", "https://app.captus.ai/login"),
      loginUrl: get("app", "login_url", "/login"),
      riskPage: get("app", "risk_page", "/risks"),
    },
    riskBot: {
      baseUrl: process.env.RISK_BOT_URL || get("risk_bot", "base_url", "https://captus-riskpage-bot-6ycg.onrender.com"),
      apiKey: process.env.RISK_BOT_API_KEY || get("risk_bot", "api_key"),
    },
    loginBot: {
      apiKey: process.env.LOGIN_BOT_API_KEY || get("risk_bot", "login_api_key", ""),
    },
    dependencyBot: {
      baseUrl: process.env.DEPENDENCY_BOT_URL || "https://captus-dependency-bot.onrender.com",
      apiKey: process.env.DEPENDENCY_BOT_API_KEY || "",
    },
    users: {
      qa_user: {
        email: process.env.QA_USER_EMAIL || get("users", "qa_email"),
        password: process.env.QA_USER_PASSWORD || get("users", "qa_password"),
      },
      admin: {
        email: process.env.ADMIN_EMAIL || get("users", "admin_username"),
        password: process.env.ADMIN_PASSWORD || get("users", "admin_password"),
      },
    },
    testData: {
      defaultImpact: get("test_data", "default_impact", "4"),
      defaultLikelihood: get("test_data", "default_likelihood", "3"),
      defaultRiskTitle: get("test_data", "default_risk_title", "Automation Risk"),
    },
    notifications: {
      slackWebhook: process.env.SLACK_WEBHOOK_URL || get("notifications", "slack_webhook"),
    },
    supabase: { url: supabaseUrl, key: supabaseKey },
    legacyApp: {
      // Ported verbatim from SEC-2_Unauthorized_Access_Partial (n8n). Known stale URL — fix post-cutover.
      apiBase: process.env.SEC2_TARGET_BASE || "https://captus.replit.app",
    },
  };

  if (!cfg.users.qa_user.email || !cfg.users.qa_user.password) {
    throw new Error("QA user credentials missing from Config_Files and env");
  }
  return cfg;
}
