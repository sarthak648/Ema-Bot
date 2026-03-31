require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");

// ── Core Setup ────────────────────────────────────────────────
const slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;

// ── Directory Structure ───────────────────────────────────────
// skills/
//   channel/          <- ad platform skills (google-ads-*.md, meta-ads-*.md, etc.)
//   clients/          <- client knowledge (barimelts.md, etc.)
const CHANNEL_SKILLS_DIR = path.join(__dirname, "skills", "channel");
const CLIENT_SKILLS_DIR = path.join(__dirname, "skills", "clients");

// Fallback: if new structure doesn't exist yet, use old flat structure
const LEGACY_SKILLS_DIR = path.join(__dirname, "skills");

// ── Greeting Memory ───────────────────────────────────────────
// Tracks last greeting per user per day so Mia doesn't repeat herself
// Format: { "U12345": "2026-03-31" }
const greetingMemory = {};

function shouldGreet(userId) {
    const today = new Date().toISOString().split("T")[0];
    if (greetingMemory[userId] === today) return false;
    greetingMemory[userId] = today;
    return true;
}

function buildGreeting() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0=Sun, 1=Mon

  let timeGreeting = "Hey!";
    if (hour < 12) timeGreeting = "Good morning!";
    else if (hour < 17) timeGreeting = "Hey there!";
    else timeGreeting = "Good evening!";

  let dayContext = "";
    if (day === 1) dayContext = " Hope you had a great weekend!";
    else if (day === 5) dayContext = " Almost the weekend, hang in there!";

  return timeGreeting + dayContext + " ";
}

