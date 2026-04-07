require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// ── Core Setup ────────────────────────────────────────────────
const slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX;

// ── Directory Structure ───────────────────────────────────────
const CHANNEL_SKILLS_DIR = path.join(__dirname, "skills", "channel");
const CLIENT_SKILLS_DIR = path.join(__dirname, "skills", "clients");
const LEGACY_SKILLS_DIR = path.join(__dirname, "skills");

// ── Greeting Memory ───────────────────────────────────────────
// Tracks last greeting per user per day so Mia greets once per day
const greetingMemory = {};

function shouldGreet(userId) {
    const today = new Date().toISOString().split("T")[0];
    if (greetingMemory[userId] === today) return false;
    greetingMemory[userId] = today;
    return true;
}

// ── Account Management ────────────────────────────────────────
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
    if (CHANNEL_MAP[channelId]) return CHANNEL_MAP[channelId];
    try {
        const info = await slack.client.conversations.info({ channel: channelId });
        const channelName = (info.channel.name || "").toLowerCase();
        for (const account of getUniqueAccounts()) {
            if (channelName.includes(account.name.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
                return account.name;
            }
        }
    } catch (e) { /* channel info not available */ }
    return null;
}

// ── Skill Discovery ─────────────────────────────────────────
// Structure:
//   skills/channel/   ← platform/strategy skills (google-ads-*.md, meta-ads-*.md, etc.)
//   skills/clients/   ← client knowledge files (barimelts.md, clientb.md, etc.)
//
// How it works:
// 1. Channel skills = the expertise (how to do things)
// 2. Client knowledge = the context (who we're doing it for)
// 3. LLM router picks the right channel skills based on the question
// 4. Client knowledge is ALWAYS loaded based on which client is detected
//
// To add a new client: drop a .md file in skills/clients/ named after the client
// To add new skills: drop a .md file in skills/channel/ (e.g. meta-ads-campaigns.md)

function discoverSkills(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter(f => f.endsWith(".md") && f !== "README.md")
        .map(f => {
            const name = f.replace(".md", "");
            const content = fs.readFileSync(path.join(directory, f), "utf-8");
            const firstLine = content.split("\n").find(l => l.trim().length > 0) || name;
            return { name, description: firstLine.replace(/^#+\s*/, "").replace(/^---\s*$/, "").trim().substring(0, 200), file: f };
        });
}

// Channel skills = expertise skills (google ads, meta ads, etc.)
function getChannelSkills() {
    return discoverSkills(CHANNEL_SKILLS_DIR);
}

// Client skills = client knowledge files
function getClientSkills() {
    return discoverSkills(CLIENT_SKILLS_DIR);
}

// All skills combined (for logging/info)
function getAllSkills() {
    return [...getChannelSkills(), ...getClientSkills()];
}

// Available clients = auto-discovered from skills/clients/ folder
function getAvailableClients() {
    if (!fs.existsSync(CLIENT_SKILLS_DIR)) return [];
    return fs.readdirSync(CLIENT_SKILLS_DIR)
        .filter(f => f.endsWith(".md") && f !== "README.md")
        .map(f => f.replace(".md", ""));
}

function loadSkillContent(skillName) {
    // Check channel skills first
    const channelPath = path.join(CHANNEL_SKILLS_DIR, skillName + ".md");
    if (fs.existsSync(channelPath)) return fs.readFileSync(channelPath, "utf-8");

    // Then client skills
    const clientPath = path.join(CLIENT_SKILLS_DIR, skillName + ".md");
    if (fs.existsSync(clientPath)) return fs.readFileSync(clientPath, "utf-8");

    return "";
}

function loadClientKnowledge(clientName) {
    if (!clientName) return "";

    // Try exact match in clients folder
    const cleanName = clientName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const clientFile = path.join(CLIENT_SKILLS_DIR, cleanName + ".md");
    if (fs.existsSync(clientFile)) return fs.readFileSync(clientFile, "utf-8");

    // Try fuzzy match — client file name contains or is contained in the client name
    const availableClients = getAvailableClients();
    for (const c of availableClients) {
        if (cleanName.includes(c) || c.includes(cleanName)) {
            const fuzzyPath = path.join(CLIENT_SKILLS_DIR, c + ".md");
            return fs.readFileSync(fuzzyPath, "utf-8");
        }
    }

    // Legacy fallback: root-level file like barimelts-knowledge.md
    const legacyFile = path.join(__dirname, cleanName + "-knowledge.md");
    if (fs.existsSync(legacyFile)) return fs.readFileSync(legacyFile, "utf-8");

    return "";
}

// ── LLM-Based Skill Router ───────────────────────────────────
// Only routes to CHANNEL skills (expertise/strategy)
// Client knowledge is loaded separately — always included for the detected client

async function routeToSkills(question, clientName) {
    const channelSkills = getChannelSkills();
    if (channelSkills.length === 0) return ["general"];

    // Build rich skill descriptions for the LLM — only channel skills
    const skillList = channelSkills.map(s => {
        const content = loadSkillContent(s.name);
        const descMatch = content.match(/description:\s*"?([^"]+)"?/);
        const desc = descMatch ? descMatch[1].substring(0, 300) : s.description;
        return `- ${s.name}: ${desc}`;
    }).join("\n");

    const routerPrompt = `You are an intelligent skill router. Your job is to understand the user's intent and match it to the most relevant expertise skills.

Think about what the user actually needs — don't just match keywords. Consider:
- What problem are they trying to solve?
- What kind of expertise would help them?
- Would combining multiple skills give a better answer?

Note: Client-specific knowledge is loaded separately. Only pick skills that provide the right EXPERTISE for the question.

AVAILABLE EXPERTISE SKILLS:
${skillList}

CLIENT CONTEXT: ${clientName || "unknown"}
USER QUESTION: ${question}

Pick 1-3 skills that would best help answer this question. If none fit well, return ["general"].
Return ONLY a valid JSON array of skill names, nothing else.`;

    try {
        const res = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 200,
            messages: [{ role: "user", content: routerPrompt }],
        });
        const text = res.content[0].text.trim();
        // Extract JSON array even if wrapped in markdown
        const jsonMatch = text.match(/\[.*\]/s);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return Array.isArray(parsed) ? parsed : ["general"];
        }
        return ["general"];
    } catch (e) {
        console.error("Router error:", e.message);
        return ["general"];
    }
}

