#!/usr/bin/env -S deno run --allow-net --allow-env
/// <reference lib="deno.desktop" />
/**
 * aiuse — usage monitor for Claude.ai and OpenCode Go
 *
 * Polls both providers independently and displays rate-limit / usage
 * data side-by-side in a single desktop dashboard.
 *
 * - Session tokens are entered once in the browser (key screen), never CLI.
 * - Tokens persist via Deno's localStorage across restarts.
 * - Organization / workspace IDs are auto-detected.
 * - Set CLAUDE_ORG_ID or OPENCODE_WORKSPACE_ID to override detection.
 *
 * Run:
 *   deno desktop --allow-net --allow-env report.ts
 */

const ORG_ID_OVERRIDE = Deno.env.get("CLAUDE_ORG_ID");
const OPENCODE_WORKSPACE_OVERRIDE = Deno.env.get("OPENCODE_WORKSPACE_ID");
const POLL_INTERVAL_MS = 30_000;
const AUTH_RETRY_INTERVAL_MS = 5_000;
const AUTH_RETRY_MAX = 6;

const CLAUDE_TOKEN_KEY = "claude_session_key";
const CLAUDE_ORG_KEY = "claude_org_id";
const OPENCODE_TOKEN_KEY = "opencode_auth";
const OPENCODE_WORKSPACE_KEY = "opencode_workspace_id";

const DEVICE_ID = crypto.randomUUID();
const ANONYMOUS_ID = crypto.randomUUID();
const ACTIVITY_SESSION_ID = crypto.randomUUID();

import { parseOpenCodeUsage, type OCUsageResponse } from "./parse_usage.ts";

class AuthError extends Error {}

// ---- types (Claude) ----
interface ClaudeWindow {
  utilization: number;
  resets_at: string;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}
interface LimitEntry {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope?: {
    model?: { id: string | null; display_name: string } | null;
    surface?: unknown;
  } | null;
  is_active: boolean;
}
interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string;
  decimal_places: number;
  disabled_reason: string | null;
}
interface SpendInfo {
  enabled: boolean;
  used?: { amount_minor: number; currency: string; exponent: number } | null;
  limit?: number | null;
  percent?: number;
  disabled_reason?: string | null;
  can_purchase_credits?: boolean;
}
interface ClaudeUsageResponse {
  five_hour: ClaudeWindow;
  seven_day: ClaudeWindow;
  spend?: SpendInfo;
  extra_usage?: ExtraUsage | null;
  limits?: LimitEntry[];
}
interface PrepaidCredits {
  amount: number;
  currency: string;
  balance_credits: number;
}

// ---- types (OpenCode) ----
interface ProviderError {
  kind: "auth" | "network";
  message: string;
}

// ---- token storage: Deno localStorage persists across restarts ----
function getClaudeToken(): string | null {
  return localStorage.getItem(CLAUDE_TOKEN_KEY);
}
function setClaudeToken(v: string) {
  localStorage.setItem(CLAUDE_TOKEN_KEY, v);
}
function clearClaudeToken() {
  localStorage.removeItem(CLAUDE_TOKEN_KEY);
}
function getClaudeOrg(): string | null {
  return localStorage.getItem(CLAUDE_ORG_KEY);
}
function setClaudeOrg(v: string) {
  localStorage.setItem(CLAUDE_ORG_KEY, v);
}
function clearClaudeOrg() {
  localStorage.removeItem(CLAUDE_ORG_KEY);
}

function getOpenCodeToken(): string | null {
  return localStorage.getItem(OPENCODE_TOKEN_KEY);
}
function setOpenCodeToken(v: string) {
  localStorage.setItem(OPENCODE_TOKEN_KEY, v);
}
function clearOpenCodeToken() {
  localStorage.removeItem(OPENCODE_TOKEN_KEY);
}
function getOpenCodeWorkspace(): string | null {
  return localStorage.getItem(OPENCODE_WORKSPACE_KEY);
}
function setOpenCodeWorkspace(v: string) {
  localStorage.setItem(OPENCODE_WORKSPACE_KEY, v);
}
function clearOpenCodeWorkspace() {
  localStorage.removeItem(OPENCODE_WORKSPACE_KEY);
}

// ---- in-memory state ----
let latestClaudeUsage: ClaudeUsageResponse | null = null;
let latestClaudePrepaid: PrepaidCredits | null = null;
let latestOpenCodeUsage: OCUsageResponse | null = null;

let claudeError: ProviderError | null = null;
let opencodeError: ProviderError | null = null;

let authErrorCountClaude = 0;
let authErrorCountOpenCode = 0;
let lastFetchedAt: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

// ---- Claude API ----
function claudeHeaders(token: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `sessionKey=${token}`,
    "anthropic-client-platform": "web_claude_ai",
    "anthropic-device-id": DEVICE_ID,
    "anthropic-anonymous-id": ANONYMOUS_ID,
    "x-activity-session-id": ACTIVITY_SESSION_ID,
    "Referer": "https://claude.ai/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=0",
  };
}

async function resolveClaudeOrg(token: string): Promise<string> {
  if (ORG_ID_OVERRIDE) return ORG_ID_OVERRIDE;
  const cached = getClaudeOrg();
  if (cached) return cached;

  const res = await fetch("https://claude.ai/api/organizations", {
    headers: claudeHeaders(token),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed while resolving org id: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`could not list organizations: ${res.status} ${res.statusText}`);
  }
  const orgs = await res.json() as Array<{ uuid: string; name?: string }>;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("this session key has no organizations attached");
  }
  const orgId = orgs[0].uuid;
  setClaudeOrg(orgId);
  return orgId;
}

