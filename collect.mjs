// Claude Code Efficiency — collector
// Transcripts → cost/tokens/hours; AzDO → PR value (rework-adjusted, repos-touched-weighted).
// Writes daily.jsonl + state.json. No npm deps. Run: node collect.mjs
// See DESIGN.md. Value = merged-PR value (7-day trailing in scoring); output-tokens kept as fallback.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { computeSeries } from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAILY = path.join(HERE, "daily.jsonl");
const STATE = path.join(HERE, "state.json");

// ---- load personal config (written by setup.mjs) ----
const CONFIG_PATH = path.join(HERE, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("config.json not found. Run: node setup.mjs");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const TRANSCRIPT_ROOT = cfg.transcriptRoot;
const MULTI_REPO_FACTOR = 1.5;
// --- AzDO ---
const ORG     = cfg.azdo?.org     || "";
const PROJECT = cfg.azdo?.project || "";
const CREATOR = cfg.azdo?.creator || "";
const REPOS   = cfg.azdo?.repos   || [];
// --- Jira (optional; activates when the local secrets file has a token) ---
const JIRA_BASE      = cfg.jira?.baseUrl          || "";
const SP_FIELD       = cfg.jira?.storyPointsField || "customfield_10024";
const TICKET_PREFIX  = cfg.jira?.ticketPrefix     || "PROJ";
const TICKET_RE      = new RegExp(TICKET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-\\d+", "i");
const SECRETS        = cfg.secretsPath            || "";
const TYPE_WEIGHT = { Story: 3, Bug: 2, Spike: 2, Task: 1, "Sub-task": 1, Subtask: 1, Chore: 1, Epic: 1 };
const typeWeightOf = (t) => (t && t in TYPE_WEIGHT ? TYPE_WEIGHT[t] : t ? 2 : 1);

// --- pricing ($/MTok; cache read 0.1x in, cache write 1.25x in) ---
const PRICING = {
  "claude-opus-4-8": { in: 5, out: 25 }, "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 }, "claude-opus-4-5": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 }, "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 }, "claude-fable-5": { in: 10, out: 50 }, "claude-mythos-5": { in: 10, out: 50 },
};
const normModel = (m) => (m ? m.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "") : null);
function priceFor(m) {
  if (PRICING[m]) return PRICING[m];
  if (m.includes("opus")) return { in: 5, out: 25 };
  if (m.includes("sonnet")) return { in: 3, out: 15 };
  if (m.includes("haiku")) return { in: 1, out: 5 };
  if (m.includes("fable") || m.includes("mythos")) return { in: 10, out: 50 };
  return { in: 5, out: 25 };
}
const SESSION_GAP_MS = 10 * 60 * 1000;
function localDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- transcripts ----
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}
const days = new Map();
function dayRec(date) {
  if (!days.has(date)) days.set(date, { cost: 0, tokens: {}, outTotal: 0, stamps: [] });
  return days.get(date);
}
let files = 0, msgs = 0;
for (const file of walk(TRANSCRIPT_ROOT)) {
  files++;
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const date = o.timestamp ? localDate(o.timestamp) : null;
    if (!date) continue;
    const rec = dayRec(date);
    rec.stamps.push(new Date(o.timestamp).getTime());
    const u = o?.message?.usage; if (!u) continue;
    msgs++;
    const model = normModel(o?.message?.model) || "unknown";
    if (model === "<synthetic>") continue;
    const pr = priceFor(model);
    const tin = u.input_tokens || 0, tout = u.output_tokens || 0;
    const cc = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    const c = (tin * pr.in + tout * pr.out + cc * pr.in * 1.25 + cr * pr.in * 0.1) / 1e6;
    rec.cost += c;
    rec.outTotal += tout;
    const t = (rec.tokens[model] ||= { in: 0, out: 0, cacheCreate: 0, cacheRead: 0, cost: 0 });
    t.in += tin; t.out += tout; t.cacheCreate += cc; t.cacheRead += cr; t.cost += c;
  }
}
function activeHours(stamps) {
  if (stamps.length < 2) return 0;
  stamps.sort((a, b) => a - b);
  let total = 0, start = stamps[0], prev = stamps[0];
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] - prev > SESSION_GAP_MS) { total += prev - start; start = stamps[i]; }
    prev = stamps[i];
  }
  return (total + prev - start) / 3.6e6;
}