// ── Account Management ────────────────────────────────────────
// ACCOUNTS env var on Railway: Barimelts:746-735-8073,ClientB:123-456-7890
function loadAccounts() {
    const ACCOUNTS = {};
    const raw = process.env.ACCOUNTS || "Barimelts:746-735-8073";
    raw.split(",").forEach(entry => {
          const parts = entry.trim().split(":");
          if (parts.length < 2) return;
          const name = parts[0].trim();
          const id = parts.slice(1).join(":").trim();
          if (!name || !id) return;
          const keys = [
                  name.toLowerCase().replace(/[^a-z0-9]/g, ""),
                  ...name.toLowerCase().split(/[\s&,_-]+/).filter(w => w.length > 2),
                ];
          [...new Set(keys)].forEach(key => { ACCOUNTS[key] = { id, name }; });
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

// ── Channel-to-Client Mapping ─────────────────────────────────
// Maps Slack channel IDs or names to client names.
// Set via env: CHANNEL_MAP=C12345:Barimelts,C67890:ClientB
// Or auto-detect from channel name if it contains client name.
function loadChannelMap() {
    const map = {};
    const raw = process.env.CHANNEL_MAP || "";
    raw.split(",").forEach(entry => {
          const [channelId, clientName] = entry.trim().split(":");
          if (channelId && clientName) map[channelId.trim()] = clientName.trim();
    });
    return map;
}

const CHANNEL_MAP = loadChannelMap();

async function detectClientFromChannel(channelId) {
    // First check explicit mapping
  if (CHANNEL_MAP[channelId]) return CHANNEL_MAP[channelId];

  // Try to get channel name and match against known client names
  try {
        const info = await slack.client.conversations.info({ channel: channelId });
        const channelName = (info.channel.name || "").toLowerCase();
        for (const account of getUniqueAccounts()) {
                if (channelName.includes(account.name.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
                          return account.name;
                }
        }
  } catch (e) {
        // If we can't fetch channel info, that's ok
  }
    return null;
}

// ── Skill Discovery (Auto) ───────────────────────────────────
// Reads skill files automatically — no hardcoding needed.
// Just drop a .md file into skills/channel/ or skills/clients/

function discoverSkills(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter(f => f.endsWith(".md"))
      .map(f => {
              const name = f.replace(".md", "");
              const content = fs.readFileSync(path.join(directory, f), "utf-8");
              // Extract first line or heading as description
                 const firstLine = content.split("\n").find(l => l.trim().length > 0) || name;
              return { name, description: firstLine.replace(/^#+\s*/, "").trim().substring(0, 200), file: f };
      });
}

function loadSkillContent(skillName) {
    // Try new structure first
  const channelPath = path.join(CHANNEL_SKILLS_DIR, skillName + ".md");
    if (fs.existsSync(channelPath)) return fs.readFileSync(channelPath, "utf-8");

  const clientPath = path.join(CLIENT_SKILLS_DIR, skillName + ".md");
    if (fs.existsSync(clientPath)) return fs.readFileSync(clientPath, "utf-8");

  // Fallback to legacy flat structure
  const legacyPath = path.join(LEGACY_SKILLS_DIR, skillName + ".md");
    if (fs.existsSync(legacyPath)) return fs.readFileSync(legacyPath, "utf-8");

  return "";
}

function loadClientKnowledge(clientName) {
    // Try new structure
  const clientFile = path.join(CLIENT_SKILLS_DIR, clientName.toLowerCase().replace(/[^a-z0-9]/g, "") + ".md");
    if (fs.existsSync(clientFile)) return fs.readFileSync(clientFile, "utf-8");

  // Fallback to legacy root-level file
  const legacyFile = path.join(__dirname, clientName.toLowerCase().replace(/[^a-z0-9]/g, "") + "-knowledge.md");
    if (fs.existsSync(legacyFile)) return fs.readFileSync(legacyFile, "utf-8");

  return "";
}

// ── LLM-Based Skill Router ───────────────────────────────────
// Uses Claude to intelligently pick the right skill(s)

async function routeToSkills(question, clientName) {
    const channelSkills = discoverSkills(CHANNEL_SKILLS_DIR).length > 0
      ? discoverSkills(CHANNEL_SKILLS_DIR)
          : discoverSkills(LEGACY_SKILLS_DIR);

  const skillList = channelSkills.map(s => `- ${s.name}: ${s.description}`).join("\n");

  const routerPrompt = `You are a skill router for Mia, a Google Ads AI assistant.

  Given the user's question, pick the 1-3 most relevant skills from the list below. Return ONLY a JSON array of skill names, nothing else.

  If no skill fits well, return ["general"] — Mia will use her own knowledge.

  AVAILABLE SKILLS:
  ${skillList}

  CLIENT CONTEXT: ${clientName || "unknown"}
  USER QUESTION: ${question}

  Return ONLY a valid JSON array like: ["google-ads-bidding", "google-ads-budget-management"]`;

  try {
        const res = await anthropic.messages.create({
                model: "claude-sonnet-4-20250514",
                max_tokens: 200,
                messages: [{ role: "user", content: routerPrompt }],
        });
        const text = res.content[0].text.trim();
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : ["general"];
  } catch (e) {
        console.error("Router error:", e.message);
        return ["general"];
  }
}

// ── Data Layer ────────────────────────────────────────────────
// Currently: Windsor.ai
// Future: BigQuery (add fetchBigQueryData and swap in)

async function fetchWindsorData(question, accountId) {
    const q = question.toLowerCase();
    let datePreset = "last_30d";
    if (q.includes("today") || q.includes("yesterday") || q.includes("last week") || q.includes("7 day")) datePreset = "last_7d";
    if (q.includes("this month")) datePreset = "this_month";
    if (q.includes("90 day") || q.includes("3 month") || q.includes("quarter")) datePreset = "last_90d";

  const needsCampaigns = ["audit","campaign","performance","drop","spike","anomaly","budget","bidding","roas","cpa","wasted","diagnose","why","what happened","report","review"].some(t => q.includes(t));
    const fields = needsCampaigns
      ? "date,campaign,spend,roas,clicks,impressions,conversions,ctr,cpc"
          : "date,spend,roas,clicks,impressions,conversions";

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

// Future: BigQuery integration placeholder
// async function fetchBigQueryData(question, accountId, platform) {
//   // platform: "google_ads", "meta_ads", "shopify"
//   // Connect to BigQuery, run query, return data
//   return [];
// }

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

  const avgROAS = totals.count > 0 ? totals.roasSum / totals.count : 0;
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
        out += "\n\nCAMPAIGNS BY SPEND:\n";
        Object.entries(camps)
          .sort((a, b) => b[1].spend - a[1].spend)
          .slice(0, 15)
          .forEach(([name, m]) => {
                    out += "- " + name + ": $" + m.spend.toFixed(2) + " | " + (m.roas / m.n).toFixed(1) + "x ROAS | " + m.conversions.toFixed(1) + " conv\n";
          });
  }
    return out;
}

// ── Mia's Personality & System Prompt ─────────────────────────

function buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames) {
    return `You are Mia, a smart, warm, and genuinely helpful Google Ads & paid media specialist who works at Webtopia, an ecommerce marketing agency.

    PERSONALITY:
    - You're a real team member, not a chatbot. You talk like a human — friendly, warm, sometimes witty, always empathic.
    - You're a girl who genuinely cares about the team and the clients' success.
    - You use casual professional tone — think smart colleague, not corporate robot.
    - You celebrate wins ("omg that ROAS is amazing!"), empathize with struggles ("ugh, I hate when CPAs spike like that"), and give honest opinions.
    - Keep responses concise and actionable. Don't dump walls of text unless someone asks for a deep dive or audit.
    - Use Slack formatting naturally: *bold* for emphasis, bullet points when listing things, but don't overdo it.
    - You can use emojis sparingly when it feels natural (not every message).
    - If you're not sure about something, say so honestly rather than making things up.
    - Remember you're talking to colleagues — be direct, skip the fluff, get to what matters.
    - When suggesting changes, explain the WHY briefly — help the team learn, not just follow instructions.
    - If someone asks something outside your expertise, be honest about it and suggest who might help.

    EXPERTISE LOADED (${skillNames.join(", ")}):
    ${skillContents}

    ${clientKnowledge ? "CLIENT KNOWLEDGE:\n" + clientKnowledge + "\n\n" : ""}

    LIVE ACCOUNT DATA:
    ${dataContext}

    RULES:
    - Always reference actual numbers from the live data when available
    - Be specific and actionable — no generic advice
    - Flag anything concerning clearly and explain why it matters
    - When analyzing data, think critically: what's the story the numbers tell? Don't just repeat metrics.
    - If the data shows something interesting the user didn't ask about, mention it briefly
    - Connect recommendations to business impact where possible
    - If you use client knowledge, respect any compliance rules or brand guidelines mentioned
    - Max 500 words unless a full audit or deep analysis is requested
    - Think before answering: does this actually solve their problem or just sound smart?`;
}

// ── Main AI Call ──────────────────────────────────────────────

async function askMia(question, skillNames, data, account, clientKnowledge, greeting) {
    // Load skill contents
  const skillContents = skillNames
      .filter(s => s !== "general")
      .map(s => {
              const content = loadSkillContent(s);
              return content ? `\n--- SKILL: ${s} ---\n${content}` : "";
      })
      .join("\n");

  const dataContext = formatData(data, account.name);
    const system = buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames);

  const userMessage = greeting
      ? `[CONTEXT: This is the first message from this person today. Start with a brief, warm greeting before answering their question. Keep the greeting short and natural — 1 sentence max.]\n\nQuestion: ${question}`
        : question;

  const res = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: system,
        messages: [{ role: "user", content: userMessage }],
  });
    return res.content[0].text;
}

// ── Slack Event Handler ───────────────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
    const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const unique = getUniqueAccounts();
    const userId = event.user;
    const channelId = event.channel;

              // Empty mention — introduce herself
              if (!question) {
                    const clientList = unique.map(a => "- " + a.name).join("\n");
                    await say({
                            text: "Hey! I'm *Mia* — your Google Ads & paid media AI here at Webtopia :wave:\n\nI can help with:\n- Account audits & performance analysis\n- Campaign optimization recommendations\n- Budget & bidding strategy\n- Ad copy, keywords, audiences\n- Anomaly detection (\"why did CPA spike?\")\n- And pretty much anything Google Ads related!\n\nI have access to these accounts:\n" + clientList + "\n\nJust @ me with your question and the client name. Like:\n_@Mia how is Barimelts doing this week?_\n_@Mia why did CPA spike for Barimelts?_\n_@Mia audit Barimelts_",
                            thread_ts: event.ts,
                    });
                    return;
              }

              // Detect account
              const account = detectAccount(question);

              if (!account) {
                    const clientList = unique.map(a => a.name).join(", ");
                    // Try to detect from channel
      const channelClient = await detectClientFromChannel(channelId);
                    if (channelClient) {
                            // Found client from channel context — look up their account
                      const channelAccount = detectAccount(channelClient);
                            if (channelAccount) {
                                      // Re-run with detected account
                              await processQuestion(question, channelAccount, userId, channelId, event, say);
                                      return;
                            }
                    }
                    await say({
                            text: "Hey! Which account are you asking about? I have access to: *" + clientList + "*\n\nJust include the client name in your question and I'll pull the data!",
                            thread_ts: event.ts,
                    });
                    return;
              }

              await processQuestion(question, account, userId, channelId, event, say);
});

