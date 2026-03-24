require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const SKILLS_DIR = path.join(__dirname, "skills");

// ── Account Management ────────────────────────────────────────
// Accounts are loaded from the ACCOUNTS environment variable on Railway.
// Format: ACCOUNTS=Barimelts:746-735-8073,KateAndWendy:123-456-7890
// To add a new client: go to Railway → Variables → edit ACCOUNTS → add new entry → redeploy.
// No code changes ever needed.

function loadAccounts() {
  const ACCOUNTS = {};
  const raw = process.env.ACCOUNTS || "Barimelts:746-735-8073";

  raw.split(",").forEach(entry => {
    const parts = entry.trim().split(":");
    if (parts.length < 2) return;
    const name = parts[0].trim();
    const id = parts.slice(1).join(":").trim();
    if (!name || !id) return;

    // Register under multiple key variations for flexible matching
    const keys = [
      name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      ...name.toLowerCase().split(/[\s&,_-]+/).filter(w => w.length > 2),
    ];
    const unique = [...new Set(keys)];
    unique.forEach(key => { ACCOUNTS[key] = { id, name }; });
  });

  return ACCOUNTS;
}

const ACCOUNTS = loadAccounts();

function getUniqueAccounts() {
  const seen = new Set();
  return Object.values(ACCOUNTS).filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function detectAccount(question) {
  const q = question.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    if (q.includes(key)) return account;
  }
  const unique = getUniqueAccounts();
  if (unique.length === 1) return unique[0];
  return null;
}

// ── Skills ────────────────────────────────────────────────────
const SKILLS = {
  "google-ads-account-audit": ["account audit","audit","account health","what should i fix","account review","where to start","google ads diagnostic","taking over","top issues","biggest problems"],
  "google-ads-ad-copy": ["ad copy","headline","rsa","write ads","improve my ads","description copy","cta copy","value proposition"],
  "google-ads-ad-extension-audit": ["extension audit","asset audit","missing extensions","extension coverage","sitelink audit","callout audit"],
  "google-ads-ad-extensions": ["ad extensions","sitelinks","callouts","structured snippets","call extension","lead form","image extension","ad assets"],
  "google-ads-anomaly-detection": ["performance drop","cpa spike","impressions dropped","ctr dropped","conversions disappeared","spend increased","anomaly","diagnose","went wrong","monitoring","why did","what happened"],
  "google-ads-attribution": ["attribution","data-driven attribution","last click","assisted conversions","conversion window","multi-touch","which campaign is driving"],
  "google-ads-audiences": ["audience","remarketing","rlsa","customer match","lookalike","in-market","custom intent","retargeting"],
  "google-ads-audit-ecommerce": ["ecommerce audit","shopping audit","roas audit","product feed","pmax","cart abandonment"],
  "google-ads-audit-leadgen": ["lead gen audit","cpl audit","lead generation","b2b audit","lead quality","cost per lead"],
  "google-ads-bidding": ["bidding strategy","smart bidding","target cpa","target roas","maximize conversions","manual cpc","bid adjustment","tcpa","troas"],
  "google-ads-budget-management": ["budget pacing","underspending","overspending","monthly budget","shared budget","budget allocation","limited by budget","wasting budget","wasted budget"],
  "google-ads-conversion-tracking": ["conversion tracking","google tag","gtm","tag manager","enhanced conversions","conversion action","tracking not firing","missing conversions"],
  "google-ads-experiments": ["experiment","a/b test","ad variation","split test","statistical significance","uplift test"],
  "google-ads-keyword-cannibalization": ["cannibalization","campaigns competing","duplicate keywords","keyword overlap","internal competition","campaign conflict"],
  "google-ads-keywords": ["keyword research","keyword strategy","match types","keyword planner","keyword audit","broad match","phrase match","exact match"],
  "google-ads-negative-keywords": ["negative keywords","wasted spend","irrelevant traffic","negative keyword list","reduce wasted","irrelevant queries","negative keyword recommendations"],
  "google-ads-quality-score": ["quality score","qs","expected ctr","landing page experience","ad rank","low quality score","cpc too high"],
  "google-ads-scripts": ["script","automate","bulk changes","automation","auto pause","script alert","script report"],
  "google-ads-search-term-mining": ["search term report","search term analysis","search term mining","what are people searching","query analysis"],
  "google-ads-segmentation": ["device performance","mobile vs desktop","geo performance","dayparting","ad schedule","hourly performance","location targeting"],
  "google-ads-utm-generator": ["utm","utm parameters","utm generator","tracking url","auto-tagging","gclid","utm naming"],
};

