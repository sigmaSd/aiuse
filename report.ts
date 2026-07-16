#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * usage_server.ts
 *
 * A tiny local server that shows your Claude.ai rate-limit usage.
 *
 * - The session key is entered once in the BROWSER (a key screen),
 *   never on the CLI.
 * - It's persisted with Deno's localStorage, so restarting the
 *   server doesn't make you re-enter it.
 * - A background loop polls claude.ai every POLL_INTERVAL_MS using
 *   the stored key.
 * - Errors (auth failures, network blips, etc.) are surfaced in a
 *   banner on the dashboard rather than guessed at. The app never
 *   auto-clears your token on a failed poll — sometimes a 401/403 is
 *   just a transient hiccup. Use the "reset token" button whenever
 *   you actually want to clear it and enter a new one.
 * - The organization id is resolved automatically from your session
 *   key via GET /api/organizations — nobody needs to go find it
 *   manually. Set CLAUDE_ORG_ID if you ever need to override it
 *   (e.g. multiple orgs on one account and you want a specific one).
 *
 * Run:
 *   deno run --allow-net --allow-env usage_server.ts
 *   then open http://localhost:8787
 *
 * Env vars (optional):
 *   PORT            default 8787
 *   CLAUDE_ORG_ID   override auto-detected org id (usually not needed)
 */

const ORG_ID_OVERRIDE = Deno.env.get("CLAUDE_ORG_ID"); // optional escape hatch
const PORT = Number(Deno.env.get("PORT") ?? "8787");
const POLL_INTERVAL_MS = 30_000;
const STORAGE_KEY = "claude_session_key";
const ORG_STORAGE_KEY = "claude_org_id";

class AuthError extends Error {}

interface WindowUsage {
  utilization: number;
  resets_at: string;
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
interface UsageResponse {
  five_hour: WindowUsage;
  seven_day: WindowUsage;
  spend?: { enabled: boolean };
  limits?: LimitEntry[];
}

// ---- token + org id storage: Deno's built-in Web Storage, persists across restarts ----
function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}
function setToken(v: string) {
  localStorage.setItem(STORAGE_KEY, v);
}
function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}
function getStoredOrgId(): string | null {
  return localStorage.getItem(ORG_STORAGE_KEY);
}
function setStoredOrgId(v: string) {
  localStorage.setItem(ORG_STORAGE_KEY, v);
}
function clearStoredOrgId() {
  localStorage.removeItem(ORG_STORAGE_KEY);
}

// ---- in-memory state ----
let latestUsage: UsageResponse | null = null;
let lastErrorKind: "auth" | "network" | null = null;
let lastErrorMessage: string | null = null;
let lastErrorAt: string | null = null;
let lastFetchedAt: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Nobody should have to go hunting for their org id. If CLAUDE_ORG_ID isn't
 * set, we ask claude.ai which org this session key belongs to (same cookie
 * auth as everything else here) and cache the answer.
 */