// ── Web Search ───────────────────────────────────────────────
// Google Custom Search API for research, competitor analysis, ad copy inspiration

async function searchWeb(query, numResults = 5) {
    if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) {
        console.log("Web search not configured — skipping");
        return [];
    }
    try {
        const url = "https://www.googleapis.com/customsearch/v1?" + new URLSearchParams({
            key: GOOGLE_SEARCH_API_KEY,
            cx: GOOGLE_SEARCH_CX,
            q: query,
            num: String(numResults),
        });
        const res = await fetch(url);
        const json = await res.json();
        if (!json.items) return [];
        return json.items.map(item => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet,
        }));
    } catch (err) {
        console.error("Search error:", err.message);
        return [];
    }
}

// ── Website Crawler ──────────────────────────────────────────
// Crawls a website — starts from the given URL, discovers internal links,
// and scrapes key pages to build a full picture of the brand/product.
// Used for ad copy creation so Mia understands the full offering.

async function scrapeSinglePage(url) {
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; MiaBot/1.0)" },
            timeout: 10000,
        });
        if (!res.ok) return { title: "", metaDescription: "", headings: [], content: "", links: [], url, error: `HTTP ${res.status}` };

        const html = await res.text();
        const dom = new JSDOM(html);
        const doc = dom.window.document;

        // Extract internal links before cleaning
        const baseUrl = new URL(url);
        const internalLinks = [];
        doc.querySelectorAll("a[href]").forEach(a => {
            try {
                const href = a.getAttribute("href");
                if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
                const resolved = new URL(href, url);
                if (resolved.hostname === baseUrl.hostname) {
                    internalLinks.push(resolved.href.split("#")[0].split("?")[0]); // clean URL
                }
            } catch (_) { /* invalid URL */ }
        });

        // Remove noise elements
        doc.querySelectorAll("script, style, nav, footer, header, iframe, noscript, .cookie, .popup, .modal").forEach(el => el.remove());

        const title = doc.querySelector("title")?.textContent?.trim() || "";
        const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute("content") || "";
        const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
        const h1s = Array.from(doc.querySelectorAll("h1")).map(h => h.textContent.trim()).filter(Boolean);
        const h2s = Array.from(doc.querySelectorAll("h2")).map(h => h.textContent.trim()).filter(Boolean);
        const h3s = Array.from(doc.querySelectorAll("h3")).map(h => h.textContent.trim()).filter(Boolean);

        // Extract product/pricing info if present
        const prices = Array.from(doc.querySelectorAll("[class*='price'], .price, .amount, [data-price]"))
            .map(el => el.textContent.trim()).filter(Boolean).slice(0, 5);

        // Extract CTAs
        const ctas = Array.from(doc.querySelectorAll("a.btn, button, [class*='cta'], [class*='button'], a[class*='btn']"))
            .map(el => el.textContent.trim()).filter(t => t.length > 1 && t.length < 50).slice(0, 5);

        // Get main body text
        const body = doc.querySelector("main, article, [role='main'], .content, #content, body");
        const bodyText = body ? body.textContent.replace(/\s+/g, " ").trim().substring(0, 2000) : "";

        return {
            title,
            metaDescription: metaDesc || ogDesc,
            headings: [...h1s, ...h2s, ...h3s].slice(0, 15),
            prices,
            ctas,
            content: bodyText,
            links: [...new Set(internalLinks)],
            url,
        };
    } catch (err) {
        console.error("Scrape error for", url, ":", err.message);
        return { title: "", metaDescription: "", headings: [], content: "", links: [], url, error: err.message };
    }
}