function routeToSkill(question) {
  const q = question.toLowerCase();
  let bestSkill = "google-ads-account-audit";
  let bestScore = 0;
  for (const [skillName, triggers] of Object.entries(SKILLS)) {
    const score = triggers.filter(t => q.includes(t)).length;
    if (score > bestScore) { bestScore = score; bestSkill = skillName; }
  }
  return bestSkill;
}

function loadSkill(skillName) {
  const filePath = path.join(SKILLS_DIR, skillName + ".md");
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

// ── Windsor.ai Data ───────────────────────────────────────────
async function fetchWindsorData(question, accountId) {
  const q = question.toLowerCase();
  let datePreset = "last_30d";
  if (q.includes("today") || q.includes("yesterday") || q.includes("last week") || q.includes("7 day")) datePreset = "last_7d";
  if (q.includes("this month")) datePreset = "this_monthT";
  if (q.includes("90 day") || q.includes("3 month")) datePreset = "last_90d";
  const needsCampaigns = ["audit","campaign","performance","drop","spike","anomaly","budget","bidding","roas","cpa","wasted","diagnose","why","what happened"].some(t => q.includes(t));
  const fields = needsCampaigns ? "date,campaign,spend,roas,clicks,impressions,conversions,ctr,cpc" : "date,spend,roas,clicks,impressions,conversions";
  try {
    const url = "https://connectors.windsor.ai/google_ads?" + new URLSearchParams({
      api_key: WINDSOR_API_KEY,
      account_id: accountId,
      date_preset: datePreset,
      fields: fields,
    });
    const res = await fetch(url);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.error("Windsor data error:", err.message);
    return [];
  }
}

function formatData(data, accountName) {
  if (!data.length) return "No data available for this period.";
  const totals = data.reduce((acc, r) => ({
    spend: acc.spend + (r.spend || 0),
    clicks: acc.clicks + (r.clicks || 0),
    impressions: acc.impressions + (r.impressions || 0),
    conversions: acc.conversions + (r.conversions || 0),
    roasSum: acc.roasSum + (r.roas || 0),
    count: acc.count + 1,
  }), { spend: 0, clicks: 0, impressions: 0, conversions: 0, roasSum: 0, count: 0 });

  const avgROAS = totals.roasSum / totals.count;
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0;
  const cpc = totals.clicks > 0 ? (totals.spend / totals.clicks) : 0;
  const cpa = totals.conversions > 0 ? (totals.spend / totals.conversions) : 0;

  let out = "ACCOUNT: " + accountName + " | PERIOD: " + data[0].date + " to " + data[data.length - 1].date +
    "\n\nTOTALS:" +
    "\n- Spend: $" + totals.spend.toFixed(2) +
    "\n- Avg ROAS: " + avgROAS.toFixed(1) + "x" +
    "\n- Clicks: " + totals.clicks.toLocaleString() +
    "\n- Impressions: " + totals.impressions.toLocaleString() +
    "\n- Conversions: " + totals.conversions.toFixed(2) +
    "\n- CTR: " + ctr.toFixed(2) + "%" +
    "\n- Avg CPC: $" + cpc.toFixed(2) +
    "\n- CPA: $" + cpa.toFixed(2);

  if (data[0] && data[0].campaign) {
    const camps = {};
    data.forEach(r => {
      if (!r.campaign) return;
      if (!camps[r.campaign]) camps[r.campaign] = { spend: 0, roas: 0, clicks: 0, conversions: 0, n: 0 };
      camps[r.campaign].spend += r.spend || 0;
      camps[r.campaign].roas += r.roas || 0;
      camps[r.campaign].clicks += r.clicks || 0;
      camps[r.campaign].conversions += r.conversions || 0;
      camps[r.campaign].n++;
    });
    out += "\n\nTOP CAMPAIGNS BY SPEND:\n";
    Object.entries(camps)
      .sort((a, b) => b[1].spend - a[1].spend)
      .slice(0, 10)
      .forEach(([name, m]) => {
        out += "- " + name + ": $" + m.spend.toFixed(2) + " | " + (m.roas / m.n).toFixed(1) + "x ROAS | " + m.conversions.toFixed(1) + " conv\n";
      });
  }
  return out;
}

// ── Claude API ────────────────────────────────────────────────
async function askMia(question, skillName, data, account) {
  const skill = loadSkill(skillName);
  const dataContext = formatData(data, account.name);
  const system = "You are Mia, a Google Ads AI specialist and Slack bot for Webtopia agency. " +
    "You answer questions about client Google Ads accounts using live data and expert frameworks.\n\n" +
    "EXPERTISE (" + skillName + "):\n" + skill + "\n\n" +
    "LIVE ACCOUNT DATA:\n" + dataContext + "\n\n" +
    "RULES:\n" +
    "- Always reference actual numbers from the live data\n" +
    "- Be specific and actionable\n" +
    "- Flag anything concerning clearly\n" +
    "- Format responses nicely for Slack using *bold* and bullet points\n" +
    "- Max 600 words unless a full audit is requested";

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: system,
    messages: [{ role: "user", content: question }],
  });
  return res.content[0].text;
}

