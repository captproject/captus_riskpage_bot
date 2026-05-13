// ─────────────────────────────────────────────────────────────────────────────
// injectionPayloads.ts
// SEC-11 — Quick payload set (8 entries).
//
// Each payload has:
//   - id:           short stable identifier used in result keys
//   - type:         category for grouping in the report
//   - payload:      the actual string to inject into the form field
//   - description:  human-readable explanation
//
// To expand the test coverage later, just add entries to PAYLOADS.
// The orchestrator iterates the array automatically.
// ─────────────────────────────────────────────────────────────────────────────

export interface InjectionPayload {
  id: string;
  type: "sql" | "xss" | "path_traversal" | "command" | "nosql";
  payload: string;
  description: string;
}

export const PAYLOADS: InjectionPayload[] = [
  // ── SQL ──
  {
    id: "sql_bool_bypass",
    type: "sql",
    payload: "' OR '1'='1",
    description: "Classic SQL boolean bypass — should be stored as literal text, not interpreted",
  },
  {
    id: "sql_drop_table",
    type: "sql",
    payload: "'; DROP TABLE risks; --",
    description: "Destructive SQL injection — must NEVER execute against the database",
  },

  // ── XSS ──
  {
    id: "xss_script_tag",
    type: "xss",
    payload: "<script>alert('XSS')</script>",
    description: "Stored XSS via raw <script> tag — must be escaped on render",
  },
  {
    id: "xss_img_onerror",
    type: "xss",
    payload: "<img src=x onerror=\"alert('XSS')\">",
    description: "XSS via <img> error event handler — common bypass for naive script-tag filters",
  },
  {
    id: "xss_javascript_uri",
    type: "xss",
    payload: "javascript:alert('XSS')",
    description: "XSS via javascript: URI scheme — should never become a href target",
  },

  // ── Path traversal ──
  {
    id: "path_traversal_etc_passwd",
    type: "path_traversal",
    payload: "../../../etc/passwd",
    description: "Path traversal attempting to read system file — must be treated as plain text",
  },

  // ── Command injection ──
  {
    id: "cmd_injection_cat_passwd",
    type: "command",
    payload: "; cat /etc/passwd",
    description: "Shell command chaining — must never reach a child_process call",
  },

  // ── NoSQL ──
  {
    id: "nosql_ne_null",
    type: "nosql",
    payload: '{"$ne": null}',
    description: "MongoDB operator bypass — must be stored as literal string, not parsed as JSON operator",
  },
];

/**
 * Patterns that strongly suggest a SQL error has leaked into the response body.
 * The orchestrator scans response text/JSON for these substrings.
 */
export const SQL_ERROR_SIGNATURES = [
  "syntax error at or near",   // Postgres
  "sql syntax",                 // generic / MySQL
  "ORA-",                       // Oracle
  "PSQLException",              // JDBC Postgres
  "unterminated quoted string", // Postgres specifically
  "psql:",                      // Postgres CLI
  "sqlite",                     // SQLite leak
  "SQLITE_ERROR",
  "PostgresError",
  "QueryFailedError",           // TypeORM
];

/**
 * The reverse: text fragments that indicate the payload was rendered as literal HTML
 * (i.e. reflected XSS). If the un-escaped payload appears inside an HTML attribute
 * or as raw markup in the response body, that's a reflected-XSS finding.
 */
export const XSS_REFLECTION_MARKERS = [
  "<script>alert(",
  "onerror=\"alert(",
  "onerror='alert(",
  "javascript:alert(",
];
