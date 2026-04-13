// ─── Shared Types ─────────────────────────────────────────────────────────────
// All interfaces used across routes, services, and utils

import { BrowserContext, Page } from "playwright";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface Config {
  loginUrl: string;
  dashboardUrl: string;
  tableUrl: string;
  auditUrl: string;
  apiKey: string;
  supabaseUrl: string;
  supabaseKey: string;
  port: number;
  navigationTimeout: number;
  executionTimeout: number;
}

// ─── Request Inputs ──────────────────────────────────────────────────────────

export interface RiskInput {
  username: string;
  password: string;
  title: string;
  description: string;
  category: string;
  status: string;
  impact: string;
  likelihood: string;
  owner: string;
  dueDate: string;
  potentialCost: string;
  mitigationPlan: string;
}

export interface EditRiskInput {
  username: string;
  password: string;
  searchTitle: string;
  newTitle?: string;
  newDescription?: string;
  newCategory?: string;
  newStatus?: string;
  newImpact?: string;
  newLikelihood?: string;
  newOwner?: string;
  newDueDate?: string;
  newPotentialCost?: string;
  newMitigationPlan?: string;
}

export interface DeleteRiskInput {
  username: string;
  password: string;
  searchTitle: string;
}

export interface StatusWorkflowInput {
  username: string;
  password: string;
  title: string;
  description: string;
  category: string;
  impact: string;
  likelihood: string;
  owner: string;
  dueDate: string;
  potentialCost: string;
  mitigationPlan: string;
}

export interface FilterRiskInput {
  username: string;
  password: string;
  statusFilter?: string;
  categoryFilter?: string;
}

export interface ScoreMatrixInput {
  username: string;
  password: string;
  title: string;
  description: string;
  category: string;
  impact: string;
  likelihood: string;
  owner: string;
  dueDate: string;
  potentialCost: string;
  mitigationPlan: string;
  expectedScore: string;
}

export interface AuditLogInput {
  username: string;
  password: string;
  risk_title?: string;
  risk_description?: string;
  risk_category?: string;
  risk_impact?: string;
  risk_likelihood?: string;
  chat_message?: string;
}

// ─── Validation Types ────────────────────────────────────────────────────────

export interface ValidationResult {
  toast_confirmed: boolean;
  dashboard_visible: boolean;
  table_search: boolean;
  fields_valid: boolean;
  failure_type: string | null;
  field_mismatches: FieldMismatch[];
  table_data: Record<string, string> | null;
}

export interface FieldMismatch {
  field: string;
  expected: string;
  actual: string;
}

export interface ToastResult {
  detected: boolean;
  actualText: string | null;
  expectedText: string;
  match: boolean;
}

// ─── Result Types ────────────────────────────────────────────────────────────

export interface RiskResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  riskTitle: string;
  assertion: { expected: string; actual: string | null; match: boolean };
  checks: {
    toast_confirmed: boolean;
    dashboard_visible: boolean;
    table_search: boolean;
    fields_valid: boolean;
  };
  failure_type: string | null;
  field_mismatches: FieldMismatch[];
  table_data: Record<string, string> | null;
  screenshots: { failure?: string | null; table_issue?: string | null };
}

export interface StepResult {
  step: string;
  status: "pass" | "fail";
  expected_status: string;
  actual_status: string | null;
  version: number | null;
}

export interface StatusWorkflowResult {
  status: "pass" | "fail" | "error";
  message: string;
  riskTitle: string;
  assertion: { expected: string; actual: string; match: boolean };
  steps: StepResult[];
  versions_created: number;
  screenshots: { final_status: string | null; failure: string | null };
}

export interface FilterRiskResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  filters_applied: { status?: string; category?: string };
  rows_found: number;
  rows: Record<string, string>[];
  validation: { all_match: boolean; mismatches: string[] };
  screenshots: { failure?: string | null };
}

export interface ScoreMatrixResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  risk_title: string;
  impact: string;
  likelihood: string;
  expected_score: string;
  actual_score: string | null;
  score_match: boolean;
  cleaned_up: boolean;
  screenshots: { failure?: string | null };
}

export interface AuditStepResult {
  status: "pass" | "fail";
  filter_used: string;
  expected_action: string;
  actual_action: string | null;
  expected_entity: string;
  actual_entity: string | null;
  expected_severity: string;
  actual_severity: string | null;
  summary_contains: string;
  summary_found: boolean;
  action_match: boolean;
  entity_match: boolean;
  severity_match: boolean;
}

export interface AuditLogResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  risk_title: string;
  total_steps: number;
  passed: number;
  failed: number;
  steps_summary: string;
  steps: Record<string, AuditStepResult>;
  screenshots: { failure?: string | null };
}