// ── Slack Event Handler ───────────────────────────────────────
slack.event("app_mention", async ({ event, say }) => {
  const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const unique = getUniqueAccounts();

  if (!question) {
    const clientList = unique.map(a => "- " + a.name).join("\n");
    await say({
      text: "Hi! I am *Mia* - your Google Ads AI for Webtopia.\n\nI have access to these accounts:\n" + clientList + "\n\nExamples:\n- @mia audit barimelts\n- @mia why did barimelts CPA spike this week?\n- @mia which campaigns are wasting budget in barimelts?\n- @mia give me negative keyword recommendations for barimelts\n- @mia share last 7 days performance for barimelts",
      thread_ts: event.ts,
    });
    return;
  }

  const account = detectAccount(question);

  if (!account) {
    const clientList = unique.map(a => a.name).join(", ");
    await say({
      text: "Which account are you asking about? I have access to: *" + clientList + "*\n\nExample: @mia audit barimelts",
      thread_ts: event.ts,
    });
    return;
  }

  await say({ text: "Pulling live data for *" + account.name + "* and analysing...", thread_ts: event.ts });

  try {
    const skillName = routeToSkill(question);
    const data = await fetchWindsorData(question, account.id);
    const answer = await askMia(question, skillName, data, account);
    await say({
      text: answer + "\n\n_Skill: " + skillName + " | Account: " + account.name + " | Data: Windsor.ai_",
      thread_ts: event.ts,
    });
  } catch (err) {
    console.error("Mia error:", err);
    await say({
      text: "Something went wrong: " + err.message + "\nPlease try again or contact Sarthak.",
      thread_ts: event.ts,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────
(async () => {
  console.log("Starting Mia...");
  const unique = getUniqueAccounts();
  console.log("Loaded " + unique.length + " account(s):");
  unique.forEach(a => console.log("  - " + a.name + " (ID: " + a.id + ")"));
  await slack.start();
  console.log("Mia is live! Listening for @Mia mentions in Slack...");
})();
