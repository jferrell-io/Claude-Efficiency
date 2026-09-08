// Shared scoring — imported by collect.mjs and graph.mjs so they never drift.
// Value = 7-day TRAILING PR value (rework-adjusted) ÷ trailing cost & hours.
// Falls back to per-day provisional output-token value if no PR data exists.

// ---- tunables (all score knobs live here; raw inputs are stored so re-tuning recomputes history) ----
export const WINDOW = 7;     // trailing-window length in days
export const ALPHA = 0.3;    // EWMA smoothing for the self-referential baseline
export const EXP_COST = 0.6; // weight on cost-efficiency (value/$) in the geometric mean
export const EXP_TIME = 0.4; // weight on time-efficiency (value/hr); EXP_COST + EXP_TIME should = 1
export const WARMUP = 5;     // # of early positive days used to seed the baseline (cold-start)
export const M_PENALTY = 0.3; // max right-sizing penalty: m ∈ [1 - M_PENALTY, 1]

// "premium" model tiers — using these on low-complexity work is what right-sizing penalizes
const isPremium = (model) => /opus|fable|mythos/i.test(model || "");
function premiumCostOf(rec) {
  let c = 0;
  for (const [m, t] of Object.entries(rec.tokens || {})) if (isPremium(m)) c += t.cost || 0;
  return c;
}

function shift(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Cold-start: seed the baseline from the median of the first WARMUP positive raws,
// so early days are scored against a representative reference instead of against day 1.
function seedBaseline(vals) {
  const pos = vals.filter((x) => x > 0).slice(0, WARMUP).sort((a, b) => a - b);
  if (!pos.length) return 1;
  const mid = Math.floor(pos.length / 2);
  return pos.length % 2 ? pos[mid] : (pos[mid - 1] + pos[mid]) / 2;
}

function normalize(series, key) {
  let base = seedBaseline(series.map((o) => o[key]));
  for (const o of series) {
    if (o[key] > 0) {
      o.score = Math.round((100 * Math.min(Math.max(o[key] / base, 0), 1.5)) / 1.5);
      base = ALPHA * o[key] + (1 - ALPHA) * base;
    } else o.score = 0;
  }
  return base;
}

// Right-sizing multiplier m: penalizes premium-model spend ONLY to the extent the
// trailing window's delivered work was low-complexity. m = 1 - M_PENALTY·premiumShare·lowcShare.
// Degrades gracefully — no Jira (lowcValue=0) or no premium spend → m = 1 (no penalty).
function rightSizing(premiumC, totalC, lowcV, totalV) {
  const premiumShare = totalC > 0 ? premiumC / totalC : 0;
  const lowcShare = totalV > 0 ? Math.min(lowcV / totalV, 1) : 0;
  return 1 - M_PENALTY * premiumShare * lowcShare;
}

// records: sorted-asc array of {date, cost_usd, active_hours, value_pr, value_lowc, provisional_value_outk, tokens}
export function computeSeries(records) {
  const hasPR = records.some((r) => (r.value_pr || 0) > 0);
  const byDate = new Map(records.map((r) => [r.date, r]));

  if (hasPR) {
    const series = records.map((r) => {
      let V = 0, C = 0, H = 0, premiumC = 0, lowcV = 0;
      for (let k = 0; k < WINDOW; k++) {
        const rec = byDate.get(shift(r.date, -k));
        if (rec) {
          V += rec.value_pr || 0; C += rec.cost_usd || 0; H += rec.active_hours || 0;
          lowcV += rec.value_lowc || 0; premiumC += premiumCostOf(rec);
        }
      }
      V = Math.max(V, 0);
      const m = rightSizing(premiumC, C, lowcV, V);
      const raw = V > 0 && C > 0 && H > 0
        ? Math.pow(V / C, EXP_COST) * Math.pow(V / H, EXP_TIME) * m : 0;
      return { date: r.date, raw, V: +V.toFixed(2), C: +C.toFixed(2), H: +H.toFixed(2), m: +m.toFixed(3) };
    });
    const baseline = normalize(series, "raw");
    return { series, baseline, provisional: false, window: WINDOW };
  }

  // fallback: per-day provisional (output tokens). No ticket data → no right-sizing.
  const series = records.map((r) => {
    const v = r.provisional_value_outk || 0;
    const raw = v > 0 && r.cost_usd > 0 && r.active_hours > 0
      ? Math.pow(v / r.cost_usd, EXP_COST) * Math.pow(v / r.active_hours, EXP_TIME) : 0;
    return { date: r.date, raw, V: v, C: r.cost_usd, H: r.active_hours, m: 1 };
  });
  const baseline = normalize(series, "raw");
  return { series, baseline, provisional: true, window: 1 };
}
