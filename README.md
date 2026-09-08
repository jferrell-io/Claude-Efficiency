# Claude Code Efficiency

A personal productivity tracker for Claude Code sessions. Measures efficiency as
**value delivered ÷ resources consumed**, trending it over time as a 0–100 score alongside
raw cost, hours, token usage, PR throughput, and a model-spend breakdown.

No npm dependencies. Requires Node.js 22+, the Azure CLI (`az`), and an optional Jira API token.

<img width="697" height="673" alt="image" src="https://github.com/user-attachments/assets/a78ae822-718f-4d44-9978-f953043ed716" />

---

## Setup

Run once before first use:

```
node setup.mjs
```

This prompts for your personal settings (transcript path, AzDO org/project/repos, Jira URL and
token) and writes two local files:

- `config.json` — your settings (gitignored; not committed)
- `~/.claude/efficiency-jira.json` — your Jira API token (stored outside the repo)

Copy `config.example.json` to see the expected shape. To get a Jira API token, sign in to
atlassian.com → Profile → Security → API tokens.

---

## Running

```
node graph.mjs              # render once (default: score series)
node graph.mjs cost         # render a different series
node graph.mjs --watch      # collect + render every 15 minutes (the engine)
```

Available series: `score` `cost` `hours` `tokens` `prs` `value`

The `--watch` process is the collector. It calls `collect.mjs`, writes `daily.jsonl` and
`state.json`, then renders. The statusline reads `state.json` independently; it never
collects live and returns instantly.

Set `NO_ANIM=1` to disable the redraw animation. Set `NO_COLOR` to disable all color.

---

## Graphs

### Efficiency Score

**Purpose.** The primary view. One number — where you sit relative to your own recent
history — that you can glance at without interrupting your work session.

**What it shows.** A line chart of the 0–100 efficiency score for each active day, fixed
to a 0–100 y-axis with labels at every 10 points. The line is tinted per column by that
day's dominant model (the model with the highest dollar spend), reusing the same color
palette as the Spend by Model bar so the two views are consistent. Monday and Friday dates
are labeled on the x-axis where they fit without collision.

**Inputs.**
- Merged/completed pull requests from Azure DevOps (`az repos pr list`) across VC.API,
  VC.Web, and VC.Database — the unit of delivered value.
- Per-PR Jira ticket type (Story, Bug, Spike, Task, Sub-task, Chore, Epic) resolved via
  the Jira REST API, used to weight each PR.
- Whether a PR's source branch or title links to a ticket that also touched multiple repos
  (detected via the configured ticket prefix pattern, e.g. `PROJ-123`).
- Reverted PRs (title matches `^revert`), subtracted from value.
- Dollar cost per day, parsed from Claude Code transcript JSONL files using a per-model
  pricing table (see Spend by Model).
- Active hours per day, derived from transcript message timestamps (sessions split at a
  10-minute gap threshold).
- Per-model cost split, used to compute the right-sizing multiplier.

**Formula.**

Value for a given PR:

```
type_weight  =  Story → 3,  Bug/Spike → 2,  Task/Chore/Sub-task/Epic → 1  (default 2 without Jira)
repos_factor =  1.5 if the linked ticket spans more than one repo, else 1.0
value_pr     =  Σ ( type_weight × repos_factor )  −  reverts
```

Daily score uses a 7-day trailing window:

```
V  = Σ value_pr  over trailing 7 days  (rework-adjusted)
C  = Σ cost_usd  over trailing 7 days
H  = Σ active_hours  over trailing 7 days

cost_eff  =  V / C
time_eff  =  V / H
m         =  1 − 0.3 × premiumShare × lowcShare     (right-sizing multiplier, ∈ [0.7, 1.0])

score_raw =  cost_eff^0.6 × time_eff^0.4 × m        (weighted geometric mean)
score     =  100 × clamp( score_raw / EWMA_baseline, 0, 1.5 ) / 1.5
```

Where:
- `premiumShare` = fraction of trailing cost from premium models (Opus, Fable, Mythos).
- `lowcShare` = fraction of trailing PR value from low-complexity work (type_weight = 1).
- The EWMA baseline (`α = 0.3`) is seeded from the median of the first 5 positive raw
  scores so that early days are scored against a representative reference rather than
  themselves. After warm-up it tracks your recent norm, making 50–67 correspond to a
  "normal" day.