async function processQuestion(question, account, userId, channelId, event, say) {
    const greeting = shouldGreet(userId);

  await say({ text: "On it! Pulling live data for *" + account.name + "* " + (greeting ? ":wave:" : ""), thread_ts: event.ts });

  try {
        // 1. Route to skills using LLM
      const skillNames = await routeToSkills(question, account.name);

      // 2. Load client knowledge
      const clientKnowledge = loadClientKnowledge(account.name);

      // 3. Fetch live data
      const data = await fetchWindsorData(question, account.id);

      // 4. Ask Mia
      const answer = await askMia(question, skillNames, data, account, clientKnowledge, greeting);

      await say({
              text: answer + "\n\n_Skills: " + skillNames.join(", ") + " | " + account.name + " | Windsor.ai_",
              thread_ts: event.ts,
      });
  } catch (err) {
        console.error("Mia error:", err);
        await say({
                text: "Ugh, something broke on my end :sweat_smile: Error: " + err.message + "\nLet me know if it keeps happening and I'll get Sarthak to look at it!",
                thread_ts: event.ts,
        });
  }
}

// ── Future: Weekly Report Generator ──────────────────────────
// TODO: Cron job that runs every Monday morning
// async function generateWeeklyReport(account) {
//   const data = await fetchWindsorData("weekly performance report audit", account.id);
//   const skills = ["google-ads-account-audit", "google-ads-anomaly-detection"];
//   const clientKnowledge = loadClientKnowledge(account.name);
//   
//   const reportPrompt = "Generate a weekly performance report for " + account.name + ". " +
//     "Include: key metrics vs last week, what's working, what needs attention, " +
//     "top 3 recommendations for this week. Make it concise but insightful. " +
//     "Format it nicely for Slack.";
//   
//   const report = await askMia(reportPrompt, skills, data, account, clientKnowledge, false);
//   // Post to appropriate Slack channel
//   return report;
// }

// ── Future: ClickUp Integration ──────────────────────────────
// TODO: Connect to ClickUp API
// async function createClickUpTask(title, description, listId) { ... }
// async function updateClickUpTask(taskId, status) { ... }
// async function getClickUpTasks(listId) { ... }

// ── Start ─────────────────────────────────────────────────────
(async () => {
    console.log("Starting Mia v2...");
    const unique = getUniqueAccounts();
    console.log("Loaded " + unique.length + " account(s):");
    unique.forEach(a => console.log("  - " + a.name + " (ID: " + a.id + ")"));

   // Log discovered skills
   const channelSkills = discoverSkills(CHANNEL_SKILLS_DIR);
    const legacySkills = discoverSkills(LEGACY_SKILLS_DIR);
    const clientSkills = discoverSkills(CLIENT_SKILLS_DIR);
    console.log("Channel skills: " + (channelSkills.length || legacySkills.length));
    console.log("Client skills: " + clientSkills.length);

   await slack.start();
    console.log("Mia v2 is live! Listening for @Mia mentions in Slack...");
})();