// ---- AzDO PRs ----
function fetchPRs() {
  const all = [];
  for (const r of REPOS) {
    let out;
    try {
      out = execFileSync("az", ["repos", "pr", "list", "--org", ORG, "--project", PROJECT,
        "--repository", r, "--status", "completed", "--creator", CREATOR, "--top", "200", "-o", "json"],
        { shell: true, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch { return null; } // auth/network failure → signal fallback
    let arr; try { arr = JSON.parse(out); } catch { return null; }
    for (const p of arr) {
      if (!p.closedDate) continue;
      const title = (p.title || "").trim();
      const src = p.sourceRefName || "";
      const tk = (src.match(TICKET_RE) || title.match(TICKET_RE) || [null])[0];
      all.push({
        repo: r, id: p.pullRequestId, date: localDate(p.closedDate),
        ticket: tk ? tk.toUpperCase() : null, revert: /^revert\b/i.test(title),
      });
    }
  }
  return all;
}

function loadSecrets() {
  try { const s = JSON.parse(fs.readFileSync(SECRETS, "utf8")); if (s.email && s.token) return s; } catch {}
  return null;
}
// fetch issuetype + story points for a set of ticket keys (Jira Cloud REST, token auth, no deps)
async function fetchJira(ticketKeys, sec) {
  const base = sec.baseUrl || JIRA_BASE;
  const auth = "Basic " + Buffer.from(sec.email + ":" + sec.token).toString("base64");
  const map = new Map(); const keys = [...ticketKeys];
  for (let i = 0; i < keys.length; i += 50) {
    const batch = keys.slice(i, i + 50);
    const res = await fetch(base + "/rest/api/3/search/jql", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql: `key in (${batch.join(",")})`, fields: ["issuetype", SP_FIELD], maxResults: 100 }),
    });
    if (!res.ok) throw new Error("jira " + res.status);
    const j = await res.json();
    for (const is of j.issues || []) map.set(is.key, { type: is.fields?.issuetype?.name || null, sp: is.fields?.[SP_FIELD] ?? null });
  }
  return map;
}

let prs = fetchPRs();
let azOk = prs !== null;
// fallback: reuse PR fields from existing daily.jsonl so az failure doesn't zero out value
const priorPR = new Map();
if (!azOk && fs.existsSync(DAILY)) {
  for (const l of fs.readFileSync(DAILY, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.prs || r.value_pr != null) priorPR.set(r.date, { prs: r.prs, value_pr: r.value_pr, value_lowc: r.value_lowc });
  }
}

// repos-touched: ticket → set of repos
const ticketRepos = new Map();
if (azOk) for (const p of prs) if (p.ticket) (ticketRepos.get(p.ticket) || ticketRepos.set(p.ticket, new Set()).get(p.ticket)).add(p.repo);
const reposFactor = (ticket) => (ticket && ticketRepos.get(ticket)?.size > 1 ? MULTI_REPO_FACTOR : 1.0);

// Jira: fetch issuetype + story points for tickets referenced by PRs
const sec = loadSecrets();
let jiraMap = new Map(), jiraOk = false;
if (sec) {
  const keys = new Set();
  if (azOk) {
    for (const p of prs) if (p.ticket && !p.revert) keys.add(p.ticket);
  } else {
    for (const r of priorPR.values()) if (r.prs?.tickets) for (const t of r.prs.tickets) keys.add(t);
  }
  try { jiraMap = await fetchJira(keys, sec); jiraOk = true; } catch (e) { console.error("Jira fetch failed:", e.message); }
}
const typeW = (ticket) => (jiraOk ? typeWeightOf(jiraMap.get(ticket)?.type) : 1);

// per-day PR aggregation (value = type_weight × repos_touched − reverts)
const prByDate = new Map();
if (azOk) for (const p of prs) {
  if (!p.date) continue;
  const a = prByDate.get(p.date) || prByDate.set(p.date, { completed: 0, reverted: 0, by_repo: {}, value: 0, value_lowc: 0, tickets: new Set() }).get(p.date);
  if (p.revert) { a.reverted++; a.value -= 1; }
  else {
    const w = typeW(p.ticket);
    const v = w * reposFactor(p.ticket);
    a.completed++; a.value += v;
    if (w <= 1) a.value_lowc += v; // low-complexity = type_weight 1 (Task/Chore/Sub-task) → feeds right-sizing m
    a.by_repo[p.repo] = (a.by_repo[p.repo] || 0) + 1;
    if (p.ticket) a.tickets.add(p.ticket);
  }
}