async function resolveOrgId(token: string): Promise<string> {
  if (ORG_ID_OVERRIDE) return ORG_ID_OVERRIDE;

  const cached = getStoredOrgId();
  if (cached) return cached;

  const res = await fetch("https://claude.ai/api/organizations", {
    headers: {
      "Cookie": `sessionKey=${token}`,
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (usage_server.ts personal script)",
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed while resolving org id: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(
      `could not list organizations: ${res.status} ${res.statusText}`,
    );
  }
  const orgs = await res.json() as Array<{ uuid: string; name?: string }>;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("this session key has no organizations attached");
  }
  const orgId = orgs[0].uuid;
  setStoredOrgId(orgId);
  return orgId;
}

async function fetchUsage(token: string): Promise<UsageResponse> {
  const orgId = await resolveOrgId(token);
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    {
      headers: {
        "Cookie": `sessionKey=${token}`,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (usage_server.ts personal script)",
      },
    },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function pollOnce() {
  const token = getToken();
  if (!token) return;
  try {
    latestUsage = await fetchUsage(token);
    lastErrorKind = null;
    lastErrorMessage = null;
    lastErrorAt = null;
    lastFetchedAt = new Date().toISOString();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof AuthError) {
      // Could be a genuinely expired token, or a transient blip (Cloudflare
      // challenge, brief outage, etc). We don't guess which — we surface it
      // and let the person decide whether to reset the token themselves.
      console.error("[usage_server] auth error on poll:", message);
      lastErrorKind = "auth";
    } else {
      console.error("[usage_server] poll failed:", message);
      lastErrorKind = "network";
    }
    lastErrorMessage = message;
    lastErrorAt = new Date().toISOString();
  }
}

function startPolling() {
  if (pollTimer !== undefined) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}
function stopPolling() {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

// resume polling automatically if a key was already saved from a previous run
if (getToken()) startPolling();

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
      hasToken: !!getToken(),
      lastErrorKind,
      lastErrorMessage,
      lastErrorAt,
      lastFetchedAt,
    });
  }

  if (url.pathname === "/api/token" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { token?: string }
      | null;
    const token = body?.token?.trim();
    if (!token) {
      return json({ ok: false, error: "Paste a session key first." }, 400);
    }
    setToken(token);
    clearStoredOrgId(); // re-resolve in case this is a different account
    lastErrorKind = null;
    lastErrorMessage = null;
    lastErrorAt = null;
    startPolling();
    return json({ ok: true });
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    if (!getToken()) return json({ error: "no_token" }, 401);
    return json({
      usage: latestUsage,
      lastFetchedAt,
      lastErrorKind,
      lastErrorMessage,
      lastErrorAt,
    });
  }

  if (url.pathname === "/api/reset-token" && req.method === "POST") {
    clearToken();
    clearStoredOrgId();
    stopPolling();
    latestUsage = null;
    lastErrorKind = null;
    lastErrorMessage = null;
    lastErrorAt = null;
    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>usage :: monitor</title>
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
    width:100%; max-width:420px;
    background:var(--panel); border:1px solid var(--grid); border-radius:2px;
    padding:28px 26px 24px; position:relative;
  }
  .key-card::before{
    content:"authentication"; position:absolute; top:-9px; left:16px;
    background:var(--bg); padding:0 8px; font-size:10px; letter-spacing:.14em; color:var(--dim);
  }
  .key-card h2{margin:0 0 8px; font-size:18px; font-weight:600;}
  .key-card p{margin:0 0 18px; font-size:12.5px; color:var(--dim); line-height:1.6;}
  .key-card code{color:var(--green); background:#0d1210; padding:1px 5px; border-radius:2px;}
  #key-input{
    width:100%; background:#0d1210; border:1px solid var(--grid); color:var(--text);
    font-family:var(--mono); font-size:13px; padding:10px 12px; border-radius:2px; outline:none;
  }
  #key-input:focus{border-color:var(--green-dim);}
  #key-submit{
    width:100%; margin-top:12px; background:var(--green-dim); color:#eafff2;
    border:1px solid var(--green); font-family:var(--mono); font-size:13px;
    padding:10px 12px; border-radius:2px; cursor:pointer; letter-spacing:.03em;
  }
  #key-submit:hover{background:var(--green); color:#06130c;}
  #key-submit:disabled{opacity:.5; cursor:default;}
  .key-help{margin-top:16px; font-size:11px; color:var(--dim); line-height:1.6; border-top:1px dashed var(--grid); padding-top:12px;}
  .key-help b{color:var(--text);}
  #key-error{min-height:16px; margin-top:10px; font-size:12px; color:var(--red);}

  /* ---------- dashboard ---------- */
  #dashboard{padding: 40px 20px 60px;}
  .wrap{max-width:860px;margin:0 auto;}
  .topbar{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--grid);padding-bottom:14px;margin-bottom:26px;flex-wrap:wrap;gap:8px;}
  .brand{font-size:13px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;}
  .brand b{color:var(--green);}
  .topbar-right{display:flex;align-items:center;gap:14px;font-size:12px;color:var(--dim);}
  .clock span{color:var(--text);}
  #reset-token{color:var(--dim);text-decoration:none;border-bottom:1px dotted var(--dim);cursor:pointer;}
  #reset-token:hover{color:var(--text);border-color:var(--text);}
  h1{font-size:22px;margin:0 0 4px;font-weight:600;letter-spacing:.02em;}
  .sub{color:var(--dim);font-size:13px;margin-bottom:28px;}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
  @media(max-width:640px){.grid2{grid-template-columns:1fr;}}
  .panel{background:var(--panel);border:1px solid var(--grid);border-radius:2px;padding:20px 22px 22px;position:relative;}
  .panel::before{content:attr(data-tag);position:absolute;top:-9px;left:16px;background:var(--bg);padding:0 8px;font-size:10px;letter-spacing:.14em;color:var(--dim);}
  .row-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
  .row-head .label{font-size:14px;color:var(--text);}
  .status{font-size:10px;letter-spacing:.1em;padding:2px 7px;border-radius:2px;border:1px solid var(--green-dim);color:var(--green);text-transform:uppercase;}
  .pct{font-size:40px;font-weight:700;line-height:1;margin-bottom:2px;font-variant-numeric:tabular-nums;}
  .pct small{font-size:16px;font-weight:400;color:var(--dim);}
  .meter{display:flex;gap:3px;margin:14px 0 12px;}
  .cell{flex:1;height:16px;background:#141a17;border-radius:1px;}
  .meta{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);border-top:1px dashed var(--grid);padding-top:10px;margin-top:4px;}
  .meta b{color:var(--text);font-weight:500;}
  .countdown{font-size:12px;color:var(--dim);margin-top:2px;}
  .countdown span{color:var(--amber);font-variant-numeric:tabular-nums;}
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
  .error-banner{
    display:none;
    align-items:center; justify-content:space-between; gap:12px;
    background:#1a1210; border:1px solid var(--red); color:#f2b8ae;
    font-size:12.5px; padding:10px 14px; border-radius:2px; margin-bottom:18px;
  }
  .error-banner .msg{line-height:1.5;}
  .error-banner .msg b{color:var(--red);text-transform:uppercase;font-size:10px;letter-spacing:.08em;display:block;margin-bottom:2px;}
  .error-banner button{
    flex-shrink:0; background:transparent; border:1px solid var(--red); color:#f2b8ae;
    font-family:var(--mono); font-size:11px; padding:6px 10px; border-radius:2px; cursor:pointer;
  }
  .error-banner button:hover{background:var(--red);color:#2a0d08;}
</style>
</head>
<body>

  <div id="key-screen" style="display:none">
    <div class="key-card">
      <h2>Connect your session</h2>
      <p>Paste your claude.ai <code>sessionKey</code> cookie to start polling your usage. Your organization is detected automatically — no need to look it up.</p>
      <input id="key-input" type="password" placeholder="sk-ant-sid01-..." autocomplete="off" spellcheck="false" />
      <button id="key-submit">Connect</button>
      <div id="key-error"></div>
      <div class="key-help">
        devtools &rarr; Application / Storage &rarr; Cookies &rarr; claude.ai &rarr; <b>sessionKey</b><br>
        Stored locally on this machine. Only used to poll your own usage.
      </div>
    </div>
  </div>

  <div id="dashboard" style="display:none">
    <div class="wrap">
      <div class="topbar">
        <div class="brand">claude <b>/</b> usage monitor</div>
        <div class="topbar-right">
          <span id="updated-ago">--</span>
          <span class="clock">local time <span id="clock">--:--:--</span></span>
          <a id="reset-token">reset token</a>
        </div>
      </div>

      <h1>Rate limit status</h1>
      <div class="sub">Session and weekly consumption for your organization, refreshed automatically.</div>

      <div class="error-banner" id="error-banner">
        <div class="msg"><b id="error-kind">error</b><span id="error-message"></span></div>
        <button id="error-dismiss">dismiss</button>
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
        <div class="note">
          Extra usage credits cover you once a plan limit is hit.
          <a href="https://support.claude.com/articles/12429409" target="_blank" rel="noopener">Learn more &rarr;</a>
        </div>
      </div>

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

  function applyStatus(prefix, pct){
    var badge = byId('status-' + prefix);
    var color = colorVar(pct);
    badge.textContent = statusWord(pct);
    badge.style.color = color;
    badge.style.borderColor = color;
  }

  function fmtTime(iso){
    var d = new Date(iso);
    return d.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function fmtCountdown(ms){
    if(ms <= 0) return 'now';
    var totalSec = Math.floor(ms/1000);
    var h = Math.floor(totalSec/3600);
    var m = Math.floor((totalSec % 3600)/60);
    var s = totalSec % 60;
    if(h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if(m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function fmtAgo(iso){
    if(!iso) return '--';
    var sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime())/1000));
    if(sec < 60) return 'updated ' + sec + 's ago';
    return 'updated ' + Math.floor(sec/60) + 'm ago';
  }

  var resets = { fiveHour: null, sevenDay: null };
  var lastFetchedAt = null;
  var pollHandle = null;
  var errorDismissed = false;

  function showError(kind, message){
    if(errorDismissed) return;
    var banner = byId('error-banner');
    byId('error-kind').textContent = kind === 'auth' ? 'possible auth issue' : 'network error';
    byId('error-message').textContent = message || '';
    banner.style.display = 'flex';
  }
  function clearError(){
    errorDismissed = false;
    byId('error-banner').style.display = 'none';
  }

  byId('error-dismiss').addEventListener('click', function(){
    errorDismissed = true;
    byId('error-banner').style.display = 'none';
  });

  function renderUsage(usage){
    var fh = usage.five_hour;
    var sd = usage.seven_day;

    byId('pct-5h').textContent = Math.round(fh.utilization);
    byId('pct-7d').textContent = Math.round(sd.utilization);
    buildMeter('meter-5h', fh.utilization);
    buildMeter('meter-7d', sd.utilization);
    applyStatus('5h', fh.utilization);
    applyStatus('7d', sd.utilization);
    byId('reset-5h-time').textContent = fmtTime(fh.resets_at);
    byId('reset-7d-time').textContent = fmtTime(sd.resets_at);

    resets.fiveHour = fh.resets_at;
    resets.sevenDay = sd.resets_at;

    var spendEnabled = usage.spend && usage.spend.enabled;
    byId('spend-tag').textContent = spendEnabled ? 'enabled' : 'disabled';

    renderScopedLimits(usage);
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

  function fetchUsageOnce(){
    fetch('/api/usage').then(function(r){
      if(r.status === 401){
        // no token stored server-side (e.g. someone hit /api/reset-token
        // elsewhere) — this is the only case we auto-switch screens for.
        stopDashboardPolling();
        showKeyScreen('');
        return;
      }
      return r.json().then(function(body){
        if(body.usage){ renderUsage(body.usage); }
        lastFetchedAt = body.lastFetchedAt;
        byId('updated-ago').textContent = fmtAgo(lastFetchedAt);
        byId('stamp').textContent = lastFetchedAt ? ('last poll ' + lastFetchedAt) : '';

        if(body.lastErrorKind){
          showError(body.lastErrorKind, body.lastErrorMessage);
        } else {
          clearError();
        }
      });
    }).catch(function(e){
      console.error('usage fetch failed', e);
      showError('network', 'Could not reach the local server.');
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

  function showKeyScreen(message){
    showScreen('key');
    byId('key-error').textContent = message || '';
  }

  byId('key-submit').addEventListener('click', function(){
    var token = byId('key-input').value.trim();
    if(!token){ byId('key-error').textContent = 'Paste a session key first.'; return; }
    byId('key-submit').disabled = true;
    fetch('/api/token', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ token: token })
    }).then(function(r){ return r.json(); }).then(function(res){
      byId('key-submit').disabled = false;
      if(res.ok){
        byId('key-input').value = '';
        byId('key-error').textContent = '';
        showScreen('dashboard');
        startDashboardPolling();
      } else {
        byId('key-error').textContent = res.error || 'Something went wrong.';
      }
    }).catch(function(){
      byId('key-submit').disabled = false;
      byId('key-error').textContent = 'Request failed. Is the server still running?';
    });
  });

  byId('key-input').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ byId('key-submit').click(); }
  });

  byId('reset-token').addEventListener('click', function(){
    stopDashboardPolling();
    fetch('/api/reset-token', { method: 'POST' }).then(function(){
      clearError();
      showKeyScreen('');
    });
  });

  setInterval(function(){
    var now = new Date();
    byId('clock').textContent = now.toLocaleTimeString();
    if(resets.fiveHour){ byId('cd-5h').textContent = fmtCountdown(new Date(resets.fiveHour) - now); }
    if(resets.sevenDay){ byId('cd-7d').textContent = fmtCountdown(new Date(resets.sevenDay) - now); }
    if(lastFetchedAt){ byId('updated-ago').textContent = fmtAgo(lastFetchedAt); }
  }, 1000);

  // initial state
  fetch('/api/status').then(function(r){ return r.json(); }).then(function(s){
    if(s.hasToken){
      showScreen('dashboard');
      startDashboardPolling();
    } else {
      showKeyScreen('');
    }
  }).catch(function(){
    showKeyScreen('');
  });
</script>
</body>
</html>
`;

console.log(`Usage dashboard running at http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handle);