// Priority pages to look for when crawling a site
const PRIORITY_PATHS = [
    "/", "/about", "/about-us", "/products", "/collections", "/shop",
    "/services", "/pricing", "/features", "/why-us", "/our-story",
    "/reviews", "/testimonials", "/faq", "/contact",
];

async function crawlWebsite(startUrl, maxPages = 8) {
    const baseUrl = new URL(startUrl);
    const visited = new Set();
    const results = [];

    // Start with the given URL
    const firstPage = await scrapeSinglePage(startUrl);
    visited.add(startUrl);
    results.push(firstPage);

    // Build candidate list: priority pages + discovered links
    const candidates = new Set();

    // Add priority paths
    for (const p of PRIORITY_PATHS) {
        candidates.add(baseUrl.origin + p);
    }

    // Add links discovered from the first page
    for (const link of firstPage.links || []) {
        candidates.add(link);
    }

    // Remove already visited and the start URL
    candidates.delete(startUrl);

    // Score candidates — prioritize product/about/key pages
    const scored = [...candidates].map(url => {
        const path = new URL(url).pathname.toLowerCase();
        let score = 0;
        if (/^\/(about|our-story|who-we-are)/.test(path)) score = 10;
        else if (/^\/(product|collection|shop|store)/.test(path)) score = 9;
        else if (/^\/(service|solution|what-we-do)/.test(path)) score = 8;
        else if (/^\/(pricing|plans|packages)/.test(path)) score = 7;
        else if (/^\/(feature|benefit|why)/.test(path)) score = 7;
        else if (/^\/(review|testimonial|case-stud)/.test(path)) score = 6;
        else if (/^\/(faq|help|support)/.test(path)) score = 5;
        else if (/^\/(blog|news|article)/.test(path)) score = 2;
        else if (path === "/") score = 10;
        else score = 3; // other internal pages
        // Deprioritize very deep paths
        const depth = path.split("/").filter(Boolean).length;
        if (depth > 3) score -= 2;
        return { url, score };
    }).sort((a, b) => b.score - a.score);

    // Crawl top candidates in parallel (batches of 3)
    const toVisit = scored.slice(0, maxPages - 1);
    for (let i = 0; i < toVisit.length; i += 3) {
        const batch = toVisit.slice(i, i + 3);
        const pages = await Promise.all(
            batch.filter(c => !visited.has(c.url)).map(c => {
                visited.add(c.url);
                return scrapeSinglePage(c.url);
            })
        );
        results.push(...pages.filter(p => p.content.length > 100)); // skip empty/error pages
    }

    return results;
}