// story points credited on each ticket's latest PR-merge date (dedup per ticket)
const spByDate = new Map();
if (jiraOk) {
  const ticketLatest = new Map(); // ticket → latest merge date
  if (azOk) {
    for (const p of prs) if (p.ticket && !p.revert && p.date) {
      if (!ticketLatest.has(p.ticket) || p.date > ticketLatest.get(p.ticket)) ticketLatest.set(p.ticket, p.date);
    }
  } else {
    for (const [date, r] of priorPR) if (r.prs?.tickets) for (const t of r.prs.tickets) {
      if (!ticketLatest.has(t) || date > ticketLatest.get(t)) ticketLatest.set(t, date);
    }
  }
  for (const [ticket, date] of ticketLatest) {
    const sp = jiraMap.get(ticket)?.sp; if (typeof sp === "number" && sp > 0) spByDate.set(date, (spByDate.get(date) || 0) + sp);
  }
}

// ---- union of token-days and PR-days ----
const allDates = new Set([...days.keys(), ...prByDate.keys(), ...priorPR.keys()]);
const dates = [...allDates].sort();
const records = dates.map((date) => {
  const r = days.get(date) || { cost: 0, tokens: {}, outTotal: 0, stamps: [] };
  let prsField = null, value_pr = 0, value_lowc = 0;
  if (azOk) {
    const a = prByDate.get(date);
    if (a) { prsField = { completed: a.completed, reverted: a.reverted, by_repo: a.by_repo, tickets: [...a.tickets] }; value_pr = +a.value.toFixed(2); value_lowc = +a.value_lowc.toFixed(2); }
  } else if (priorPR.has(date)) {
    const pp = priorPR.get(date); prsField = pp.prs || null; value_pr = pp.value_pr || 0; value_lowc = pp.value_lowc || 0;
  }
  return {
    date,
    cost_usd: +r.cost.toFixed(4),
    active_hours: +activeHours(r.stamps).toFixed(3),
    output_tokens_total: r.outTotal,
    provisional_value_outk: +(r.outTotal / 1000).toFixed(2),
    value_pr,
    value_lowc,
    prs: prsField,
    tokens: r.tokens,
    tickets: prsField ? prsField.tickets : null,
    story_points: spByDate.get(date) || 0, // credited on ticket's PR-merge date
  };
});
fs.writeFileSync(DAILY, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---- score + state ----
const { series, baseline, provisional, window } = computeSeries(records);
const scoreByDate = new Map(series.map((s) => [s.date, s.score]));
const BARS = "▁▂▃▄▅▆▇█";
const last14 = series.slice(-14).map((s) => BARS[Math.min(7, Math.floor(s.score / 12.5))]).join("");
const latest = series.length ? series[series.length - 1].score : 0;
const prev = series.length > 1 ? series[series.length - 2].score : latest;

// 7-day PR throughput for the tile
const today = dates[dates.length - 1];
let pr7 = 0, rev7 = 0, sp7 = 0;
for (const r of records) {
  const within = (new Date(today) - new Date(r.date)) / 864e5;
  if (within >= 0 && within < 7) { if (r.prs) { pr7 += r.prs.completed; rev7 += r.prs.reverted; } sp7 += r.story_points || 0; }
}

fs.writeFileSync(STATE, JSON.stringify({
  generated_at: new Date().toISOString(),
  latest_date: today || null,
  latest_score: latest,
  delta_vs_prev: latest - prev,
  baseline: +baseline.toFixed(3),
  sparkline: last14,
  days: records.length,
  provisional,                 // false once PR value is active
  window_days: window,         // 7 = trailing-week score
  prs_last7: pr7, reverts_last7: rev7, points_last7: sp7,
  azdo_ok: azOk, jira_ok: jiraOk,
}, null, 2));

console.log(`files=${files} msgs=${msgs} days=${records.length} azdo=${azOk ? "OK" : "FALLBACK"} jira=${jiraOk ? "OK" : "off"}`);
console.log(`PRs fetched: ${azOk ? prs.length : "(reused prior)"}  | 7-day: ${pr7} merged, ${rev7} reverts, ${sp7} pts`);
console.log(`latest ${today}: score=${latest} (Δ${latest - prev >= 0 ? "+" : ""}${latest - prev}) ${window}-day window  provisional=${provisional}`);
console.log(`spark=${last14}`);