The exponents 0.6 and 0.4 bias the score slightly toward cost-efficiency; the sum equals
1 so the geometric mean is unit-free.

**Strengths.**
- Value is externally verified: a merged PR requires reviewer approval, not self-assessment.
- Geometric mean prevents a cheap day (low C) from masking a slow day (low H), or vice versa.
- Self-referential baseline means the score measures improvement relative to your own norm,
  not against an arbitrary target. 50 always reads as "about average for you."
- Reverted PRs directly subtract value; rework is penalized without extra instrumentation.
- Multi-repo work (full-stack features) earns 1.5× the value of single-repo work.
- Right-sizing penalizes premium model spend, but only when the delivered work was
  low-complexity — expensive models on hard problems are not penalized.
- Raw inputs are stored in `daily.jsonl`; changing any weight constant in `score.mjs`
  recomputes the entire history on the next run.
- Baseline adapts over time: a sustained improvement period shifts the norm upward so
  "good" keeps being challenged.

**Weaknesses.**
- The 7-day trailing window smooths out exceptional single days. A very high-value day
  raises the week's score but won't spike the chart the way a per-day view would.
- PR count can still be inflated by small, frequent merges even with type weighting. The
  multipliers partially mitigate this but cannot eliminate it.
- Jira integration is optional. Without it, all PRs default to `type_weight = 2` (Bug/Spike
  level), which may over- or under-weight depending on the actual mix of work.
- The right-sizing multiplier `m` is currently gentle (min ≈ 0.99 in practice) because most
  delivered value has been high-complexity. The `M_PENALTY` constant needs calibration over a
  longer period, especially if a Chore/Task-heavy week using Opus should score materially lower.
- The EWMA baseline has no floor. If you take a week off and return with lower throughput, the
  baseline gradually drops to meet the new norm. This is by design but means the score can stay
  "normal" through a sustained productivity decline.
- If Azure DevOps auth fails silently, the collector falls back to the most recently cached PR
  data. The score will be stale but will not visually signal the fallback unless you inspect the
  collect output.
- Story points are deliberately excluded from the score because sprint pointing is often
  unreliable, but this means the score does not capture effort on long-running tickets that
  accumulate work without a merge event.

---

### Cost

**Purpose.** Shows raw dollar spend per active day. Useful for spotting expensive sessions,
tracking model-mix cost impact over time, and providing context for score movements.

**Inputs.** Token counts from Claude Code transcript JSONL files, with a per-model pricing
table applied:

| Model tier | Input | Output | Cache write | Cache read |
|------------|-------|--------|-------------|------------|
| Opus / Fable / Mythos | $5/MTok | $25/MTok | 1.25× input | 0.1× input |
| Sonnet | $3/MTok | $15/MTok | 1.25× input | 0.1× input |
| Haiku | $1/MTok | $5/MTok | 1.25× input | 0.1× input |

Model names are normalized (date suffixes and `[1m]` markers stripped) before lookup. Unknown
models fall back to Opus pricing.

**What it shows.** A dynamic line chart (y-axis scales to data range). The label formats
values as whole dollars. Identifies which days were most expensive at a glance.

---

### Active Hours

**Purpose.** Shows how many hours each day Claude Code was actively in use. Together with
cost, it is one of the two denominators of the efficiency score.

**Inputs.** Message timestamps from all Claude Code transcript JSONL files under
`~/.claude/projects/`. The collector reads every `.jsonl`, extracts timestamps, groups them
into sessions (a gap of more than 10 minutes starts a new session), and sums session
durations. Messages with no timestamp or from `<synthetic>` are excluded.

**What it shows.** Hours per active day as a fractional value (e.g., `5.5`). Long days that
score poorly indicate high effort without proportional output. Short days that score well
indicate focused, high-leverage work.

**Limitations.** The 10-minute session gap is a heuristic. Long pauses (reading, thinking,
meeting) inside a session inflate the reported hours. Conversely, if you leave Claude Code
running overnight, a single late message extends the session into the next morning.