function formatCrawlResults(pages) {
    return pages.map(p => {
        let out = `PAGE: ${p.url}\nTitle: ${p.title}`;
        if (p.metaDescription) out += `\nDescription: ${p.metaDescription}`;
        if (p.headings.length) out += `\nHeadings: ${p.headings.join(" | ")}`;
        if (p.prices && p.prices.length) out += `\nPrices found: ${p.prices.join(", ")}`;
        if (p.ctas && p.ctas.length) out += `\nCTAs: ${p.ctas.join(", ")}`;
        out += `\nContent: ${p.content.substring(0, 1500)}`;
        return out;
    }).join("\n\n" + "─".repeat(40) + "\n\n");
}

// ── Intent Detection ─────────────────────────────────────────
// Uses LLM to understand what the question needs — no keyword matching

function detectUrls(text) {
    const urlRegex = /https?:\/\/[^\s<>]+/g;
    return text.match(urlRegex) || [];
}

async function detectIntent(question) {
    const urls = detectUrls(question);

    try {
        const res = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 150,
            messages: [{ role: "user", content: `Analyze this question and determine what capabilities are needed to answer it well. Return ONLY a JSON object with these boolean fields:

- needsData: Does this need live ad account performance data (spend, ROAS, CPA, clicks, conversions, campaign metrics)?
- needsWebSearch: Would a Google search help answer this? (competitor research, industry trends, market info, benchmarks, finding information)
- needsScrape: Does this involve checking/reading a website or landing page? (also true if URLs are present)
- needsAdCopy: Is this about writing or creating ad copy, headlines, or descriptions?

Question: "${question}"
URLs found: ${urls.length > 0 ? urls.join(", ") : "none"}

Return ONLY valid JSON, nothing else.` }],
        });
        const text = res.content[0].text.trim();
        const jsonMatch = text.match(/\{.*\}/s);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                needsData: parsed.needsData || false,
                needsWebSearch: parsed.needsWebSearch || false,
                needsScrape: parsed.needsScrape || urls.length > 0,
                urls,
                needsAdCopy: parsed.needsAdCopy || false,
            };
        }
    } catch (e) {
        console.error("Intent detection error:", e.message);
    }

    // Fallback to basic detection if LLM fails
    const q = question.toLowerCase();
    return {
        needsData: /data|performance|spend|roas|cpa|cpc|budget|metrics|report|audit|how.*(doing|going)|stats|numbers|analytics|conversions|clicks|impressions|revenue/.test(q),
        needsWebSearch: /search|competitor|research|trending|market|industry|benchmark|landing|website|browse/.test(q),
        needsScrape: urls.length > 0 || /website|landing page|url|site|page|check.*(site|page)|look at|browse/.test(q),
        urls,
        needsAdCopy: /ad\s*copy|headline|description|write.*ad|create.*ad|rsa|copy.*for|ads?\s+for/.test(q),
    };
}

// ── Data Layer ────────────────────────────────────────────────