async function fetchClaudeUsage(token: string): Promise<ClaudeUsageResponse> {
  const orgId = await resolveClaudeOrg(token);
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers: claudeHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function fetchClaudePrepaidCredits(token: string): Promise<PrepaidCredits> {
  const orgId = await resolveClaudeOrg(token);
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/prepaid/credits`,
    { headers: claudeHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

// ---- OpenCode API ----
function opencodeHeaders(auth: string): Record<string, string> {
  const cleanAuth = auth.startsWith("auth=") ? auth.slice(5) : auth;
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `auth=${cleanAuth}; oc_locale=en`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };
}

function extractPageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/);
  return m ? m[1].trim() : "(no title)";
}

async function resolveOpenCodeWorkspace(auth: string): Promise<string> {
  if (OPENCODE_WORKSPACE_OVERRIDE) return OPENCODE_WORKSPACE_OVERRIDE;
  const cached = getOpenCodeWorkspace();
  if (cached) return cached;

  throw new Error(
    "workspace ID not set — re-connect OpenCode and paste your workspace ID" +
      " (from the URL: opencode.ai/workspace/wrk_01…/go)",
  );
}

async function fetchOpenCodeUsage(
  auth: string,
): Promise<OCUsageResponse> {
  const wsId = await resolveOpenCodeWorkspace(auth);
  const res = await fetch(
    `https://opencode.ai/workspace/${wsId}/go`,
    { headers: opencodeHeaders(auth) },
  );

  console.error("[aiuse] opencode go page:", JSON.stringify({
    status: res.status,
    url: res.url,
  }));

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`HTTP ${res.status} from ${res.url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${res.url}`);
  }
  const html = await res.text();

  try {
    return parseOpenCodeUsage(html);
  } catch (e) {
    const title = extractPageTitle(html);
    console.error("[aiuse] go page title:", title, "body snippet:",
      html.substring(0, 200).replace(/\s+/g, " "));
    throw e;
  }
}

// ---- polling ----
function scheduleNext() {
  const hasAuthErrors =
    (authErrorCountClaude > 0 && authErrorCountClaude <= AUTH_RETRY_MAX) ||
    (authErrorCountOpenCode > 0 &&
      authErrorCountOpenCode <= AUTH_RETRY_MAX);
  const delay = hasAuthErrors ? AUTH_RETRY_INTERVAL_MS : POLL_INTERVAL_MS;
  pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  const claudeToken = getClaudeToken();
  const opencodeToken = getOpenCodeToken();

  if (!claudeToken && !opencodeToken) {
    scheduleNext();
    return;
  }

  let hadAnySuccess = false;

  if (claudeToken) {
    try {
      latestClaudeUsage = await fetchClaudeUsage(claudeToken);
      latestClaudePrepaid = await fetchClaudePrepaidCredits(claudeToken);
      authErrorCountClaude = 0;
      claudeError = null;
      hadAnySuccess = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthError) {
        authErrorCountClaude++;
        claudeError = { kind: "auth", message };
      } else {
        claudeError = { kind: "network", message };
      }
      console.error("[aiuse] claude poll failed:", message);
    }
  }

  if (opencodeToken) {
    try {
      latestOpenCodeUsage = await fetchOpenCodeUsage(opencodeToken);
      authErrorCountOpenCode = 0;
      opencodeError = null;
      hadAnySuccess = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthError) {
        authErrorCountOpenCode++;
        opencodeError = { kind: "auth", message };
      } else {
        opencodeError = { kind: "network", message };
      }
      console.error("[aiuse] opencode poll failed:", e instanceof Error ? e.stack || message : message);
    }
  }

  if (hadAnySuccess) {
    lastFetchedAt = new Date().toISOString();
  }
  scheduleNext();
}