---

### Output Tokens

**Purpose.** A proxy for the volume of Claude's work product — responses, code, analysis.
Shown separately from cost because the token/cost ratio changes as the model mix shifts.

**Inputs.** `output_tokens` from transcript JSONL `message.usage` fields, summed per day.
Displayed in thousands (e.g., `120` = 120K tokens).

**What it shows.** A dynamic line chart of daily output token volume. Useful for identifying
unusually verbose or unusually terse sessions, and for spotting model-mix shifts before they
appear in cost.

**Limitations.** Output tokens measure verbosity, not quality. A day with dense, well-targeted
responses may produce fewer tokens than a day of exploratory back-and-forth, but the former
is likely more efficient.

---

### PRs Merged

**Purpose.** Raw PR throughput — how many pull requests were completed each day, unweighted.

**Inputs.** Completed PRs from Azure DevOps (`az repos pr list --status completed`),
filtered to your creator identity across the repos configured in `config.json`. Reverted PRs
are counted separately and shown in the weekly tile.

**What it shows.** Completed PRs per day. Gaps are visible as zero days. Spikes indicate
high-merge days that may or may not correspond to high-value work (the Value series captures
that distinction).

**Limitations.** Does not weight by PR complexity or scope. A day with five small bug fixes
and a day with one large feature look identical here. Use the Value series for a
complexity-adjusted view.

---

### PR Value

**Purpose.** Complexity-adjusted PR throughput — what the PRs on each day were actually worth,
before trailing-window aggregation and normalization.

**Inputs.** Same PR data as the PRs Merged series, with `type_weight` from Jira and
`repos_factor` from cross-repo ticket linking applied. Reverted PRs subtract 1.0 from the
daily value regardless of weight.

**What it shows.** The raw `value_pr` field per day: `Σ(type_weight × repos_factor) − reverts`.
A Story PR touching two repos contributes 4.5 (3 × 1.5). A reverted PR subtracts 1. Days with
no PRs are zero.

**Strengths over the PRs chart.** Distinguishes high-complexity days from high-count days.
A day shipping two Stories is worth more than a day closing five Tasks, which the PR count
chart cannot show.

**Limitations.** Values are not normalized, so they are hard to interpret in isolation. The
Efficiency Score applies the trailing window and EWMA normalization that makes the Value
series comparable across time.

---

### Spend by Model

**Purpose.** Shows the all-time composition of Claude API spend across model tiers, giving
context for the model-overlay coloring on the Efficiency Score line.

**What it shows.** A single 100%-wide stacked bar. Each segment represents one model's share
of total dollar spend, colored using the Okabe–Ito colorblind-safe palette. A legend beneath
the bar shows each model's percentage share, total dollar spend, and total tokens consumed.
The totals tile below the legend shows all-time cost, active hours, and output tokens.

**Inputs.** Per-model `tokens.<model>.cost` fields from every record in `daily.jsonl`,
accumulated across all tracked days.

**Segment width.** Each model's pixel-width is proportional to its cost share, allocated using
largest-remainder rounding so segments sum exactly to the bar width. Models with zero spend are
omitted.

**Interpretation.** The bar shows where money has gone over the entire tracked history. The
Efficiency Score's model-overlay uses the same colors, so a blue segment in the bar and a blue
day in the score line both mean "Sonnet-dominated." The right-sizing multiplier `m` in the score
formula responds to the premium-model share visible in this bar.

---

### Activity Calendar

**Purpose.** A birds-eye view of active days across the tracked history, showing both which
days had activity and how those days scored.

**What it shows.** A GitHub-style contribution calendar rendered as Unicode block characters.
Each cell is two characters wide and represents one day. Inactive days (no cost, no active
hours) render as dark grey. Active days are colored by that day's dominant model (matching
the Spend by Model palette) and their brightness scales with the efficiency score: a
high-scoring day in a Sonnet-heavy week is bright sky-blue; a low-scoring day in the same
week is a dim sky-blue.

The calendar is aligned to full weeks (Monday–Sunday). Month labels appear above the week
columns. The calendar starts at the first active day (padded back to the nearest Monday).