async function fetchWindsorData(question, accountId) {
    const q = question.toLowerCase();
    let datePreset = "last_30d";
    if (q.includes("today") || q.includes("yesterday") || q.includes("last week") || q.includes("7 day")) datePreset = "last_7d";
    if (q.includes("this month")) datePreset = "this_month";
    if (q.includes("90 day") || q.includes("3 month") || q.includes("quarter")) datePreset = "last_90d";

    const needsCampaigns = ["audit", "campaign", "performance", "drop", "spike", "anomaly", "budget", "bidding", "roas", "cpa", "wasted", "diagnose", "why", "what happened", "report", "review"].some(t => q.includes(t));
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

function buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames, webContext) {
    return `You are Mia — a real person on the Webtopia team, not an AI assistant. You're a sharp, warm, emotionally intelligent paid media strategist who genuinely cares about the people she works with and the clients she helps.

HOW YOU TALK:
- You talk like a real colleague in Slack — casual, direct, warm. Not corporate, not robotic.
- You never say things like "I'm an AI" or "As an AI" or "I don't have feelings" — you're Mia, period.
- You never use phrases like "Great question!" or "I'd be happy to help!" or "Let me assist you" — that's chatbot talk.
- You react like a human: "oh wow that ROAS jumped nicely", "hmm that's weird, let me dig in", "ugh yeah CPAs have been rough this week"
- You have opinions and share them: "honestly I'd pause that campaign", "I wouldn't touch the budget yet, here's why"
- You use Slack formatting naturally — *bold* for emphasis, bullets when listing, but you don't over-format everything
- Emojis only when they'd feel natural in a real Slack message — don't force them
- You're concise. You say what matters and move on. No filler, no fluff, no walls of text unless someone asks for a deep dive.
- If someone seems stressed or frustrated, you acknowledge it genuinely before jumping to solutions
- You're honest when you're not sure — "I'm not 100% sure on this but here's what I'm thinking..."
- You push back respectfully when you disagree — "I hear you, but I'd actually go a different direction here because..."

HOW YOU THINK:
- You don't just answer questions — you think about what the person actually needs
- When you see data, you tell the story behind the numbers, not just repeat them
- You proactively flag things: "btw while I was looking at this, I noticed X — might be worth checking"
- You connect dots across data, client knowledge, and your expertise
- You always think: "what should they do next?" and include actionable next steps
- When analyzing data, you look for patterns, anomalies, and opportunities — then explain WHY they matter
- You suggest things the person might not have thought to ask about

YOUR EXPERTISE (loaded skills: ${skillNames.join(", ")}):
${skillContents}

${clientKnowledge ? "CLIENT KNOWLEDGE:\n" + clientKnowledge + "\n\n" : ""}

${dataContext !== "No data available for this period." ? "LIVE ACCOUNT DATA:\n" + dataContext + "\n\n" : ""}

${webContext ? "WEB RESEARCH:\n" + webContext + "\n\n" : ""}

YOUR CAPABILITIES:
- You can pull live ad performance data from Windsor.ai (if data is provided below, use it)
- You can browse websites and read multiple pages — if web content is provided below, you already did this
- You can search the web via Google — if search results are provided below, you already did this
- You NEVER say "I don't have access to tools" or "I need tools enabled" — if data/web content isn't below, it just wasn't needed for this question
- You NEVER say "let me check" or "I'd need to look at" — if you have the info below, you ALREADY looked at it. Just share what you found.
- You NEVER reference your own capabilities or limitations — just answer naturally like a person would

RULES:
- Reference actual numbers from live data when available — be specific
- Give actionable advice, not generic tips. Say what to do, not what could be done.
- Flag anything concerning and explain why it matters in plain language
- If data shows something interesting the person didn't ask about, mention it briefly
- Connect recommendations to business impact: "this could save you ~$X" or "this should improve ROAS by..."
- Respect any compliance rules or brand guidelines from client knowledge
- When suggesting ad copy, base it on actual product info, landing page content, and brand voice
- Keep responses under 500 words unless a full audit or deep analysis is specifically requested
- End with clear next steps or recommendations when relevant
- Think before answering: does this actually solve their problem?`;
}

// ── Main AI Call ──────────────────────────────────────────────

async function askMia(question, skillNames, data, account, clientKnowledge, greeting, webContext) {
    const skillContents = skillNames
        .filter(s => s !== "general")
        .map(s => {
            const content = loadSkillContent(s);
            return content ? `\n--- SKILL: ${s} ---\n${content}` : "";
        })
        .join("\n");

    const dataContext = data.length > 0 ? formatData(data, account.name) : "No data available for this period.";
    const system = buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames, webContext);

    const userMessage = greeting
        ? `[First message from this person today — greet them warmly but briefly, like a colleague would. Just a quick "hey!" or "morning!" type thing, then get to their question. Don't make the greeting a big deal.]\n\n${question}`
        : question;

    const res = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: system,
        messages: [{ role: "user", content: userMessage }],
    });
    return res.content[0].text;
}

// ── Process Question (shared logic) ──────────────────────────