function startPolling() {
  if (pollTimer !== undefined) return;
  pollOnce();
}
function stopPolling() {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

if (getClaudeToken() || getOpenCodeToken()) startPolling();

// ---- HTTP layer ----
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    return new Response(PAGE_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    return json({
      hasClaudeToken: !!getClaudeToken(),
      hasOpenCodeToken: !!getOpenCodeToken(),
      lastFetchedAt,
    });
  }

  if (url.pathname === "/api/token" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { claudeToken?: string; opencodeToken?: string; opencodeWorkspaceId?: string }
      | null;
    if (!body) return json({ ok: false, error: "Invalid body." }, 400);

    let claudeTok = body.claudeToken?.trim();
    let opencodeTok = body.opencodeToken?.trim();
    let opencodeWsId = body.opencodeWorkspaceId?.trim();

    // Strip accidental cookie-name prefixes
    if (claudeTok && claudeTok.startsWith("sessionKey=")) {
      claudeTok = claudeTok.slice(11);
    }
    if (opencodeTok && opencodeTok.startsWith("auth=")) {
      opencodeTok = opencodeTok.slice(5);
    }
    if (opencodeWsId && !opencodeWsId.startsWith("wrk_")) {
      return json({ ok: false, error: "Workspace ID should start with wrk_ (check the URL)." }, 400);
    }

    if (!claudeTok && !opencodeTok) {
      return json(
        { ok: false, error: "Paste at least one session key." },
        400,
      );
    }

    if (claudeTok) {
      setClaudeToken(claudeTok);
      clearClaudeOrg();
      claudeError = null;
    }
    if (opencodeTok) {
      setOpenCodeToken(opencodeTok);
      if (opencodeWsId) setOpenCodeWorkspace(opencodeWsId);
      opencodeError = null;
    }

    startPolling();
    return json({ ok: true });
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    return json({
      claude: {
        usage: latestClaudeUsage,
        prepaidCredits: latestClaudePrepaid,
        error: claudeError,
      },
      opencode: {
        usage: latestOpenCodeUsage,
        error: opencodeError,
      },
      lastFetchedAt,
    });
  }

  if (url.pathname === "/api/reset-token" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { provider?: string }
      | null;
    const provider = body?.provider || "all";

    if (provider === "claude" || provider === "all") {
      clearClaudeToken();
      clearClaudeOrg();
      latestClaudeUsage = null;
      latestClaudePrepaid = null;
      claudeError = null;
      authErrorCountClaude = 0;
    }
    if (provider === "opencode" || provider === "all") {
      clearOpenCodeToken();
      clearOpenCodeWorkspace();
      latestOpenCodeUsage = null;
      opencodeError = null;
      authErrorCountOpenCode = 0;
    }

    if (!getClaudeToken() && !getOpenCodeToken()) {
      stopPolling();
    }

    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage</title>
<style>
  :root{
    --bg: #0a0e0c;
    --panel: #101512;
    --grid: #1b241f;
    --text: #c8d6cd;
    --dim: #5c6b62;
    --green: #4fd68a;
    --green-dim: #2b6b4d;
    --amber: #e0a94f;
    --red: #e0685a;
    --mono: "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh;}
  body{
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 28px 28px;
  }

  /* ---------- key screen ---------- */
  #key-screen{
    min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
  }
  .key-card{
    width:100%; max-width:480px;
    background:var(--panel); border:1px solid var(--grid); border-radius:2px;
    padding:28px 26px 24px; position:relative;
  }
  .key-card::before{
    content:"authentication"; position:absolute; top:-9px; left:16px;
    background:var(--bg); padding:0 8px; font-size:10px; letter-spacing:.14em; color:var(--dim);
  }
  .key-card h2{margin:0 0 8px; font-size:18px; font-weight:600;}
  .key-card > p{margin:0 0 18px; font-size:12.5px; color:var(--dim); line-height:1.6;}
  .key-card code{color:var(--green); background:#0d1210; padding:1px 5px; border-radius:2px;}

  .provider-field{margin-bottom:14px;}
  .provider-field-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}
  .provider-field label{font-size:12px;color:var(--dim);}
  .provider-field label code{color:var(--green);background:#0d1210;padding:1px 5px;border-radius:2px;font-size:11px;}
  .connected-badge{font-size:10px;color:var(--green);border:1px solid var(--green-dim);padding:1px 6px;border-radius:2px;display:none;}
  .provider-field input{
    width:100%; background:#0d1210; border:1px solid var(--grid); color:var(--text);
    font-family:var(--mono); font-size:12.5px; padding:9px 11px; border-radius:2px; outline:none;
  }
  .provider-field input:focus{border-color:var(--green-dim);}
  .provider-hint{font-size:10.5px;color:var(--dim);margin-top:3px;padding-left:2px;line-height:1.4;}
  .provider-hint b{color:var(--text);font-weight:500;}
  .provider-connect{
    width:100%; margin-top:8px; background:#0d1210; color:var(--text);
    border:1px solid var(--grid); font-family:var(--mono); font-size:12px;
    padding:8px 12px; border-radius:2px; cursor:pointer; letter-spacing:.03em;
  }
  .provider-connect:hover{background:var(--green-dim);border-color:var(--green);color:#eafff2;}
  .provider-connect:disabled{opacity:.5;cursor:default;}
  .provider-error-msg{min-height:16px;margin-top:6px;font-size:11px;color:var(--red);}
  .back-to-dash{display:block;text-align:center;margin-top:14px;font-size:11px;color:var(--dim);cursor:pointer;text-decoration:none;border-top:1px dashed var(--grid);padding-top:10px;}
  .back-to-dash:hover{color:var(--text);}

  /* ---------- dashboard ---------- */
  #dashboard{padding: 40px 20px 60px;}
  .wrap{max-width:900px;margin:0 auto;}
  .topbar{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--grid);padding-bottom:14px;margin-bottom:26px;flex-wrap:wrap;gap:8px;}
  .brand{font-size:13px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;}
  .brand b{color:var(--green);}
  .topbar-right{display:flex;align-items:center;gap:14px;font-size:12px;color:var(--dim);}
  .clock span{color:var(--text);}
  .reset-link{color:var(--dim);text-decoration:none;border-bottom:1px dotted var(--dim);cursor:pointer;}
  .reset-link:hover{color:var(--text);border-color:var(--text);}
  h1{font-size:22px;margin:0 0 4px;font-weight:600;letter-spacing:.02em;}
  .sub{color:var(--dim);font-size:13px;margin-bottom:28px;}

  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;}
  @media(max-width:800px){.grid3{grid-template-columns:1fr 1fr;}}
  @media(max-width:640px){.grid2,.grid3{grid-template-columns:1fr;}}

  .panel{background:var(--panel);border:1px solid var(--grid);border-radius:2px;padding:20px 22px 22px;position:relative;}
  .panel::before{content:attr(data-tag);position:absolute;top:-9px;left:16px;background:var(--bg);padding:0 8px;font-size:10px;letter-spacing:.14em;color:var(--dim);}
  .row-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
  .row-head .label{font-size:14px;color:var(--text);}
  .status{font-size:10px;letter-spacing:.1em;padding:2px 7px;border-radius:2px;border:1px solid var(--green-dim);color:var(--green);text-transform:uppercase;}
  .pct{font-size:38px;font-weight:700;line-height:1;margin-bottom:2px;font-variant-numeric:tabular-nums;}
  .pct small{font-size:15px;font-weight:400;color:var(--dim);}
  .meter{display:flex;gap:3px;margin:14px 0 12px;}
  .cell{flex:1;height:16px;background:#141a17;border-radius:1px;}
  .meta{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);border-top:1px dashed var(--grid);padding-top:10px;margin-top:4px;}
  .meta b{color:var(--text);font-weight:500;}
  .countdown{font-size:12px;color:var(--dim);margin-top:2px;}
  .countdown span{color:var(--amber);font-variant-numeric:tabular-nums;}

  /* ---------- provider sections ---------- */
  .provider-section{margin-bottom:30px;}
  .provider-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--grid);}
  .provider-head h2{margin:0;font-size:16px;font-weight:600;color:var(--text);}
  .provider-badge{font-size:10px;letter-spacing:.08em;padding:3px 8px;border-radius:2px;border:1px solid var(--grid);color:var(--dim);text-transform:uppercase;}
  .provider-badge.ok{border-color:var(--green-dim);color:var(--green);}
  .provider-badge.err{border-color:var(--red);color:var(--red);}
  .provider-error{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    background:#1a1210;border:1px solid var(--red);color:#f2b8ae;
    font-size:12px;padding:8px 12px;border-radius:2px;margin-bottom:14px;
  }
  .provider-error b{color:var(--red);text-transform:uppercase;font-size:10px;letter-spacing:.08em;display:block;margin-bottom:2px;}
  .provider-error button{
    flex-shrink:0;background:transparent;border:1px solid var(--red);color:#f2b8ae;
    font-family:var(--mono);font-size:10px;padding:4px 8px;border-radius:2px;cursor:pointer;
  }
  .provider-error button:hover{background:var(--red);color:#2a0d08;}

  .no-provider{
    padding:24px;text-align:center;color:var(--dim);font-size:13px;
    border:1px dashed var(--grid);border-radius:2px;background:var(--panel);
  }
  .no-provider a{color:var(--green);cursor:pointer;border-bottom:1px dotted var(--green-dim);}

  /* ---------- claude-specific ---------- */
  #scoped-panel{margin-top:18px;}
  .scoped-row + .scoped-row{margin-top:16px;padding-top:16px;border-top:1px dashed var(--grid);}
  .scoped-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
  .scoped-name{font-size:13px;color:var(--text);}
  .scoped-pct{font-size:20px;font-weight:700;margin-bottom:8px;font-variant-numeric:tabular-nums;}
  .footer-panel{margin-top:18px;}
  .spend-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;}
  .spend-row .tag{font-size:10px;letter-spacing:.1em;color:var(--dim);border:1px solid var(--grid);padding:2px 6px;border-radius:2px;}
  .note{margin-top:14px;font-size:11.5px;color:var(--dim);line-height:1.6;}
  .note a{color:var(--green);text-decoration:none;border-bottom:1px dotted var(--green-dim);}
  .legend{display:flex;gap:18px;margin-top:26px;font-size:11px;color:var(--dim);flex-wrap:wrap;}
  .legend .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;}
  .stamp{margin-top:30px;font-size:10.5px;color:var(--dim);opacity:.7;text-align:right;}
