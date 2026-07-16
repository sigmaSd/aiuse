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
 * - If the key expires (401/403), the loop clears it automatically
 *   and the frontend falls back to the key screen on its own.
 *
 * Run:
 *   deno run --allow-net --allow-env usage_server.ts
 *   then open http://localhost:8787
 *
 * Env vars (optional):
 *   PORT            default 8787
 *   CLAUDE_ORG_ID   default is your org id below
 */

const ORG_ID = Deno.env.get("CLAUDE_ORG_ID") ??
  "4d41cc6d-e49f-43bf-98ee-307b1b4017c8";
const PORT = Number(Deno.env.get("PORT") ?? "8787");
const POLL_INTERVAL_MS = 30_000;
const STORAGE_KEY = "claude_session_key";

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

// ---- token storage: Deno's built-in Web Storage, persists across restarts ----
function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}
function setToken(v: string) {
  localStorage.setItem(STORAGE_KEY, v);
}
function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

// ---- in-memory state ----
let latestUsage: UsageResponse | null = null;
let lastError: "auth_expired" | "fetch_failed" | null = null;
let lastFetchedAt: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

async function fetchUsage(token: string): Promise<UsageResponse> {
  const res = await fetch(
    `https://claude.ai/api/organizations/${ORG_ID}/usage`,
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
    lastError = null;
    lastFetchedAt = new Date().toISOString();
  } catch (e) {
    console.error("error:", e);
    if (e instanceof AuthError) {
      console.log(
        "[usage_server] session key expired/invalid — clearing it; frontend will re-prompt.",
      );
      clearToken();
      lastError = "auth_expired";
      stopPolling();
    } else {
      console.error(
        "[usage_server] poll failed:",
        e instanceof Error ? e.message : e,
      );
      lastError = "fetch_failed";
    }
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
      authError: lastError === "auth_expired",
      lastError,
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
    lastError = null;
    startPolling();
    return json({ ok: true });
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    if (lastError === "auth_expired") {
      return json({ error: "auth_expired" }, 401);
    }
    if (!getToken() && !latestUsage) return json({ error: "no_token" }, 401);
    return json({ usage: latestUsage, lastFetchedAt, lastError });
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    clearToken();
    stopPolling();
    latestUsage = null;
    lastError = null;
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
  #change-key{color:var(--dim);text-decoration:none;border-bottom:1px dotted var(--dim);cursor:pointer;}
  #change-key:hover{color:var(--text);border-color:var(--text);}
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
</style>
</head>
<body>

  <div id="key-screen" style="display:none">
    <div class="key-card">
      <h2>Connect your session</h2>
      <p>Paste your claude.ai <code>sessionKey</code> cookie to start polling your usage.</p>
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
          <a id="change-key">change key</a>
        </div>
      </div>

      <h1>Rate limit status</h1>
      <div class="sub">Session and weekly consumption for your organization, refreshed automatically.</div>

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
        return r.json().then(function(body){
          stopDashboardPolling();
          if(body.error === 'auth_expired'){
            showKeyScreen('Your session expired. Paste a new key to keep monitoring.');
          } else {
            showKeyScreen('');
          }
        });
      }
      return r.json().then(function(body){
        if(body.usage){ renderUsage(body.usage); }
        lastFetchedAt = body.lastFetchedAt;
        byId('updated-ago').textContent = fmtAgo(lastFetchedAt);
        byId('stamp').textContent = lastFetchedAt ? ('last poll ' + lastFetchedAt) : '';
      });
    }).catch(function(e){ console.error('usage fetch failed', e); });
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

  byId('change-key').addEventListener('click', function(){
    stopDashboardPolling();
    fetch('/api/logout', { method: 'POST' }).then(function(){
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
    if(s.hasToken && !s.authError){
      showScreen('dashboard');
      startDashboardPolling();
    } else {
      showKeyScreen(s.authError ? 'Your session expired. Paste a new key to keep monitoring.' : '');
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