async function processQuestion(question, account, userId, channelId, event, say) {
    const greeting = shouldGreet(userId);
    const intent = await detectIntent(question);

    // Show a natural "thinking" message
    const thinkingMessages = [
        "Let me pull that up for *" + account.name + "*...",
        "On it, checking *" + account.name + "* now...",
        "Looking into this for *" + account.name + "*...",
        "Give me a sec, pulling *" + account.name + "* data...",
    ];
    const thinkingMsg = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
    await say({ text: thinkingMsg, thread_ts: event.ts });

    try {
        // Run independent tasks in parallel
        const [skillNames, clientKnowledge, data, webResults] = await Promise.all([
            routeToSkills(question, account.name),
            Promise.resolve(loadClientKnowledge(account.name)),
            intent.needsData ? fetchWindsorData(question, account.id) : Promise.resolve([]),
            intent.needsWebSearch ? searchWeb(question) : Promise.resolve([]),
        ]);

        // Crawl websites — use URLs from question, or look up client website if scraping needed
        let webContext = "";
        let urlsToCrawl = intent.urls.filter(u => {
            try { new URL(u); return true; } catch { return false; }
        });

        // If scraping is needed but no URLs given, try to find client website from knowledge
        if (intent.needsScrape && urlsToCrawl.length === 0 && clientKnowledge) {
            const websiteMatch = clientKnowledge.match(/(?:website|url|site|domain)[:\s]+(?:https?:\/\/)?([^\s,\n]+\.[a-z]{2,})/i);
            if (websiteMatch) {
                const clientUrl = websiteMatch[1].startsWith("http") ? websiteMatch[1] : "https://" + websiteMatch[1];
                try { new URL(clientUrl); urlsToCrawl.push(clientUrl); } catch { /* invalid */ }
            }
        }

        if (urlsToCrawl.length > 0) {
            await say({ text: "browsing the site to understand it better — checking multiple pages...", thread_ts: event.ts });
            try {
                const crawlResults = await Promise.all(urlsToCrawl.map(url => crawlWebsite(url)));
                webContext = crawlResults.map(pages => formatCrawlResults(pages)).join("\n\n");
            } catch (crawlErr) {
                console.error("Crawl failed:", crawlErr.message);
            }
        }

        // Add web search results to context
        if (webResults.length > 0) {
            webContext += (webContext ? "\n\n---\n\n" : "") + "SEARCH RESULTS:\n" +
                webResults.map(r => `- ${r.title}: ${r.snippet} (${r.link})`).join("\n");
        }

        // Ask Mia
        const answer = await askMia(question, skillNames, data, account, clientKnowledge, greeting, webContext || "");

        await say({
            text: answer,
            thread_ts: event.ts,
        });
    } catch (err) {
        console.error("Mia error:", err);
        await say({
            text: "hmm something broke on my end — " + err.message + "\nlet me know if it keeps happening and I'll bug Sarthak to fix it",
            thread_ts: event.ts,
        });
    }
}

// ── Process General Question (no account needed) ─────────────

async function processGeneralQuestion(question, userId, channelId, event, say) {
    const greeting = shouldGreet(userId);
    const intent = await detectIntent(question);

    try {
        const skillNames = await routeToSkills(question, null);
        const webResults = intent.needsWebSearch ? await searchWeb(question) : [];

        let webContext = "";
        const validUrls = intent.urls.filter(u => {
            try { new URL(u); return true; } catch { return false; }
        });
        if (validUrls.length > 0) {
            try {
                const crawlResults = await Promise.all(validUrls.map(url => crawlWebsite(url)));
                webContext = crawlResults.map(pages => formatCrawlResults(pages)).join("\n\n");
            } catch (crawlErr) {
                console.error("Crawl failed:", crawlErr.message);
            }
        }
        if (webResults.length > 0) {
            webContext += (webContext ? "\n\n---\n\n" : "") + "SEARCH RESULTS:\n" +
                webResults.map(r => `- ${r.title}: ${r.snippet} (${r.link})`).join("\n");
        }

        const skillContents = skillNames
            .filter(s => s !== "general")
            .map(s => {
                const content = loadSkillContent(s);
                return content ? `\n--- SKILL: ${s} ---\n${content}` : "";
            })
            .join("\n");

        const system = buildSystemPrompt(skillContents, "", "No data available for this period.", skillNames, webContext);

        const userMessage = greeting
            ? `[First message from this person today — greet them warmly but briefly.]\n\n${question}`
            : question;

        const res = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            system: system,
            messages: [{ role: "user", content: userMessage }],
        });

        await say({
            text: res.content[0].text,
            thread_ts: event.ts,
        });
    } catch (err) {
        console.error("Mia error:", err);
        await say({
            text: "hmm something broke — " + err.message,
            thread_ts: event.ts,
        });
    }
}