</style>
</head>
<body>

  <div id="key-screen" style="display:none">
    <div class="key-card">
      <h2>Connect your sessions</h2>
      <p>Paste your session tokens to monitor usage. Connect one or both providers — each polls independently.</p>

      <div class="provider-field">
        <div class="provider-field-head">
          <label for="claude-key-input">Claude <code>sessionKey</code></label>
          <span class="connected-badge" id="claude-connected-badge">✓ connected</span>
        </div>
        <input id="claude-key-input" type="password" placeholder="sk-ant-sid01-..." autocomplete="off" spellcheck="false" />
        <div class="provider-hint">devtools → Application / Storage → Cookies → claude.ai → <b>sessionKey</b></div>
        <button class="provider-connect" id="claude-connect">Connect Claude</button>
        <div class="provider-error-msg" id="claude-key-error"></div>
      </div>

      <div class="provider-field">
        <div class="provider-field-head">
          <label for="opencode-key-input">OpenCode <code>auth</code> cookie</label>
          <span class="connected-badge" id="opencode-connected-badge">✓ connected</span>
        </div>
        <input id="opencode-key-input" type="password" placeholder="Fe26.2**..." autocomplete="off" spellcheck="false" />
        <div class="provider-hint">devtools → Application / Storage → Cookies → opencode.ai → <b>auth</b></div>
        <div class="provider-field" style="margin-top:10px">
          <label for="opencode-workspace-input">Workspace ID</label>
          <input id="opencode-workspace-input" type="text" placeholder="wrk_01KYKN6HZ9HQ041NPY12S9ZQ11" autocomplete="off" spellcheck="false" />
          <div class="provider-hint">from the URL: opencode.ai/workspace/<b>wrk_01…</b>/go — found on any workspace page</div>
        </div>
        <button class="provider-connect" id="opencode-connect">Connect OpenCode</button>
        <div class="provider-error-msg" id="opencode-key-error"></div>
      </div>

      <a class="back-to-dash" id="back-to-dash">← back to dashboard</a>
      <div class="key-help">
        Stored locally on this machine. Only used to poll your own usage.<br>
        <b>Claude:</b> cookie named <b>sessionKey</b> &nbsp;|&nbsp; <b>OpenCode:</b> cookie named <b>auth</b>
      </div>
    </div>
  </div>

  <div id="dashboard" style="display:none">
    <div class="wrap">
      <div class="topbar">
        <div class="brand">AI Usage</div>
        <div class="topbar-right">
          <span id="updated-ago">--</span>
          <span class="clock">local time <span id="clock">--:--:--</span></span>
          <a class="reset-link" id="connect-provider">connect provider</a>
          <a class="reset-link" id="reset-claude">reset claude</a>
          <a class="reset-link" id="reset-opencode">reset opencode</a>
        </div>
      </div>

      <h1>Rate limit status</h1>
      <div class="sub">Claude.ai and OpenCode Go usage, refreshed automatically.</div>

      <!---------- Claude section ---------->
      <section class="provider-section" id="claude-section">
        <div class="provider-head">
          <h2>Claude.ai</h2>
          <span class="provider-badge ok" id="claude-badge">connected</span>
        </div>
        <div class="provider-error" id="claude-error" style="display:none">
          <div class="msg"><b id="claude-error-kind">error</b><span id="claude-error-msg"></span></div>
          <button id="claude-error-dismiss">dismiss</button>
        </div>

        <div class="grid2">
          <div class="panel" data-tag="session window">
            <div class="row-head">
              <div class="label">5-hour session</div>
              <div class="status" id="status-5h">--</div>
            </div>
            <div class="pct"><span id="pct-5h">--</span><small>%</small></div>
            <div class="meter" id="meter-5h"></div>
            <div class="countdown">resets in <span id="cd-5h">--</span></div>
            <div class="meta"><span>resets at</span><b id="reset-5h-time">--</b></div>
            <div class="meta" id="spend-5h-row" style="display:none"><span>spend</span><b id="spend-5h">--</b></div>
          </div>

          <div class="panel" data-tag="7-day window">
            <div class="row-head">
              <div class="label">Weekly (all models)</div>
              <div class="status" id="status-7d">--</div>
            </div>
            <div class="pct"><span id="pct-7d">--</span><small>%</small></div>
            <div class="meter" id="meter-7d"></div>
            <div class="countdown">resets in <span id="cd-7d">--</span></div>
            <div class="meta"><span>resets at</span><b id="reset-7d-time">--</b></div>
            <div class="meta" id="spend-7d-row" style="display:none"><span>spend</span><b id="spend-7d">--</b></div>
          </div>
        </div>

        <div class="panel" data-tag="model-scoped weekly" id="scoped-panel" style="display:none">
          <div id="scoped-limits"></div>
        </div>

        <div class="panel footer-panel" data-tag="spend / credits">
          <div class="spend-row">
            <span>Usage-based spend</span>
            <span class="tag" id="spend-tag">--</span>
          </div>
          <div class="spend-row" id="credits-row" style="margin-top:10px;display:none">
            <span>Extra credits used</span>
            <span id="credits-used">--</span>
          </div>
          <div class="note">
            Extra usage credits cover you once a plan limit is hit.
            <a href="https://support.claude.com/articles/12429409" target="_blank" rel="noopener">Learn more &rarr;</a>
          </div>
        </div>
      </section>

      <!---------- OpenCode section ---------->
      <section class="provider-section" id="opencode-section">
        <div class="provider-head">
          <h2>OpenCode Go</h2>
          <span class="provider-badge ok" id="opencode-badge">connected</span>
        </div>
        <div class="provider-error" id="opencode-error" style="display:none">
          <div class="msg"><b id="opencode-error-kind">error</b><span id="opencode-error-msg"></span></div>
          <button id="opencode-error-dismiss">dismiss</button>
        </div>

        <div class="grid3">
          <div class="panel" data-tag="rolling window">
            <div class="row-head">
              <div class="label">Rolling Usage</div>
              <div class="status" id="status-oc-rolling">--</div>
            </div>
            <div class="pct"><span id="pct-oc-rolling">--</span><small>%</small></div>
            <div class="meter" id="meter-oc-rolling"></div>
            <div class="countdown">resets in <span id="cd-oc-rolling">--</span></div>
          </div>

          <div class="panel" data-tag="7-day window">
            <div class="row-head">
              <div class="label">Weekly Usage</div>
              <div class="status" id="status-oc-weekly">--</div>
            </div>
            <div class="pct"><span id="pct-oc-weekly">--</span><small>%</small></div>
            <div class="meter" id="meter-oc-weekly"></div>
            <div class="countdown">resets in <span id="cd-oc-weekly">--</span></div>
          </div>

          <div class="panel" data-tag="30-day window">
            <div class="row-head">
              <div class="label">Monthly Usage</div>
              <div class="status" id="status-oc-monthly">--</div>
            </div>
            <div class="pct"><span id="pct-oc-monthly">--</span><small>%</small></div>
            <div class="meter" id="meter-oc-monthly"></div>
            <div class="countdown">resets in <span id="cd-oc-monthly">--</span></div>
          </div>
        </div>
      </section>

      <div class="legend">
        <div><span class="dot" style="background:var(--green)"></span>0-59% normal</div>
        <div><span class="dot" style="background:var(--amber)"></span>60-89% elevated</div>
        <div><span class="dot" style="background:var(--red)"></span>90-100% critical</div>
      </div>

      <div class="stamp" id="stamp"></div>
    </div>
  </div>