**Inputs.**
- `daily.jsonl` records for activity detection (`cost_usd > 0` or `active_hours > 0`).
- Efficiency score for each date, from the same `computeSeries()` call used for the score line.
- Dominant model per date (the model with highest `tokens.<model>.cost`).

**Strengths.** Immediately shows streaks, gaps, and clusters of high-scoring days. The
color-brightness encoding carries two dimensions (model + score) in a compact footprint
without requiring a separate legend.

**Limitations.** Cell brightness is a linear scale of `score / 100` down to a floor of 12%
brightness, so low-scoring days are dim but not invisible. A day with score = 0 (no PRs merged)
renders identically to a day with score = 5.

---

## Info Tiles

Three lines appear below the chart and above the Spend by Model bar.

- **Score tile.** Current score with a directional arrow (↑/↓/→) and the delta versus the
  previous active day. Also shows total active day count.
- **This week tile.** PRs merged and reverts in the last 7 calendar days. Marked
  `[PROVISIONAL: value=output tokens]` if no PR data has been collected yet.
- **Story points tile.** Story points delivered (on ticket PR-merge dates) in the last
  7 days, from Jira. Shown only if Jira integration is active.

Story points are displayed here and never fed into the score. They are a separate view of
planning throughput, not an input to efficiency.

---

## Storage

```
daily.jsonl   ← source of truth; one JSON record per day; today's row is upserted each run
state.json    ← statusline cache; latest score, sparkline, and delta; written each collect run
```

Raw inputs are stored (not the score). Changing any constant in `score.mjs` and re-running
recomputes all history from the stored records.

---

## Tuning

All scoring constants are at the top of `score.mjs`:

| Constant | Default | Effect |
|----------|---------|--------|
| `WINDOW` | 7 | Trailing window length in days |
| `ALPHA` | 0.3 | EWMA smoothing for the self-referential baseline |
| `EXP_COST` | 0.6 | Weight on cost-efficiency (V/C) in the geometric mean |
| `EXP_TIME` | 0.4 | Weight on time-efficiency (V/H); should sum to 1 with EXP_COST |
| `WARMUP` | 5 | Days used to seed the baseline on cold start |
| `M_PENALTY` | 0.3 | Maximum right-sizing penalty; m ∈ [1 − M_PENALTY, 1] |

After changing any constant, re-run `node collect.mjs` to recompute the full history.

---

## Potential Future Improvements

**Scoring model**
- **Calibration ratio.** `delivered_points / committed_points` — a separate tile showing
  estimation drift. Requires sprint-commitment data from Jira, which is not yet collected.
- **Tune the exponents and M_PENALTY** after accumulating several months of data. The current
  0.6/0.4 split and M_PENALTY = 0.3 are first-pass values; the right-sizing penalty in
  particular needs a Chore/Task-heavy Opus week to calibrate against.
- **Partial-day midnight rollover.** Today's row is correctly upserted each run, but the
  score changes throughout the day as more PRs merge. A finalization pass at midnight (or
  the next morning's first run) would lock the day's value permanently.
- **Reopened ticket penalty.** Tickets that bounce out of Done and back into progress represent
  rework not currently captured (unlike reverted PRs). Requires additional Jira polling.

**Data sources**
- **Sprint commitment.** Fetch the committed story-point count from the active sprint via
  Jira's board/sprint API to enable the calibration ratio tile.
- **PR review latency.** Time from PR opened to merged is a proxy for PR quality; quick
  reviews suggest smaller, cleaner changes.
- **Multiple contributors.** Currently filtered to a single creator (configured in `config.json`).
  A team mode would aggregate across all contributors.

**Infrastructure**
- **Async collection.** `collect.mjs` uses `execFileSync` for the `az` CLI call, which blocks
  the Node.js event loop. Switching to `spawn` with piped streams would allow a live spinner
  during the 5–10 second AzDO fetch.
- **Packaged binary.** The tool can be compiled to a self-contained executable using
  `bun build --compile`, eliminating the Node.js requirement for distribution. Blocked on
  policy; requires an unrestricted machine or a one-off exception.