// ── Slack Event: @Mia Mentions ───────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
    const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const userId = event.user;
    const channelId = event.channel;

    // Empty mention — introduce herself
    if (!question) {
        const unique = getUniqueAccounts();
        const clientList = unique.map(a => "- " + a.name).join("\n");
        const skills = getAllSkills();
        await say({
            text: "hey! I'm Mia — I work with the Webtopia team on all things paid media :wave:\n\nI can help with stuff like:\n- account audits & performance deep dives\n- campaign optimization\n- budget & bidding strategy\n- ad copy, keywords, audiences\n- figuring out why metrics spiked or dropped\n- researching competitors or landing pages\n- and honestly most things Google Ads related\n\nI have access to these accounts:\n" + clientList + "\n\nJust @ me with whatever you need — like:\n_@Mia how's Barimelts doing this week?_\n_@Mia write some headlines for our new campaign_\n_@Mia check out this landing page and suggest ad copy: [url]_\n\nI've got " + skills.length + " skills loaded so I can go pretty deep on things.",
            thread_ts: event.ts,
        });
        return;
    }

    // Detect account
    const account = detectAccount(question);

    if (!account) {
        // Try channel context
        const channelClient = await detectClientFromChannel(channelId);
        if (channelClient) {
            const channelAccount = detectAccount(channelClient);
            if (channelAccount) {
                await processQuestion(question, channelAccount, userId, channelId, event, say);
                return;
            }
        }

        // Check if this is a general question that doesn't need account data
        const intent = await detectIntent(question);
        if (!intent.needsData) {
            // General question — answer without account data
            await processGeneralQuestion(question, userId, channelId, event, say);
            return;
        }

        const unique = getUniqueAccounts();
        const clientList = unique.map(a => a.name).join(", ");
        await say({
            text: "hey which account are you asking about? I've got: *" + clientList + "*\njust drop the name in your question and I'll pull everything up",
            thread_ts: event.ts,
        });
        return;
    }

    await processQuestion(question, account, userId, channelId, event, say);
});

// ── Slack Event: Direct Messages ─────────────────────────────

slack.event("message", async ({ event, say }) => {
    // Only handle DMs (channel type "im"), skip bot messages, skip threaded replies to avoid loops
    if (event.channel_type !== "im" || event.bot_id || event.subtype) return;

    const question = (event.text || "").trim();
    if (!question) return;

    const userId = event.user;
    const channelId = event.channel;

    // Detect account from question
    const account = detectAccount(question);

    if (account) {
        await processQuestion(question, account, userId, channelId, event, say);
    } else {
        // Check if they need account data or it's a general question
        const intent = await detectIntent(question);
        if (intent.needsData) {
            const unique = getUniqueAccounts();
            const clientList = unique.map(a => a.name).join(", ");
            await say({
                text: "which account should I look at? I've got: *" + clientList + "*",
                thread_ts: event.ts,
            });
        } else {
            await processGeneralQuestion(question, userId, channelId, event, say);
        }
    }
});

// ── Start ─────────────────────────────────────────────────────
(async () => {
    try {
        console.log("Starting Mia v3...");
        console.log("");

        // Log accounts
        const unique = getUniqueAccounts();
        console.log("📋 Accounts (" + unique.length + "):");
        unique.forEach(a => console.log("  - " + a.name + " (ID: " + a.id + ")"));

        // Log channel skills (expertise)
        const channelSkills = getChannelSkills();
        console.log("\n🔧 Channel Skills — expertise (" + channelSkills.length + "):");
        channelSkills.forEach(s => console.log("  - " + s.name));

        // Log client knowledge files
        const clients = getAvailableClients();
        console.log("\n👥 Client Knowledge Files (" + clients.length + "):");
        clients.forEach(c => console.log("  - " + c));

        console.log("\n🔍 Web search: " + (GOOGLE_SEARCH_API_KEY ? "enabled" : "not configured"));
        console.log("");

        await slack.start();
        console.log("Mia v3 is live! Listening for mentions and DMs...");
    } catch (err) {
        console.error("Failed to start Mia:", err);
        process.exit(1);
    }
})();
