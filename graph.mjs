// Claude Code Efficiency — graph renderer (side-terminal view)
// Usage: node graph.mjs [score|cost|hours|tokens|prs|value]   (default: score)
//        node graph.mjs --watch [series]   (re-collect + redraw every 15 min — this is the engine)
// Animation: a reveal sweep plays on each redraw (line draws L→R, spend bar grows out).
//        Disable with NO_ANIM=1 (or it auto-disables when piped / NO_COLOR).

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { computeSeries } from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAILY = path.join(HERE, "daily.jsonl");
const COLLECT = path.join(HERE, "collect.mjs");
const REFRESH_MS = 15 * 60 * 1000;

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const series = args.find((a) => !a.startsWith("--")) || "score";

// ---- color (Okabe–Ito colorblind-safe palette, 24-bit truecolor) ----
const COLOR = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
const rgb = (c, s) => (COLOR ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m` : s);
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);
// "dim" = readable light grey (NOT the ANSI faint attribute, which renders too dark to read)
const dim = (s) => (COLOR ? `\x1b[38;2;176;176;176m${s}\x1b[0m` : s);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const OKABE = {
  orange: [230, 159, 0], sky: [86, 180, 233], green: [0, 158, 115], yellow: [240, 228, 66],
  blue: [0, 114, 178], vermillion: [213, 94, 0], purple: [204, 121, 167], grey: [153, 153, 153],
};
const PALETTE = [OKABE.sky, OKABE.orange, OKABE.green, OKABE.yellow, OKABE.purple, OKABE.vermillion, OKABE.blue];

// ---- animation (cursor control; flicker-free home-and-overwrite) ----
const HOME = "\x1b[H", CLR_DOWN = "\x1b[0J", HIDE_CUR = "\x1b[?25l", SHOW_CUR = "\x1b[?25h";
const CLR_ALL = "\x1b[2J\x1b[3J\x1b[H"; // full clear + wipe scrollback + home (used when the frame can't fit)
const EOL = "\x1b[K"; // erase to end of line — clears stale tail chars when a new line is shorter than the old one
// Append EOL to every line so a shorter new line overwrites the longer old line's leftover characters.
const withEol = (frame) => frame.replace(/\n/g, EOL + "\n") + EOL;
// COLOR already gates on isTTY-or-FORCE_COLOR, so ANIM doesn't need the redundant isTTY check.
// Removing it fixes FORCE_COLOR environments (e.g. PowerShell/Windows Terminal) where COLOR=true
// but isTTY is undefined, which made `COLOR && undefined` evaluate to false.
const ANIM = COLOR && !process.env.NO_ANIM;
const FRAMES = 24, FRAME_MS = 72;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeOut = (t) => 1 - (1 - t) * (1 - t); // snappy fill, settles at the end

function resample(data, W) {
  if (data.length >= W || data.length < 2) return data;
  const out = [];
  for (let x = 0; x < W; x++) {
    const t = (x / (W - 1)) * (data.length - 1);
    const i = Math.floor(t), f = t - i;
    out.push(i + 1 < data.length ? data[i] * (1 - f) + data[i + 1] * f : data[i]);
  }
  return out;
}
// resample to an exact length (handles up- and down-sampling) — used for tweening prev↔next
function toWidth(data, W) {
  if (data.length === W) return data.slice();
  if (data.length < 2) return Array(W).fill(data[0] ?? 0);
  const out = [];
  for (let x = 0; x < W; x++) {
    const t = (x / (W - 1)) * (data.length - 1);
    const i = Math.floor(t), f = t - i;
    out.push(i + 1 < data.length ? data[i] * (1 - f) + data[i + 1] * f : data[i]);
  }
  return out;
}
// integer stacked-bar widths summing to W (largest-remainder; min 1 per nonzero), preserving order
function widthsFor(costs, W) {
  const total = costs.reduce((a, c) => a + c, 0) || 1;
  const r = costs.map((c) => ({ exact: (c / total) * W, w: c > 0 ? Math.max(1, Math.floor((c / total) * W)) : 0 }));
  let used = r.reduce((a, x) => a + x.w, 0);
  for (const x of [...r].sort((a, b) => (b.exact % 1) - (a.exact % 1))) { if (used >= W) break; x.w++; used++; }
  while (used > W) { const big = [...r].sort((a, b) => b.w - a.w)[0]; if (!big || big.w <= 1) break; big.w--; used--; }
  return r.map((x) => x.w);
}

// revealFrac (0..1): only draw the leftmost portion of the line. yMin/yMax: fix the axis (for tween).
// colColors (length n): per-column line color (e.g. tint by dominant model/day); falls back to lineColor.
// labelStep: if set, gutter labels appear only at multiples of this value (placed on whichever row each
//   multiple lands on) instead of one label per row — keeps e.g. score labels at clean 0,10,…,100 at any height.
function plot(data, { height = 14, gutter = 9, fmt = (v) => v.toFixed(0), lineColor = OKABE.sky, width, revealFrac = 1, yMin, yMax, colColors, labelStep } = {}) {
  if (width && data.length > 1 && data.length < width) data = resample(data, width);
  const n = data.length;
  if (!n) return "(no data)";
  const rv = Math.max(0, Math.min(n, Math.round(n * revealFrac)));
  let min = yMin != null ? yMin : Math.min(...data), max = yMax != null ? yMax : Math.max(...data);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min, rows = height;
  const rowOf = (v) => Math.round(((max - v) / range) * (rows - 1));
  const grid = Array.from({ length: rows }, () => Array(n).fill(" "));
  for (let x = 0; x < n; x++) {
    const ry = rowOf(data[x]);
    if (x > 0) {
      const rp = rowOf(data[x - 1]);
      if (rp === ry) grid[ry][x] = "─";
      else {
        grid[ry][x] = ry < rp ? "╭" : "╰";
        grid[rp][x] = ry < rp ? "╯" : "╮";
        for (let r = Math.min(rp, ry) + 1; r < Math.max(rp, ry); r++) if (grid[r][x] === " ") grid[r][x] = "│";
      }
    } else grid[ry][x] = "┤";
  }
  // gutter labels: either one per row (default), or only at multiples of labelStep placed on their row
  let rowLabel = null;
  if (labelStep) {
    rowLabel = Array(rows).fill("");
    for (let r = 0; r < rows; r++) {
      const v = max - (r / (rows - 1)) * range;
      const nearest = Math.round(v / labelStep) * labelStep;
      if (nearest >= min - 1e-9 && nearest <= max + 1e-9 && rowOf(nearest) === r) {
        rowLabel[r] = fmt(nearest);
      }
    }
  }
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const v = max - (r / (rows - 1)) * range;
    const gut = (rowLabel ? rowLabel[r] : fmt(v)).padStart(gutter);
    let lineStr;
    if (colColors) {
      // render per-column, run-length grouping consecutive same-color cells to limit escape codes
      lineStr = "";
      let buf = "", bufCol = null, started = false;
      const flush = () => { if (started) lineStr += bufCol ? rgb(bufCol, buf) : buf; };
      for (let x = 0; x < n; x++) {
        const ch = x < rv ? grid[r][x] : " ";
        const col = ch === " " ? null : (colColors[x] || lineColor);
        if (started && col === bufCol) buf += ch;
        else { flush(); buf = ch; bufCol = col; started = true; }
      }
      flush();
    } else {
      lineStr = "";
      for (let x = 0; x < n; x++) lineStr += x < rv ? grid[r][x] : " ";
      lineStr = rgb(lineColor, lineStr);
    }
    lines.push(dim(gut + " ┤") + lineStr);
  }
  return lines.join("\n");
}

const loadRecords = () =>
  !fs.existsSync(DAILY) ? [] : fs.readFileSync(DAILY, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "m" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

let prevState = null; // { series, line:number[], costs:{model:cost}, score } — for value tweening across redraws

async function render() {
  const recs = loadRecords();
  if (!recs.length) { console.log("No data — run collect.mjs first."); return; }
  const { series: scored, provisional, window } = computeSeries(recs);
  const scoreByDate = new Map(scored.map((s) => [s.date, s.score]));

  // chart only on active days (cost or hours); PR-only days still fed the trailing windows
  const view = recs.filter((r) => r.cost_usd > 0 || r.active_hours > 0);

  const SERIES = {
    score: { label: `Efficiency score (${window}-day trailing, 0–100)`, val: (r) => scoreByDate.get(r.date) || 0, fmt: (v) => v.toFixed(0), color: OKABE.sky },
    cost: { label: "Cost ($/day)", val: (r) => r.cost_usd, fmt: (v) => "$" + v.toFixed(0), color: OKABE.vermillion },
    hours: { label: "Active hours/day", val: (r) => r.active_hours, fmt: (v) => v.toFixed(1), color: OKABE.green },
    tokens: { label: "Output tokens/day (K)", val: (r) => r.provisional_value_outk, fmt: (v) => v.toFixed(0), color: OKABE.blue },
    prs: { label: "PRs merged/day", val: (r) => (r.prs ? r.prs.completed : 0), fmt: (v) => v.toFixed(1), color: OKABE.purple },
    value: { label: "PR value/day (weighted)", val: (r) => r.value_pr || 0, fmt: (v) => v.toFixed(1), color: OKABE.orange },
  };
  const s = SERIES[series] || SERIES.score;
  const data = view.map(s.val);
  // model overlay: tint the efficiency line itself per-day by that day's dominant (most-$) model
  // (colors match "Spend by model" below) so you can see which models drove the score. Score-only, needs color.
  const colorByModel = series === "score" && COLOR;

  const GUT = 9;
  const chartW = 60;

  // ---- static pieces (computed once; do not animate) ----
  const head = [];
  head.push("  " + bold("Claude Code Efficiency") + (series !== "score" ? "  ·  " + dim(s.label) : ""));
  head.push("  " + dim("─".repeat(chartW + GUT + 2)));
  head.push("  " + rgb(s.color, s.label));

  const axis = Array(chartW).fill(" ");
  const put = (lbl, pos) => { pos = Math.max(0, Math.min(chartW - lbl.length, pos)); for (let i = 0; i < lbl.length; i++) axis[pos + i] = lbl[i]; };
  // label every Monday & Friday that has activity; skip a label that would collide with the previous one
  const nDays = view.length;
  let lastEnd = -1;
  for (let i = 0; i < nDays; i++) {
    const [yy, mm, dd] = view[i].date.split("-").map(Number);
    const wd = new Date(yy, mm - 1, dd).getDay(); // 1 = Monday, 5 = Friday
    if (wd !== 1 && wd !== 5) continue;
    let pos = nDays < 2 ? 0 : Math.round((i / (nDays - 1)) * (chartW - 1));
    pos = Math.max(0, Math.min(chartW - 5, pos));
    if (pos <= lastEnd) continue;
    put(view[i].date.slice(5), pos); // "MM-DD"
    lastEnd = pos + 5; // 5-char label → next must clear it (1-space gap)
  }
  const axisLine = dim(" ".repeat(GUT + 2) + axis.join(""));

  // tiles
  const last = view[view.length - 1], prev = view[view.length - 2] || last;
  const sc = scoreByDate.get(last.date) || 0, scp = scoreByDate.get(prev.date) || sc;
  const d = sc - scp, arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  const today = recs[recs.length - 1].date;
  let pr7 = 0, rev7 = 0, sp7 = 0;
  for (const r of recs) { const w = (new Date(today) - new Date(r.date)) / 864e5; if (w >= 0 && w < 7) { if (r.prs) { pr7 += r.prs.completed; rev7 += r.prs.reverted; } sp7 += r.story_points || 0; } }
  const hasJira = recs.some((r) => (r.story_points || 0) > 0);
  const delta = d > 0 ? rgb(OKABE.green, `${arrow}${Math.abs(d)}`) : d < 0 ? rgb(OKABE.vermillion, `${arrow}${Math.abs(d)}`) : dim(`${arrow}0`);
  const tiles = [];
  tiles.push("  " + bold(rgb(OKABE.sky, `Score ${sc}%`)) + `  ${delta} ` + dim(`vs prev active day   ·   ${view.length} active days`));
  tiles.push("  " + dim("This week:") + ` ${bold(String(pr7))} PRs merged · ${rev7} reverts` + (provisional ? "  " + rgb(OKABE.orange, "[PROVISIONAL: value=output tokens]") : ""));
  if (hasJira) tiles.push("  " + dim("Story points (separate tile):") + ` ${bold(String(sp7))} delivered last 7 days`);

  // spend by model — 100% stacked composition bar (Okabe–Ito, colorblind-safe)
  const tot = {}; let gc = 0, gh = 0, go = 0;
  for (const r of recs) {
    gc += r.cost_usd; gh += r.active_hours; go += r.output_tokens_total;
    for (const [m, t] of Object.entries(r.tokens || {})) {
      const a = (tot[m] ||= { in: 0, out: 0, cost: 0 });
      a.in += t.in + t.cacheCreate + t.cacheRead; a.out += t.out; a.cost += t.cost || 0;
    }
  }
  const rows = Object.entries(tot).map(([m, t]) => ({ m: m.replace("claude-", ""), tok: t.in + t.out, cost: t.cost }));
  rows.sort((a, b) => b.cost - a.cost);
  const totalCost = rows.reduce((x, r) => x + r.cost, 0) || 1;
  rows.forEach((r, i) => (r.color = PALETTE[i % PALETTE.length]));
  const W = GUT + chartW; // bar total width matches chart line total width (gutter + data area)
  rows.forEach((r) => { r.exact = (r.cost / totalCost) * W; r.w = r.cost > 0 ? Math.max(1, Math.floor(r.exact)) : 0; });
  let used = rows.reduce((a, r) => a + r.w, 0);
  for (const r of [...rows].sort((a, b) => (b.exact % 1) - (a.exact % 1))) { if (used >= W) break; r.w++; used++; }
  while (used > W) { const big = [...rows].sort((a, b) => b.w - a.w)[0]; if (!big || big.w <= 1) break; big.w--; used--; }
  // grow the bar L→R to a fraction of its full width
  const barAt = (p) => {
    let budget = Math.round(W * p), out = "";
    for (const r of rows) {
      const take = Math.max(0, Math.min(r.w, budget));
      if (take > 0) out += rgb(r.color, "█".repeat(take));
      budget -= take;
      if (budget <= 0) break;
    }
    return out;
  };
  const spendHead = "  " + bold("Spend by model") + dim(`  ·  $${gc.toFixed(0)} total`);
  const legend = rows.map((r) => {
    const pct = ((r.cost / totalCost) * 100).toFixed(0).padStart(3);
    return "   " + rgb(r.color, "■") + ` ${r.m.padEnd(12)} ${pct}%   $${r.cost.toFixed(0).padStart(4)}   ${dim(fmtN(r.tok) + " tok")}`;
  });
  const totalsLine = dim(`  Totals: $${gc.toFixed(0)} · ${gh.toFixed(0)} hrs · ${fmtN(go)} out tokens`);
  const spFoot = !hasJira ? `  Story points: (pending Jira token — see DESIGN.md)` : null;
  const seriesHelp = `  Series: score | cost | hours | tokens | prs | value`;

  // ---- per-day line colors: tint each column of the score line by that day's dominant model ----
  let lineColors = null;
  if (colorByModel) {
    const modelColor = {};
    rows.forEach((r) => (modelColor[r.m] = r.color)); // reuse spend-by-model colors (legend explains them)
    const domOf = (r) => {
      let best = null, bc = -1;
      for (const [m, t] of Object.entries(r.tokens || {})) { const c = t.cost || 0; if (c > bc) { bc = c; best = m; } }
      return best ? best.replace("claude-", "") : null;
    };
    const dom = view.map(domOf);
    lineColors = [];
    for (let x = 0; x < chartW; x++) {
      const i = view.length < 2 ? 0 : Math.round((x / (chartW - 1)) * (view.length - 1)); // nearest day (categorical)
      lineColors.push(modelColor[dom[i]] || s.color);
    }
  }

  // ---- size the chart to the viewport ----
  // The frame must fit in the terminal, or each \x1b[H re-home scrolls the top lines into
  // scrollback instead of overwriting (stacking frames). Shrink the chart to fit; if it still
  // can't fit (very short window), skip animation and draw once.
  // process.stdout.rows is undefined in FORCE_COLOR environments (isTTY not set).
  // Fall back to 40 when COLOR is active so fits/showCal math works without a real TTY row count.
  const ROWS = process.stdout.rows || (COLOR ? 40 : 0);
  const WATCH_FOOTER = watch ? 2 : 0;
  // Fixed lines excluding the calendar section (blank separator + 9 rows = 10 total).
  // Keeping them separate lets us hide the calendar on short terminals to preserve H=11 and animation.
  const fixedBase =
    head.length + 1 /*axis*/ + 1 /*blank*/ + tiles.length + 1 /*blank*/ +
    1 /*spendHead*/ + 1 /*bar*/ + 1 /*blank*/ + legend.length + 1 /*blank*/ +
    1 /*totals*/ + (spFoot ? 1 : 0) + 1 /*seriesHelp*/;
  const fixedScale = series === "score";
  // Score chart: always 11 rows so 0,10,20,…,100 each land on exactly one row.
  const H = fixedScale ? 11 : Math.max(6, Math.min(14, ROWS - (fixedBase + 10) - WATCH_FOOTER - 2));
  // Calendar is rendered side-by-side with spend (no extra vertical cost)
  const fixedLines = fixedBase;
  const fits = (ROWS - fixedLines - WATCH_FOOTER - 2) >= H;

  // ---- tween vs the previous render ----
  // First paint = reveal sweep. Changed data = morph old→new values. Unchanged = static redraw.
  const lineNext = toWidth(data, chartW);
  const lineFrom = prevState && prevState.series === series && prevState.line ? toWidth(prevState.line, chartW) : null;
  const prevCosts = prevState && prevState.series === series ? prevState.costs || {} : {};
  rows.forEach((r) => (r.costFrom = prevCosts[r.m] || 0));
  const prevScore = prevState && prevState.series === series && Number.isFinite(prevState.score) ? prevState.score : 0;

  const same = lineFrom && lineFrom.every((v, i) => Math.abs(v - lineNext[i]) < 1e-9) && sc === prevScore;
  // In watch mode always play the reveal sweep even when data hasn't changed — visual confirmation the cycle ran.
  const mode = !lineFrom ? "reveal" : same ? (watch ? "reveal" : "none") : "tween";
  const yMin = fixedScale ? 0 : Math.min(...lineNext, ...(lineFrom || lineNext));
  const yMax = fixedScale ? 100 : Math.max(...lineNext, ...(lineFrom || lineNext));

  const labelStep = fixedScale ? 10 : undefined;
  const lineAt = (p) =>
    mode === "tween"
      ? plot(lineNext.map((v, i) => lineFrom[i] + (v - lineFrom[i]) * p), { fmt: s.fmt, lineColor: s.color, gutter: GUT, width: chartW, height: H, yMin, yMax, colColors: lineColors, labelStep })
      : plot(lineNext, { fmt: s.fmt, lineColor: s.color, gutter: GUT, width: chartW, height: H, revealFrac: p, yMin, yMax, colColors: lineColors, labelStep });

  const scoreAt = (p) => {
    const shown = mode === "tween" ? Math.round(prevScore + (sc - prevScore) * p) : Math.round(sc * p);
    return "  " + bold(rgb(OKABE.sky, `Score ${shown}%`)) + `  ${delta} ` + dim(`vs prev active day   ·   ${view.length} active days`);
  };

  const barFrameAt = (p) => {
    if (mode !== "tween") return barAt(p); // grow L→R on first paint
    const ws = widthsFor(rows.map((r) => r.costFrom + (r.cost - r.costFrom) * p), W);
    return rows.map((r, i) => rgb(r.color, "█".repeat(ws[i]))).join("");
  };

  const assemble = (p) => {
    const out = [];
    out.push(...head);
    out.push(lineAt(p));
    out.push(axisLine);
    out.push("");
    out.push(scoreAt(p));      // tiles[0] is the score tile — rebuilt per frame for the count-up
    out.push(...tiles.slice(1));
    out.push("");
    out.push(spendHead);
    out.push("  " + barFrameAt(p));
    out.push("");
    out.push(...legend);
    out.push("");
    out.push(totalsLine);
    if (spFoot) out.push(spFoot);
    out.push(seriesHelp);
    return out.join("\n");
  };

  const animPrefix = fits ? HOME : CLR_ALL; // CLR_ALL avoids stacking when frame > terminal height
  if (ANIM) {
    process.stdout.write(HIDE_CUR);
    try {
      for (let f = 1; f <= FRAMES; f++) {
        process.stdout.write(animPrefix + withEol(assemble(easeOut(f / FRAMES))) + "\n" + CLR_DOWN);
        if (f < FRAMES) await sleep(FRAME_MS);
      }
    } finally {
      process.stdout.write(SHOW_CUR);
    }
  } else {
    process.stdout.write((fits ? HOME : CLR_ALL) + withEol(assemble(1)) + "\n" + CLR_DOWN);
  }

  // remember this render so the next refresh can tween from it
  prevState = { series, line: lineNext, costs: Object.fromEntries(rows.map((r) => [r.m, r.cost])), score: sc };
}

function collect() { try { execFileSync("node", [COLLECT], { stdio: "ignore" }); } catch { /* keep last data */ } }

if (watch) {
  const refreshLabel = REFRESH_MS >= 60000 ? `${Math.round(REFRESH_MS / 60000)} min` : `${Math.round(REFRESH_MS / 1000)}s`;
  let nextRefreshAt = 0; // epoch ms of the next scheduled refresh
  let rendering = false; // don't redraw the footer while render() is animating the frame

  const footerLine = () => {
    const rem = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    const mmss = `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`;
    return `  (refreshes every ${refreshLabel} · ${new Date().toLocaleTimeString()} · next in ${mmss})`;
  };
  // rewrite the footer in place (\r → col 0, EOL → clear stale tail); skip while a frame is rendering
  const drawFooter = () => { if (!rendering) process.stdout.write("\r" + dim(footerLine()) + EOL); };

  const tick = async () => {
    collect();
    rendering = true;
    await render();
    rendering = false;
    nextRefreshAt = Date.now() + REFRESH_MS;
    process.stdout.write("\n");   // blank separator; leaves the cursor on the footer line
    drawFooter();
  };

  await tick();
  setInterval(tick, REFRESH_MS);
  if (process.stdout.isTTY) setInterval(drawFooter, 1000); // live countdown between refreshes
} else {
  await render();
}