<script>
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  function byId(id){ return document.getElementById(id); }

  function showScreen(name){
    byId('key-screen').style.display = (name === 'key') ? 'flex' : 'none';
    byId('dashboard').style.display = (name === 'dashboard') ? 'block' : 'none';
  }

  function colorVar(pct){
    if(pct >= 90) return 'var(--red)';
    if(pct >= 60) return 'var(--amber)';
    return 'var(--green)';
  }
  function statusWord(pct){
    if(pct >= 90) return 'critical';
    if(pct >= 60) return 'elevated';
    return 'normal';
  }

  function buildMeter(elId, pct){
    var el = byId(elId);
    var totalCells = 20;
    var onCells = Math.round((pct/100) * totalCells);
    var color = colorVar(pct);
    el.innerHTML = '';
    for(var i=0; i<totalCells; i++){
      var c = document.createElement('div');
      c.className = 'cell';
      if(i < onCells){ c.style.background = color; }
      el.appendChild(c);
    }
  }

  function applyStatus(elId, pct){
    var badge = byId(elId);
    var color = colorVar(pct);
    badge.textContent = statusWord(pct);
    badge.style.color = color;
    badge.style.borderColor = color;
  }

  function fmtTime(iso){
    var d = new Date(iso);
    return d.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function fmtCountdownReal(ms){
    if(ms <= 0) return 'now';
    var totalSec = Math.floor(ms/1000);
    var d = Math.floor(totalSec/86400);
    var h = Math.floor((totalSec % 86400)/3600);
    var m = Math.floor((totalSec % 3600)/60);
    var s = totalSec % 60;
    if(d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if(h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if(m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function fmtAgo(iso){
    if(!iso) return '--';
    var sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime())/1000));
    var d = Math.floor(sec/86400);
    var h = Math.floor((sec % 86400)/3600);
    var m = Math.floor((sec % 3600)/60);
    if(d > 0) return 'updated ' + d + 'd ' + h + 'h ago';
    if(h > 0) return 'updated ' + h + 'h ' + m + 'm ago';
    if(m > 0) return 'updated ' + m + 'm ago';
    return 'updated ' + sec + 's ago';
  }

  // Resets store the absolute reset time (ISO string) for countdown calculation.
  // For OpenCode we only get resetInSec from the API, so we compute the absolute
  // time at the moment we receive the data.
  var resets = {}; // { fiveHour, sevenDay, ocRolling, ocWeekly, ocMonthly }
  var lastFetchedAt = null;
  var pollHandle = null;

  // ---- provider visibility ----
  var hasClaude = false;
  var hasOpenCode = false;

  function updateProviderSections(){
    byId('claude-section').style.display = hasClaude ? '' : 'none';
    byId('opencode-section').style.display = hasOpenCode ? '' : 'none';
    byId('reset-claude').style.display = hasClaude ? '' : 'none';
    byId('reset-opencode').style.display = hasOpenCode ? '' : 'none';
  }

  // ---- error rendering ----
  function renderProviderError(prefix, error){
    if(!error){ return; }
    var el = byId(prefix + '-error');
    byId(prefix + '-error-kind').textContent = error.kind === 'auth' ? 'possible auth issue' : 'network error';
    byId(prefix + '-error-msg').textContent = error.message || '';
    el.style.display = 'flex';
    var badge = byId(prefix + '-badge');
    badge.textContent = 'error';
    badge.className = 'provider-badge err';
  }
  function clearProviderError(prefix){
    byId(prefix + '-error').style.display = 'none';
    var badge = byId(prefix + '-badge');
    badge.textContent = 'connected';
    badge.className = 'provider-badge ok';
  }

  // Dismiss buttons
  byId('claude-error-dismiss').addEventListener('click', function(){
    byId('claude-error').style.display = 'none';
  });
  byId('opencode-error-dismiss').addEventListener('click', function(){
    byId('opencode-error').style.display = 'none';
  });

  // ---- Claude rendering ----
  function renderClaudeUsage(usage, prepaidCredits, error){
    if(error){
      renderProviderError('claude', error);
      return;
    }
    clearProviderError('claude');
    if(!usage) return;

    var fh = usage.five_hour;
    var sd = usage.seven_day;

    byId('pct-5h').textContent = Math.round(fh.utilization);
    byId('pct-7d').textContent = Math.round(sd.utilization);
    buildMeter('meter-5h', fh.utilization);
    buildMeter('meter-7d', sd.utilization);
    applyStatus('status-5h', fh.utilization);
    applyStatus('status-7d', sd.utilization);
    byId('reset-5h-time').textContent = fmtTime(fh.resets_at);
    byId('reset-7d-time').textContent = fmtTime(sd.resets_at);

    resets.fiveHour = fh.resets_at;
    resets.sevenDay = sd.resets_at;

    var spendRow5h = byId('spend-5h-row');
    if(fh.used_dollars != null && fh.limit_dollars != null){
      spendRow5h.style.display = 'flex';
      byId('spend-5h').textContent = '$' + fh.used_dollars.toFixed(2) + ' of $' + fh.limit_dollars.toFixed(2);
    } else {
      spendRow5h.style.display = 'none';
    }
    var spendRow7d = byId('spend-7d-row');
    if(sd.used_dollars != null && sd.limit_dollars != null){
      spendRow7d.style.display = 'flex';
      byId('spend-7d').textContent = '$' + sd.used_dollars.toFixed(2) + ' of $' + sd.limit_dollars.toFixed(2);
    } else {
      spendRow7d.style.display = 'none';
    }

    var spendEnabled = (usage.extra_usage && usage.extra_usage.is_enabled) ||
      (usage.spend && usage.spend.enabled);
    byId('spend-tag').textContent = spendEnabled ? 'enabled' : 'disabled';

    renderExtraCredits(usage.extra_usage, prepaidCredits);
    renderScopedLimits(usage);
  }

  function fmtMinor(amountMinor, decimalPlaces, currency){
    var places = decimalPlaces == null ? 2 : decimalPlaces;
    var symbol = currency === 'USD' ? '$' : (currency || '') + ' ';
    return symbol + (Number(amountMinor) / Math.pow(10, places)).toFixed(places);
  }
  function fmtMoney(amount, decimalPlaces, currency){
    var symbol = currency === 'USD' ? '$' : (currency || '') + ' ';
    return symbol + Number(amount).toFixed(decimalPlaces == null ? 2 : decimalPlaces);
  }

  function renderExtraCredits(extraUsage, prepaidCredits){
    var row = byId('credits-row');
    if(!extraUsage || !extraUsage.is_enabled || extraUsage.used_credits == null){
      row.style.display = 'none';
      return;
    }
    row.style.display = 'flex';
    var text = fmtMinor(extraUsage.used_credits, extraUsage.decimal_places, extraUsage.currency);
    if(extraUsage.monthly_limit != null){
      text += ' of ' + fmtMinor(extraUsage.monthly_limit, extraUsage.decimal_places, extraUsage.currency) + ' monthly cap';
    }
    if(prepaidCredits && prepaidCredits.amount != null){
      text += ' (' + fmtMinor(prepaidCredits.amount, 2, prepaidCredits.currency) + ' remaining)';
    }
    byId('credits-used').textContent = text;
  }

  function renderScopedLimits(usage){
    var panel = byId('scoped-panel');
    var container = byId('scoped-limits');
    var all = usage.limits || [];
    var scoped = all.filter(function(l){
      return l.kind === 'weekly_scoped' && l.scope && l.scope.model && l.scope.model.display_name;
    });

    if(scoped.length === 0){
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    container.innerHTML = '';

    scoped.forEach(function(l){
      var name = l.scope.model.display_name;
      var pct = l.percent || 0;
      var active = l.is_active;
      var color = active ? colorVar(pct) : 'var(--dim)';
      var label = active ? statusWord(pct) : 'inactive';

      var row = document.createElement('div');
      row.className = 'scoped-row';

      var head = document.createElement('div');
      head.className = 'scoped-head';
      var nameEl = document.createElement('span');
      nameEl.className = 'scoped-name';
      nameEl.textContent = name;
      var badge = document.createElement('span');
      badge.className = 'status';
      badge.textContent = label;
      badge.style.color = color;
      badge.style.borderColor = color;
      head.appendChild(nameEl);
      head.appendChild(badge);

      var pctEl = document.createElement('div');
      pctEl.className = 'scoped-pct';
      pctEl.textContent = Math.round(pct) + '%';

      var meterEl = document.createElement('div');
      meterEl.className = 'meter';
      var totalCells = 20;
      var onCells = Math.round((pct/100) * totalCells);
      for(var i=0; i<totalCells; i++){
        var c = document.createElement('div');
        c.className = 'cell';
        if(i < onCells){ c.style.background = color; }
        meterEl.appendChild(c);
      }

      row.appendChild(head);
      row.appendChild(pctEl);
      row.appendChild(meterEl);
      container.appendChild(row);
    });
  }

  // ---- OpenCode rendering ----
  function renderOCWindow(prefix, win){
    var pct = win.usagePercent || 0;
    byId('pct-' + prefix).textContent = Math.round(pct);
    buildMeter('meter-' + prefix, pct);
    applyStatus('status-' + prefix, pct);

    // Compute absolute reset time from resetInSec
    var now = Date.now();
    var resetsAt = new Date(now + win.resetInSec * 1000).toISOString();
    resets[prefix] = resetsAt;
  }

  function renderOpenCodeUsage(data, error){
    if(error){
      renderProviderError('opencode', error);
      return;
    }
    clearProviderError('opencode');
    if(!data) return;

    renderOCWindow('oc-rolling', data.rollingUsage);
    renderOCWindow('oc-weekly', data.weeklyUsage);
    renderOCWindow('oc-monthly', data.monthlyUsage);
  }

  // ---- data fetching ----
  function fetchUsageOnce(){
    fetch('/api/usage').then(function(r){
      return r.json().then(function(body){
        if(body.claude) renderClaudeUsage(body.claude.usage, body.claude.prepaidCredits, body.claude.error);
        if(body.opencode) renderOpenCodeUsage(body.opencode.usage, body.opencode.error);
        lastFetchedAt = body.lastFetchedAt;
        byId('updated-ago').textContent = fmtAgo(lastFetchedAt);
        byId('stamp').textContent = lastFetchedAt ? ('last poll ' + lastFetchedAt) : '';
      });
    }).catch(function(e){
      console.error('usage fetch failed', e);
    });
  }

  function startDashboardPolling(){
    fetchUsageOnce();
    if(pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(fetchUsageOnce, 5000);
  }
  function stopDashboardPolling(){
    if(pollHandle){ clearInterval(pollHandle); pollHandle = null; }
  }

  // ---- auth: independent provider connections ----
  function updateKeyScreenState() {
    // Show/hide connected state for each provider
    if (hasClaude) {
      byId('claude-key-input').style.display = 'none';
      byId('claude-connect').style.display = 'none';
      byId('claude-connected-badge').style.display = 'inline';
    } else {
      byId('claude-key-input').style.display = '';
      byId('claude-connect').style.display = '';
      byId('claude-connected-badge').style.display = 'none';
    }
    if (hasOpenCode) {
      byId('opencode-key-input').style.display = 'none';
      byId('opencode-workspace-input').style.display = 'none';
      byId('opencode-connect').style.display = 'none';
      byId('opencode-connected-badge').style.display = 'inline';
    } else {
      byId('opencode-key-input').style.display = '';
      byId('opencode-workspace-input').style.display = '';
      byId('opencode-connect').style.display = '';
      byId('opencode-connected-badge').style.display = 'none';
    }
    // Show "back to dashboard" only if at least one provider is connected
    byId('back-to-dash').style.display = (hasClaude || hasOpenCode) ? '' : 'none';
  }

  function showKeyScreenWithState() {
    updateKeyScreenState();
    showScreen('key');
  }

  function connectProvider(claudeToken, opencodeToken, opencodeWorkspaceId) {
    var body = {};
    if (claudeToken) body.claudeToken = claudeToken;
    if (opencodeToken) body.opencodeToken = opencodeToken;
    if (opencodeWorkspaceId) body.opencodeWorkspaceId = opencodeWorkspaceId;

    return fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); });
  }

  // Claude connect button
  byId('claude-connect').addEventListener('click', function() {
    var token = byId('claude-key-input').value.trim();
    if (!token) {
      byId('claude-key-error').textContent = 'Paste a session key first.';
      return;
    }
    byId('claude-connect').disabled = true;
    byId('claude-key-error').textContent = '';
    connectProvider(token, undefined).then(function(res) {
      byId('claude-connect').disabled = false;
      if (res.ok) {
        byId('claude-key-input').value = '';
        checkStatusAndShow();
      } else {
        byId('claude-key-error').textContent = res.error || 'Something went wrong.';
      }
    }).catch(function() {
      byId('claude-connect').disabled = false;
      byId('claude-key-error').textContent = 'Request failed. Is the server running?';
    });
  });

  // OpenCode connect button
  byId('opencode-connect').addEventListener('click', function() {
    var token = byId('opencode-key-input').value.trim();
    var wsId = byId('opencode-workspace-input').value.trim();
    if (!token) {
      byId('opencode-key-error').textContent = 'Paste the auth cookie first.';
      return;
    }
    if (!wsId) {
      byId('opencode-key-error').textContent = 'Paste your workspace ID (from the URL).';
      return;
    }
    byId('opencode-connect').disabled = true;
    byId('opencode-key-error').textContent = '';
    connectProvider(undefined, token, wsId).then(function(res) {
      byId('opencode-connect').disabled = false;
      if (res.ok) {
        byId('opencode-key-input').value = '';
        byId('opencode-workspace-input').value = '';
        checkStatusAndShow();
      } else {
        byId('opencode-key-error').textContent = res.error || 'Something went wrong.';
      }
    }).catch(function() {
      byId('opencode-connect').disabled = false;
      byId('opencode-key-error').textContent = 'Request failed. Is the server running?';
    });
  });

  // Allow Enter on either input
  byId('claude-key-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') byId('claude-connect').click();
  });
  byId('opencode-key-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') byId('opencode-connect').click();
  });

  // "back to dashboard" link
  byId('back-to-dash').addEventListener('click', function() {
    if (hasClaude || hasOpenCode) {
      showScreen('dashboard');
    }
  });

  // "connect provider" link in top bar
  byId('connect-provider').addEventListener('click', function() {
    showKeyScreenWithState();
  });

  // ---- reset ----
  function resetProvider(provider){
    fetch('/api/reset-token', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ provider: provider })
    }).then(function(){
      checkStatusAndShow();
    });
  }

  byId('reset-claude').addEventListener('click', function(){
    hasClaude = false;
    updateProviderSections();
    resets.fiveHour = null;
    resets.sevenDay = null;
    resetProvider('claude');
  });
  byId('reset-opencode').addEventListener('click', function(){
    hasOpenCode = false;
    updateProviderSections();
    resets['oc-rolling'] = null;
    resets['oc-weekly'] = null;
    resets['oc-monthly'] = null;
    resetProvider('opencode');
  });

  // ---- status check on load ----
  function checkStatusAndShow(){
    fetch('/api/status').then(function(r){ return r.json(); }).then(function(s){
      hasClaude = s.hasClaudeToken;
      hasOpenCode = s.hasOpenCodeToken;
      updateProviderSections();
      if(s.hasClaudeToken || s.hasOpenCodeToken){
        showScreen('dashboard');
        startDashboardPolling();
      } else {
        stopDashboardPolling();
        showKeyScreenWithState();
      }
    }).catch(function(){
      showKeyScreenWithState();
    });
  }

  // ---- clock + countdowns ----
  setInterval(function(){
    var now = new Date();
    byId('clock').textContent = now.toLocaleTimeString();
    if(resets.fiveHour) byId('cd-5h').textContent = fmtCountdownReal(new Date(resets.fiveHour) - now);
    if(resets.sevenDay) byId('cd-7d').textContent = fmtCountdownReal(new Date(resets.sevenDay) - now);
    if(resets['oc-rolling']) byId('cd-oc-rolling').textContent = fmtCountdownReal(new Date(resets['oc-rolling']) - now);
    if(resets['oc-weekly']) byId('cd-oc-weekly').textContent = fmtCountdownReal(new Date(resets['oc-weekly']) - now);
    if(resets['oc-monthly']) byId('cd-oc-monthly').textContent = fmtCountdownReal(new Date(resets['oc-monthly']) - now);
    if(lastFetchedAt) byId('updated-ago').textContent = fmtAgo(lastFetchedAt);
  }, 1000);

  // ---- init ----
  checkStatusAndShow();
</script>
</body>
</html>
`;

Deno.serve(handle);
if (Deno.BrowserWindow) {
  const _win = new Deno.BrowserWindow({
    title: "AI Usage",
    height: 850,
    width: 1200,
  });
}
