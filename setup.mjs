// Claude Code Efficiency — first-time setup
// Run once: node setup.mjs
// Prompts for personal settings, writes config.json and the Jira secrets file.

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "config.json");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (label, def) => new Promise((resolve) => {
  const hint = def ? ` [${def}]` : "";
  rl.question(`  ${label}${hint}: `, (ans) => resolve(ans.trim() || def || ""));
});

function detectAzdoEmail() {
  try {
    const out = execFileSync("az", ["account", "show", "-o", "json"],
      { shell: true, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return JSON.parse(out).user?.name || null;
  } catch { return null; }
}

const home = os.homedir();
const defaultTranscriptRoot = path.join(home, ".claude", "projects");
const defaultSecretsPath = path.join(home, ".claude", "efficiency-jira.json");

console.log("");
console.log("  Claude Code Efficiency -- Setup");
console.log("  ================================");
console.log("  Press Enter to accept defaults shown in [brackets].");
console.log("");

// ---- Transcripts
console.log("  Transcripts");
console.log("  -----------");
const transcriptRoot = await ask("Claude .claude/projects path", defaultTranscriptRoot);

// ---- AzDO
console.log("");
console.log("  Azure DevOps  (leave org URL blank to skip PR data)");
console.log("  -------------------------------------------------------");
const detectedEmail = detectAzdoEmail();
if (detectedEmail) console.log(`  Detected AzDO account: ${detectedEmail}`);
const azdoOrg     = await ask("AzDO org URL", "https://dev.azure.com/yourorg");
const azdoProject = await ask("AzDO project", "");
const creator     = await ask("Your AzDO email", detectedEmail || "");
const reposInput  = await ask("Repos to track (comma-separated)", "");
const repos       = reposInput.split(",").map((s) => s.trim()).filter(Boolean);

// ---- Jira
console.log("");
console.log("  Jira  (leave email blank to skip story points)");
console.log("  -------------------------------------------------");
const jiraBase      = await ask("Jira base URL", "https://yourorg.atlassian.net");
const jiraSpField   = await ask("Story points field ID", "customfield_10024");
const ticketPrefix  = await ask("Jira ticket prefix (e.g. PROJ for PROJ-123)", "PROJ");
const jiraEmail     = await ask("Your Jira email", creator || "");
console.log("  To get an API token: sign in to atlassian.com -> Profile -> Security -> API tokens");
const jiraToken   = await ask("Jira API token (paste; will be stored locally, not in config.json)", "");
const secretsPath = await ask("Jira secrets file path", defaultSecretsPath);

rl.close();

// ---- Write config.json
const config = {
  transcriptRoot,
  azdo: { org: azdoOrg, project: azdoProject, creator, repos },
  jira:  { baseUrl: jiraBase, storyPointsField: jiraSpField, ticketPrefix },
  secretsPath,
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
console.log("");
console.log(`  [ok] config.json written to ${CONFIG_PATH}`);

// ---- Write secrets file
if (jiraEmail && jiraToken) {
  fs.writeFileSync(secretsPath, JSON.stringify({ email: jiraEmail, token: jiraToken }) + "\n");
  console.log(`  [ok] Jira token saved to ${secretsPath}`);
} else {
  console.log("  [warn] Jira email or token was blank -- skipping secrets file.");
  console.log("         Story points will show as pending until you add the token.");
  console.log(`         File expected at: ${secretsPath}`);
  console.log(`         Shape: {"email":"you@company.com","token":"your-api-token"}`);
}

// ---- Statusline hint
const statuslineScript = path.join(HERE, "statusline.mjs");
const statuslineCmd = statuslineScript.replace(/\\/g, "\\\\");
console.log("");
console.log("  Statusline setup");
console.log("  -----------------");
console.log("  To show the efficiency score in your Claude Code status bar,");
console.log("  add this to ~/.claude/settings.json:");
console.log("");
console.log(`    "statusLine": {`);
console.log(`      "type": "command",`);
console.log(`      "command": "node \\"${statuslineCmd}\\""`);
console.log(`    }`);

// ---- Next steps
console.log("");
console.log("  Next steps");
console.log("  -----------");
console.log("  1. node collect.mjs          -- collect today's data");
console.log("  2. node graph.mjs            -- view the dashboard");
console.log("  3. node graph.mjs --watch    -- auto-refresh every 15 min");
console.log("");
