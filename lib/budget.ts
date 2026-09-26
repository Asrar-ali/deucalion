/**
 * Spend control without a database.
 *
 * Per-visitor spend lives in an HMAC-signed cookie: the browser carries the counter, we
 * verify it has not been edited. A visitor can reset it by clearing cookies — accepted
 * deliberately, because the default budget is generous and the alternative is a database
 * we do not want. The real ceiling is the daily global limit plus a small account balance.
 *
 * Priority order:
 *   1. KILL_SWITCH        stop all paid calls, serve heuristic labels
 *   2. judge access code  unlimited, published in the writeup so judges cannot be blocked
 *   3. BYO key            the visitor pays, we meter nothing
 *   4. session budget     signed cookie
 *   5. daily ceiling      best-effort, per server instance
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "deucalion_spend";

export interface BudgetDecision {
  /** The key to actually use for provider calls. */
  apiKey: string | null;
  unlimited: boolean;
  used: number;
  budget: number;
  /** Set when no paid call may be made; the caller must degrade to heuristics. */
  blockedReason?: "kill_switch" | "no_key" | "over_budget" | "daily_ceiling";
  /** True when the visitor supplied their own key, so we must never log or store it. */
  byo: boolean;
}

function secret(): string {
  // Not a security boundary — it only stops casual cookie edits. Falls back to the
  // provider key so a missing env var cannot silently disable signing.
  return process.env.BUDGET_SIGNING_SECRET || process.env.OPENROUTER_API_KEY || "deucalion";
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

/** Reads the signed spend counter. Any tampering resets to zero rather than throwing. */
export function readSpend(cookieHeader: string | null): number {
  if (!cookieHeader) return 0;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return 0;

  const [amount, mac] = decodeURIComponent(raw).split(".");
  if (!amount || !mac) return 0;

  const expected = sign(amount);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 0;

  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function spendCookie(used: number): string {
  const amount = used.toFixed(6);
  const value = encodeURIComponent(`${amount}.${sign(amount)}`);
  // 12h is longer than any judging session and short enough not to linger.
  return `${COOKIE}=${value}; Path=/; Max-Age=43200; SameSite=Lax; HttpOnly`;
}

// Best-effort daily total. Resets on cold start, which is acceptable for a ceiling whose
// only job is to stop a runaway loop from draining the account overnight.
let dailyTotal = 0;
let dailyStamp = new Date().toISOString().slice(0, 10);

export function recordDailySpend(amount: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyStamp) {
    dailyStamp = today;
    dailyTotal = 0;
  }
  dailyTotal += amount;
}

export function dailySpend(): number {
  return dailyTotal;
}

export interface BudgetRequest {
  cookieHeader: string | null;
  /** Visitor-supplied OpenRouter key. Held in their browser, never persisted here. */
  byoKey?: string | null;
  /** Access code entered by the visitor. */
  accessCode?: string | null;
}

export function checkBudget(req: BudgetRequest): BudgetDecision {
  const budget = Number(process.env.SESSION_BUDGET_USD ?? "2") || 2;
  const ceiling = Number(process.env.DAILY_CEILING_USD ?? "20") || 20;
  const used = readSpend(req.cookieHeader);

  if (process.env.KILL_SWITCH === "1") {
    return { apiKey: null, unlimited: false, used, budget, blockedReason: "kill_switch", byo: false };
  }

  // A visitor paying with their own key is never metered and never blocked by our budget.
  if (req.byoKey && req.byoKey.trim()) {
    return { apiKey: req.byoKey.trim(), unlimited: true, used, budget, byo: true };
  }

  const serverKey = process.env.OPENROUTER_API_KEY?.trim() || null;

  const judgeCode = process.env.JUDGE_ACCESS_CODE?.trim();
  const unlimited = Boolean(judgeCode && req.accessCode?.trim() === judgeCode);

  if (!serverKey) {
    return { apiKey: null, unlimited, used, budget, blockedReason: "no_key", byo: false };
  }

  if (!unlimited) {
    if (used >= budget) {
      return { apiKey: null, unlimited, used, budget, blockedReason: "over_budget", byo: false };
    }
    if (dailySpend() >= ceiling) {
      return { apiKey: null, unlimited, used, budget, blockedReason: "daily_ceiling", byo: false };
    }
  }

  return { apiKey: serverKey, unlimited, used, budget, byo: false };
}

/** Message for the UI panel. Kept here so the wording stays consistent. */
export function blockedMessage(reason: NonNullable<BudgetDecision["blockedReason"]>): string {
  const email = process.env.CONTACT_EMAIL || "the team";
  switch (reason) {
    case "kill_switch":
      return "Model classification is temporarily disabled. Results below use local heuristics only.";
    case "no_key":
      return "No classification key is configured on this deployment. Results below use local heuristics only.";
    case "over_budget":
      return `You have used your free processing budget. Enter an access code, add your own OpenRouter key, or email ${email} for more.`;
    case "daily_ceiling":
      return `This deployment has hit its daily processing ceiling. Add your own OpenRouter key, or email ${email}.`;
  }
}
