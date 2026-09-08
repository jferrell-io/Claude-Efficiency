// Claude Code Efficiency — statusline reader
// Wire into settings.json: "statusLine": {"type":"command","command":"node \"/path/to/ClaudeEfficiency/statusline.mjs\""}
// Reads ONLY state.json (instant; never collects). Prints one compact line.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, "state.json");
try {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const d = s.delta_vs_prev || 0;
  const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  const mark = s.provisional ? "~" : "";
  // staleness: flag if state wasn't refreshed today (LOCAL date, matching collector bucketing)
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const stale = s.latest_date && s.latest_date !== today ? " (stale)" : "";
  process.stdout.write(`Eff ${mark}${s.latest_score}% ${s.sparkline || ""} ${arrow}${Math.abs(d)}${stale}`);
} catch {
  process.stdout.write("Eff —");
}
