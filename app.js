require("dotenv").config({ override: false });
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const XLSX = require("xlsx");
const { GoogleAdsApi, enums } = require("google-ads-api");

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

// ── Google Ads API ────────────────────────────────────────────
// MCC setup — one set of credentials covers all client accounts.
// Set GOOGLE_ADS_LOGIN_CUSTOMER_ID to your MCC account ID.

// Strip surrounding quotes Railway sometimes wraps around env var values
function env(key) {
    const val = process.env[key] || "";
    return val.replace(/^["']|["']$/g, "").trim();
}

// Debug: log all env var keys so we can see what Railway is actually injecting
console.log("ENV KEYS:", Object.keys(process.env).filter(k => k.startsWith("GOOGLE") || k.startsWith("SLACK") || k.startsWith("ANTHROPIC")).join(", "));
console.log("ENV CHECK — GOOGLE_ADS_DEVELOPER_TOKEN:", JSON.stringify(process.env.GOOGLE_ADS_DEVELOPER_TOKEN));
console.log("ENV CHECK — GOOGLE_ADS_CLIENT_ID:", JSON.stringify(process.env.GOOGLE_ADS_CLIENT_ID));

let gadsClient = null;
if (env("GOOGLE_ADS_DEVELOPER_TOKEN") && env("GOOGLE_ADS_CLIENT_ID")) {
    try {
        gadsClient = new GoogleAdsApi({
            client_id: env("GOOGLE_ADS_CLIENT_ID"),
            client_secret: env("GOOGLE_ADS_CLIENT_SECRET"),
            developer_token: env("GOOGLE_ADS_DEVELOPER_TOKEN"),
        });
        console.log("✅ Google Ads API client initialised");
        console.log("   MCC login ID:", env("GOOGLE_ADS_LOGIN_CUSTOMER_ID") || "NOT SET");
        console.log("   Refresh token set:", !!env("GOOGLE_ADS_REFRESH_TOKEN"));
    } catch (e) {
        console.error("❌ Google Ads API init error:", e.message);
    }
} else {
    console.warn("⚠️  Google Ads API not initialised — missing GOOGLE_ADS_DEVELOPER_TOKEN or GOOGLE_ADS_CLIENT_ID");
}

function getGadsCustomer(customerId) {
    if (!gadsClient) return null;
    const config = {
        customer_id: String(customerId).replace(/-/g, ""),
        refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN"),
    };
    const loginId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (loginId) {
        config.login_customer_id = loginId.replace(/-/g, "");
    }
    return gadsClient.Customer(config);
}

async function listCampaigns(customerId) {
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) return [];
        const queryPromise = customer.query(`
            SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name
            FROM campaign
            WHERE campaign.status = 'ENABLED'
            ORDER BY campaign.name
        `);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Google Ads API timeout after 30s")), 30000)
        );
        const rows = await Promise.race([queryPromise, timeoutPromise]);
        return rows.map(r => ({
            id: String(r.campaign.id),
            name: r.campaign.name,
            status: r.campaign.status,
            resourceName: r.campaign.resource_name,
        }));
    } catch (err) {
        console.error("listCampaigns error:", err.message);
        return [];
    }
}

// Pulls the website URL directly from the account's active ads final_urls.
// This is the most reliable source — no manual config needed.
async function fetchAccountWebsite(customerId) {
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) return null;
        const rows = await customer.query(`
            SELECT ad_group_ad.ad.final_urls
            FROM ad_group_ad
            WHERE ad_group_ad.status = 'ENABLED'
              AND campaign.status = 'ENABLED'
            LIMIT 10
        `);
        for (const r of rows) {
            const urls = r.ad_group_ad?.ad?.final_urls || [];
            for (const u of urls) {
                try {
                    const parsed = new URL(u);
                    const base = parsed.origin;
                    console.log(`fetchAccountWebsite: found ${base} for customer ${customerId}`);
                    return base;
                } catch { /* invalid URL */ }
            }
        }
    } catch (err) {
        console.error("fetchAccountWebsite error:", err.message);
    }
    return null;
}

async function addCampaignNegativeKeywords(customerId, campaignResourceName, keywords) {
    // keywords: [{ text: string, match: "PHRASE" | "EXACT" | "BROAD" }]
    const customer = getGadsCustomer(customerId);
    if (!customer) throw new Error("Google Ads API not configured");

    const matchTypeMap = {
        PHRASE: enums.KeywordMatchType.PHRASE,
        EXACT: enums.KeywordMatchType.EXACT,
        BROAD: enums.KeywordMatchType.BROAD,
    };

    const operations = keywords.map(kw => ({
        entity: "campaign_criterion",
        operation: "create",
        resource: {
            campaign: campaignResourceName,
            negative: true,
            keyword: {
                text: kw.text,
                match_type: matchTypeMap[(kw.match || "").toUpperCase()] || enums.KeywordMatchType.PHRASE,
            },
        },
    }));

    return await customer.mutateResources(operations);
}

async function listAdGroups(customerId) {
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) return [];
        const queryPromise = customer.query(`
            SELECT ad_group.id, ad_group.name, ad_group.resource_name, ad_group.status,
                   campaign.name, campaign.resource_name
            FROM ad_group
            WHERE ad_group.status != 'REMOVED' AND campaign.status = 'ENABLED'
            ORDER BY campaign.name, ad_group.name
        `);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Google Ads API timeout after 30s")), 30000)
        );
        const rows = await Promise.race([queryPromise, timeoutPromise]);
        return rows.map(r => ({
            id: String(r.ad_group.id),
            name: r.ad_group.name,
            resourceName: r.ad_group.resource_name,
            campaignName: r.campaign.name,
            campaignResourceName: r.campaign.resource_name,
        }));
    } catch (err) {
        console.error("listAdGroups error:", err.message);
        return [];
    }
}

async function addAdGroupKeywords(customerId, adGroupResourceName, keywords) {
    // keywords: [{ text: string, match: "EXACT" | "PHRASE" | "BROAD" }]
    const customer = getGadsCustomer(customerId);
    if (!customer) throw new Error("Google Ads API not configured");

    const matchTypeMap = {
        PHRASE: enums.KeywordMatchType.PHRASE,
        EXACT: enums.KeywordMatchType.EXACT,
        BROAD: enums.KeywordMatchType.BROAD,
    };

    const operations = keywords.map(kw => ({
        entity: "ad_group_criterion",
        operation: "create",
        resource: {
            ad_group: adGroupResourceName,
            keyword: {
                text: kw.text,
                match_type: matchTypeMap[(kw.match || "").toUpperCase()] || enums.KeywordMatchType.EXACT,
            },
        },
    }));

    return await customer.mutateResources(operations);
}

// Convert a date range identifier to a valid GAQL date clause.
// The Google Ads API DURING operator only accepts specific literals —
// LAST_60_DAYS is NOT one of them, so unsupported ranges use explicit BETWEEN dates.
const VALID_DURING_LITERALS = new Set([
    "TODAY", "YESTERDAY", "THIS_WEEK_SUN_TODAY", "THIS_WEEK_MON_TODAY",
    "LAST_7_DAYS", "LAST_BUSINESS_WEEK", "LAST_WEEK_SUN_SAT", "LAST_WEEK_MON_SUN",
    "THIS_MONTH", "LAST_MONTH", "LAST_14_DAYS", "LAST_30_DAYS",
    "LAST_90_DAYS", "LAST_180_DAYS", "LAST_365_DAYS",
]);

function toGadsDateClause(dateRange) {
    if (VALID_DURING_LITERALS.has(dateRange)) return `DURING ${dateRange}`;
    // For custom ranges like LAST_60_DAYS, compute explicit dates
    const daysMatch = dateRange.match(/LAST_(\d+)_DAYS/);
    const days = daysMatch ? parseInt(daysMatch[1]) : 30;
    const fmt = d => d.toISOString().split("T")[0];
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    return `BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
}

// Parse search term filters from the user's question.
// Supports: date range, min spend, min clicks. All have sensible defaults.
function detectSearchTermFilters(question) {
    const q = question.toLowerCase();

    // Date range — any number of days/weeks/months/years supported.
    // Common DURING literals are used where possible; everything else uses LAST_N_DAYS
    // which toGadsDateClause() converts to an explicit BETWEEN clause.
    let dateRange = "LAST_30_DAYS";

    // Explicit N-day mentions: "last 45 days", "past 120 days"
    const explicitDays = q.match(/last\s*(\d+)\s*days?|past\s*(\d+)\s*days?/);
    const explicitWeeks = q.match(/last\s*(\d+)\s*weeks?|past\s*(\d+)\s*weeks?/);
    const explicitMonths = q.match(/last\s*(\d+)\s*months?|past\s*(\d+)\s*months?/);
    const explicitYears = q.match(/last\s*(\d+)\s*years?|past\s*(\d+)\s*years?/);

    if (explicitDays) {
        const d = parseInt(explicitDays[1] || explicitDays[2]);
        if (d === 7)  dateRange = "LAST_7_DAYS";
        else if (d === 14) dateRange = "LAST_14_DAYS";
        else if (d === 30) dateRange = "LAST_30_DAYS";
        else if (d === 90) dateRange = "LAST_90_DAYS";
        else if (d === 180) dateRange = "LAST_180_DAYS";
        else if (d === 365) dateRange = "LAST_365_DAYS";
        else dateRange = `LAST_${d}_DAYS`;
    } else if (explicitWeeks) {
        const w = parseInt(explicitWeeks[1] || explicitWeeks[2]);
        dateRange = `LAST_${w * 7}_DAYS`;
    } else if (explicitMonths) {
        const m = parseInt(explicitMonths[1] || explicitMonths[2]);
        dateRange = m === 1 ? "LAST_30_DAYS" : m === 3 ? "LAST_90_DAYS" : m === 6 ? "LAST_180_DAYS" : m === 12 ? "LAST_365_DAYS" : `LAST_${m * 30}_DAYS`;
    } else if (explicitYears) {
        const y = parseInt(explicitYears[1] || explicitYears[2]);
        dateRange = `LAST_${y * 365}_DAYS`;
    } else if (/this month/.test(q)) {
        dateRange = "THIS_MONTH";
    } else if (/last month/.test(q)) {
        dateRange = "LAST_MONTH";
    } else if (/past\s*week|last\s*week/.test(q)) {
        dateRange = "LAST_7_DAYS";
    } else if (/quarter/.test(q)) {
        dateRange = "LAST_90_DAYS";
    } else if (/year/.test(q)) {
        dateRange = "LAST_365_DAYS";
    }

    // Min spend — "spend > 5", "more than £2", "over $10 spend", default 1
    let minSpend = 1;
    const spendMatch = q.match(/(?:spend|cost)\s*(?:>|over|more\s*than|greater\s*than|of)\s*[£$€]?\s*(\d+(?:\.\d+)?)/)
        || q.match(/[£$€]\s*(\d+(?:\.\d+)?)\s*(?:\+\s*)?(?:spend|cost)/);
    if (spendMatch) minSpend = parseFloat(spendMatch[1]);

    // Min clicks — "1+ clicks", "at least 2 clicks", "more than 0 clicks", "1 click or more"
    let minClicks = 0;
    const clickMatch = q.match(/(\d+)\s*\+\s*clicks?/)
        || q.match(/(?:at\s*least|more\s*than|over|>)\s*(\d+)\s*clicks?/)
        || q.match(/(\d+)\s*clicks?\s*or\s*more/);
    if (clickMatch) minClicks = parseInt(clickMatch[1]);

    return { dateRange, minSpendMicros: Math.round(minSpend * 1_000_000), minClicks };
}

// Fetch search terms from Google Ads API for a given account.
// Returns structured rows ready for analysis.
async function fetchSearchTerms(customerId, filters = {}) {
    const {
        dateRange = "LAST_30_DAYS",
        minSpendMicros = 1_000_000,
        minClicks = 0,
    } = filters;
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) {
            console.error("fetchSearchTerms: gadsClient not initialised — check GOOGLE_ADS_* env vars");
            return [];
        }
        const clicksFilter = minClicks > 0 ? `AND metrics.clicks >= ${minClicks}` : "";
        const queryPromise = customer.query(`
            SELECT
                search_term_view.search_term,
                search_term_view.status,
                campaign.name,
                campaign.resource_name,
                campaign.advertising_channel_type,
                ad_group.name,
                metrics.cost_micros,
                metrics.conversions,
                metrics.conversions_value,
                metrics.impressions,
                metrics.clicks
            FROM search_term_view
            WHERE segments.date ${toGadsDateClause(dateRange)}
                AND metrics.cost_micros >= ${minSpendMicros}
                AND campaign.status = 'ENABLED'
                ${clicksFilter}
            ORDER BY metrics.cost_micros DESC
            LIMIT 1000
        `);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Google Ads API timeout after 30s")), 30000)
        );
        const rows = await Promise.race([queryPromise, timeoutPromise]);
        // Log campaign type breakdown so we can see which campaign types are represented
        const byType = {};
        rows.forEach(r => {
            const t = r.campaign.advertising_channel_type || "UNKNOWN";
            byType[t] = (byType[t] || 0) + 1;
        });
        console.log(`fetchSearchTerms: got ${rows.length} rows — campaign types: ${JSON.stringify(byType)}`);
        const channelTypeLabel = { 2: "Search", 3: "Display", 4: "Shopping", 6: "Video", 8: "Smart", 9: "PMax" };
        return rows.map(r => ({
            searchTerm: r.search_term_view.search_term,
            status: r.search_term_view.status,
            campaign: r.campaign.name,
            campaignType: channelTypeLabel[r.campaign.advertising_channel_type] || "Search",
            campaignResourceName: r.campaign.resource_name,
            adGroup: r.ad_group.name,
            cost: r.metrics.cost_micros / 1_000_000,
            conversions: r.metrics.conversions || 0,
            conversionValue: r.metrics.conversions_value || 0,
            impressions: r.metrics.impressions || 0,
            clicks: r.metrics.clicks || 0,
        }));
    } catch (err) {
        const msg = err?.message || err?.errors?.[0]?.message || JSON.stringify(err) || "unknown error";
        console.error("fetchSearchTerms error:", msg);
        if (err?.errors) console.error("fetchSearchTerms details:", JSON.stringify(err.errors));
        return [];
    }
}

// Fetch Performance Max search term insights (separate resource from search_term_view).
// Returns rows in the same shape as fetchSearchTerms so they can be merged.
async function fetchPMaxSearchTerms(customerId, dateRange = "LAST_30_DAYS") {
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) return [];

        const dateClause = toGadsDateClause(dateRange);
        console.log(`fetchPMaxSearchTerms: querying campaign_search_term_view customer=${customerId} dateClause="${dateClause}"`);

        const rows = await Promise.race([
            customer.query(`
                SELECT
                    campaign_search_term_view.search_term,
                    campaign_search_term_view.campaign,
                    segments.date,
                    metrics.cost_micros,
                    metrics.conversions,
                    metrics.conversions_value,
                    metrics.impressions,
                    metrics.clicks
                FROM campaign_search_term_view
                WHERE segments.date ${dateClause}
                  AND metrics.cost_micros > 0
                ORDER BY metrics.cost_micros DESC
                LIMIT 500
            `),
            new Promise((_, reject) => setTimeout(() => reject(new Error("PMax query timeout")), 30000)),
        ]);
        console.log(`fetchPMaxSearchTerms: got ${rows.length} rows`);

        return rows.map(r => {
            const campaignResourceName = r.campaign_search_term_view?.campaign || "";
            const campaignId = campaignResourceName.split("/").pop() || "unknown";
            return {
                searchTerm: r.campaign_search_term_view.search_term,
                status: "NONE",
                campaign: campaignId,       // resolved to real name in processQuestion
                campaignType: "PMax",
                campaignResourceName,
                adGroup: "PMax",
                cost: (r.metrics.cost_micros || 0) / 1_000_000,
                conversions: r.metrics.conversions || 0,
                conversionValue: r.metrics.conversions_value || 0,
                impressions: r.metrics.impressions || 0,
                clicks: r.metrics.clicks || 0,
            };
        });
    } catch (err) {
        console.error("fetchPMaxSearchTerms error:", err.message || JSON.stringify(err));
        if (err?.errors) console.error("fetchPMaxSearchTerms details:", JSON.stringify(err.errors));
        return [];
    }
}

// Fetch true account-level metrics so ROAS/CPA reflect the full account, not just the
// filtered search term subset.
async function fetchAccountMetrics(customerId, dateRange = "LAST_30_DAYS") {
    try {
        const customer = getGadsCustomer(customerId);
        if (!customer) return null;
        const rows = await Promise.race([
            customer.query(`
                SELECT
                    metrics.cost_micros,
                    metrics.conversions_value,
                    metrics.conversions,
                    metrics.clicks,
                    metrics.impressions
                FROM customer
                WHERE segments.date ${toGadsDateClause(dateRange)}
            `),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Account metrics timeout")), 30000)),
        ]);
        const totals = rows.reduce((acc, r) => ({
            cost: acc.cost + (r.metrics.cost_micros || 0) / 1_000_000,
            conversionValue: acc.conversionValue + (r.metrics.conversions_value || 0),
            conversions: acc.conversions + (r.metrics.conversions || 0),
            clicks: acc.clicks + (r.metrics.clicks || 0),
            impressions: acc.impressions + (r.metrics.impressions || 0),
        }), { cost: 0, conversionValue: 0, conversions: 0, clicks: 0, impressions: 0 });
        console.log(`fetchAccountMetrics: cost=${totals.cost.toFixed(2)}, convValue=${totals.conversionValue.toFixed(2)}`);
        return totals;
    } catch (err) {
        console.error("fetchAccountMetrics error:", err.message || JSON.stringify(err));
        return null;
    }
}

// Format search term rows as CSV that matches what the negative keyword skill expects.
// accountMetrics (optional) supplies true account-level ROAS/CPA so Ema isn't deriving
// it from the filtered search term subset.
function formatSearchTermsForEma(rows, filters, accountMetrics = null) {
    const { dateRange, minSpendMicros, minClicks } = filters;
    const period = dateRange.replace(/_/g, " ").toLowerCase();
    const spendLabel = `min spend: ${(minSpendMicros / 1_000_000).toFixed(2)}`;
    const clicksLabel = minClicks > 0 ? `, min clicks: ${minClicks}` : "";

    let accountSummary = "";
    if (accountMetrics && accountMetrics.cost > 0) {
        const acctRoas = accountMetrics.conversionValue > 0
            ? (accountMetrics.conversionValue / accountMetrics.cost).toFixed(2)
            : "0";
        const acctCpa = accountMetrics.conversions > 0
            ? (accountMetrics.cost / accountMetrics.conversions).toFixed(2)
            : "0";
        accountSummary = `\nACCOUNT TOTALS (full account, ${period}): spend=${accountMetrics.cost.toFixed(2)}, ROAS=${acctRoas}x, CPA=${acctCpa}, conversions=${accountMetrics.conversions.toFixed(0)}, clicks=${accountMetrics.clicks}`;
    }

    const header = "search term,campaign,campaign type,ad group,cost,conversions,conversion value,ROAS,CPA,clicks,status";
    const dataRows = rows.map(r => {
        const roas = r.cost > 0 && r.conversionValue > 0 ? (r.conversionValue / r.cost).toFixed(2) : "0";
        const cpa = r.cost > 0 && r.conversions > 0 ? (r.cost / r.conversions).toFixed(2) : "0";
        return [
            `"${r.searchTerm}"`,
            `"${r.campaign}"`,
            `"${r.campaignType || "Search"}"`,
            `"${r.adGroup}"`,
            r.cost.toFixed(2),
            r.conversions.toFixed(0),
            r.conversionValue.toFixed(2),
            roas,
            cpa,
            r.clicks,
            r.status,
        ].join(",");
    });
    return `FILE: Search Terms from Google Ads (${period}, ${spendLabel}${clicksLabel})${accountSummary}\n${header}\n${dataRows.join("\n")}`;
}

// Keep detectDateRange for backwards compat (used elsewhere)
function detectDateRange(question) {
    return detectSearchTermFilters(question).dateRange;
}

// ── Pending Actions ───────────────────────────────────────────
// When Ema proposes adding negatives, the action is stored here
// keyed by Slack thread_ts. Expires after 10 minutes.

const pendingActions = {};

function buildKeywordIndex(action) {
    const index = {};
    let i = 0;

    // Deduplicate negative keywords — same text+match can be suggested for multiple campaigns.
    // Group them into one entry with a campaigns[] array so the modal shows each term once.
    const negMap = {};
    for (const c of (action.campaigns || [])) {
        for (const kw of (c.keywords || [])) {
            const key = `${kw.text}|||${kw.match}`;
            if (!negMap[key]) negMap[key] = { text: kw.text, match: kw.match, campaigns: [] };
            if (!negMap[key].campaigns.includes(c.name)) negMap[key].campaigns.push(c.name);
        }
    }
    for (const { text, match, campaigns } of Object.values(negMap)) {
        index[`kw${i++}`] = { type: "negative", text, match, campaigns };
    }

    // Positive keywords stay per ad group
    for (const ag of (action.adGroups || [])) {
        for (const kw of (ag.keywords || [])) {
            index[`kw${i++}`] = { type: "positive", text: kw.text, match: kw.match, campaignName: ag.campaignName, adGroupName: ag.adGroupName };
        }
    }
    return index;
}

function storePendingAction(threadTs, action) {
    pendingActions[threadTs] = { ...action, keywordIndex: buildKeywordIndex(action.action), storedAt: Date.now() };
    setTimeout(() => { delete pendingActions[threadTs]; }, 10 * 60 * 1000);
}

function getPendingAction(threadTs) {
    return pendingActions[threadTs] || null;
}

function clearPendingAction(threadTs) {
    delete pendingActions[threadTs];
}

function isConfirmation(text) {
    const t = text.trim().toLowerCase().replace(/[^a-z\s]/g, "").trim();
    return /^(yes|yeah|yep|yup|confirm|go ahead|do it|approved|approve|ok|okay|sure|proceed|add them|add it|looks good|sounds good|perfect|do this)$/.test(t);
}

function isRejection(text) {
    const t = text.trim().toLowerCase().replace(/[^a-z\s]/g, "").trim();
    return /^(no|nope|cancel|stop|dont|nevermind|never mind|hold on|wait|skip|abort)$/.test(t);
}

// Extracts a __GADS_ACTION__....__END_ACTION__ block from Ema's response.
// Returns the clean text (without the block) and the parsed action object.
function extractGadsAction(text) {
    const match = text.match(/\n*__GADS_ACTION__([\s\S]*?)__END_ACTION__\n*/);
    if (!match) return { text, action: null };
    try {
        const action = JSON.parse(match[1].trim());
        const cleanText = text.replace(/\n*__GADS_ACTION__[\s\S]*?__END_ACTION__\n*/, "").trim();
        return { text: cleanText, action };
    } catch (e) {
        console.error("Failed to parse GADS action:", e.message);
        return { text: text.replace(/\n*__GADS_ACTION__[\s\S]*?__END_ACTION__\n*/, "").trim(), action: null };
    }
}

// Executes a confirmed pending action and posts the result to Slack.
async function executePendingAction(pending, say, threadTs) {
    const { action, accountId, accountName } = pending;

    console.log(`executePendingAction: type=${action.type}, accountId=${accountId}`);

    const results = [];
    const errors = [];

    if (action.type === "add_negatives") {
        const campaigns = await listCampaigns(accountId);
        console.log(`executePendingAction: found ${campaigns.length} campaigns`);
        if (campaigns.length === 0) {
            await say({ text: "couldn't fetch campaigns from Google Ads — check the API credentials", thread_ts: threadTs });
            return;
        }
        for (const c of action.campaigns) {
            const campaign = campaigns.find(cam => cam.name.toLowerCase() === c.name.toLowerCase());
            if (!campaign) {
                errors.push(`couldn't find campaign "${c.name}"`);
                continue;
            }
            try {
                await addCampaignNegativeKeywords(accountId, campaign.resourceName, c.keywords);
                const kwList = c.keywords.map(k => `  - "${k.text}" (${k.match.toLowerCase()})`).join("\n");
                results.push(`✓ *${campaign.name}* — ${c.keywords.length} negative${c.keywords.length !== 1 ? "s" : ""} added:\n${kwList}`);
            } catch (err) {
                console.error(`executePendingAction negatives error for "${c.name}":`, err.message);
                errors.push(`*${c.name}*: ${err.message}`);
            }
        }

    } else if (action.type === "add_keywords") {
        const adGroups = await listAdGroups(accountId);
        console.log(`executePendingAction: found ${adGroups.length} ad groups`);
        if (adGroups.length === 0) {
            await say({ text: "couldn't fetch ad groups from Google Ads — check the API credentials", thread_ts: threadTs });
            return;
        }
        for (const ag of action.adGroups) {
            const adGroup = adGroups.find(a =>
                a.name.toLowerCase() === ag.adGroupName.toLowerCase() &&
                a.campaignName.toLowerCase() === ag.campaignName.toLowerCase()
            );
            if (!adGroup) {
                errors.push(`couldn't find ad group "${ag.adGroupName}" in campaign "${ag.campaignName}"`);
                continue;
            }
            try {
                await addAdGroupKeywords(accountId, adGroup.resourceName, ag.keywords);
                const kwList = ag.keywords.map(k => `  - "${k.text}" (${k.match.toLowerCase()})`).join("\n");
                results.push(`✓ *${ag.campaignName} > ${ag.adGroupName}* — ${ag.keywords.length} keyword${ag.keywords.length !== 1 ? "s" : ""} added:\n${kwList}`);
            } catch (err) {
                console.error(`executePendingAction keywords error for "${ag.adGroupName}":`, err.message);
                errors.push(`*${ag.adGroupName}*: ${err.message}`);
            }
        }

    } else if (action.type === "add_negatives_and_keywords") {
        const [campaigns, adGroups] = await Promise.all([listCampaigns(accountId), listAdGroups(accountId)]);
        for (const c of (action.campaigns || [])) {
            const campaign = campaigns.find(cam => cam.name.toLowerCase() === c.name.toLowerCase());
            if (!campaign) { errors.push(`couldn't find campaign "${c.name}"`); continue; }
            try {
                await addCampaignNegativeKeywords(accountId, campaign.resourceName, c.keywords);
                const kwList = c.keywords.map(k => `  - "${k.text}" (${k.match.toLowerCase()})`).join("\n");
                results.push(`✓ *${campaign.name}* — ${c.keywords.length} negative${c.keywords.length !== 1 ? "s" : ""} added:\n${kwList}`);
            } catch (err) {
                console.error(`executePendingAction negatives error for "${c.name}":`, err.message);
                errors.push(`*${c.name}*: ${err.message}`);
            }
        }
        for (const ag of (action.adGroups || [])) {
            const adGroup = adGroups.find(a =>
                a.name.toLowerCase() === ag.adGroupName.toLowerCase() &&
                a.campaignName.toLowerCase() === ag.campaignName.toLowerCase()
            );
            if (!adGroup) { errors.push(`couldn't find ad group "${ag.adGroupName}" in campaign "${ag.campaignName}"`); continue; }
            try {
                await addAdGroupKeywords(accountId, adGroup.resourceName, ag.keywords);
                const kwList = ag.keywords.map(k => `  - "${k.text}" (${k.match.toLowerCase()})`).join("\n");
                results.push(`✓ *${ag.campaignName} > ${ag.adGroupName}* — ${ag.keywords.length} keyword${ag.keywords.length !== 1 ? "s" : ""} added:\n${kwList}`);
            } catch (err) {
                console.error(`executePendingAction keywords error for "${ag.adGroupName}":`, err.message);
                errors.push(`*${ag.adGroupName}*: ${err.message}`);
            }
        }

    } else {
        await say({ text: "not sure how to execute that — check with your admin", thread_ts: threadTs });
        return;
    }

    let reply = results.length > 0
        ? `done ✓ here's what I added to *${accountName}*:\n\n${results.join("\n\n")}`
        : "nothing was added";

    if (errors.length > 0) reply += `\n\n⚠️ issues:\n${errors.map(e => `- ${e}`).join("\n")}`;

    await say({ text: reply, thread_ts: threadTs });
}

// ── Directory Structure ───────────────────────────────────────
const CHANNEL_SKILLS_DIR = path.join(__dirname, "skills", "channel");
const CLIENT_SKILLS_DIR = path.join(__dirname, "skills", "clients");
const LEGACY_SKILLS_DIR = path.join(__dirname, "skills");

// ── Greeting Memory ───────────────────────────────────────────
// Tracks last greeting per user per day so Ema greets once per day
const greetingMemory = {};

function shouldGreet(userId) {
    const today = new Date().toISOString().split("T")[0];
    if (greetingMemory[userId] === today) return false;
    greetingMemory[userId] = today;
    return true;
}

// ── MCC Account Discovery ─────────────────────────────────────
// Fetches all client accounts from the MCC — same approach that works for MCC.
// Falls back to ACCOUNTS env var if MCC is unavailable.

let mccAccountsCache = null;
let mccAccountsCachedAt = 0;
const MCC_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function listMccAccounts() {
    const now = Date.now();
    if (mccAccountsCache && (now - mccAccountsCachedAt) < MCC_CACHE_TTL) {
        return mccAccountsCache;
    }
    const loginId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!gadsClient || !loginId) return [];
    try {
        const mccCustomer = gadsClient.Customer({
            customer_id: loginId.replace(/-/g, ""),
            login_customer_id: loginId.replace(/-/g, ""),
            refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN"),
        });
        const rows = await Promise.race([
            mccCustomer.query(`
                SELECT customer_client.client_customer, customer_client.descriptive_name,
                       customer_client.id, customer_client.level, customer_client.status
                FROM customer_client
                WHERE customer_client.level = 1
                  AND customer_client.status = 'ENABLED'
                ORDER BY customer_client.descriptive_name
            `),
            new Promise((_, reject) => setTimeout(() => reject(new Error("MCC query timeout")), 30000)),
        ]);
        const accounts = rows.map(r => ({
            id: String(r.customer_client.id),
            name: r.customer_client.descriptive_name || String(r.customer_client.id),
        }));
        console.log(`listMccAccounts: found ${accounts.length} accounts`);
        accounts.forEach(a => console.log(`  - ${a.name} (${a.id})`));
        mccAccountsCache = accounts;
        mccAccountsCachedAt = now;
        return accounts;
    } catch (err) {
        console.error("listMccAccounts error:", err.message);
        if (err.errors) console.error("listMccAccounts details:", JSON.stringify(err.errors));
        if (err.code) console.error("listMccAccounts code:", err.code);
        return mccAccountsCache || [];
    }
}

// Load accounts from ACCOUNTS env var — manual fallback / non-MCC accounts.
// Format: "ClientName1:123-456-7890,ClientName2:098-765-4321"
function loadStaticAccounts() {
    const accounts = {};
    const raw = (process.env.ACCOUNTS || "").trim();
    if (!raw) return accounts;
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
        [...new Set(keys)].forEach(key => { accounts[key] = { id, name }; });
    });
    return accounts;
}

// Build lookup keys from an account name
function accountKeys(name) {
    return [...new Set([
        name.toLowerCase().replace(/[^a-z0-9]/g, ""),
        ...name.toLowerCase().split(/[\s&,_-]+/).filter(w => w.length > 2),
    ])];
}

// Merge static + MCC accounts (static takes priority on ID conflicts)
async function getAllAccounts() {
    const staticAccounts = loadStaticAccounts();
    const mccAccounts = await listMccAccounts();
    const byId = {};
    for (const acc of Object.values(staticAccounts)) byId[acc.id] = acc;
    for (const acc of mccAccounts) { if (!byId[acc.id]) byId[acc.id] = acc; }
    return Object.values(byId);
}

// Whole-word match — avoids "sea" matching inside "search"
function matchesWord(q, key) {
    if (key.length < 3) return false;
    return new RegExp(`\\b${key}\\b`).test(q);
}

async function detectAccount(question) {
    const q = question.toLowerCase().replace(/[^a-z0-9\s]/g, "");

    // Check static accounts first (fast, no API call)
    const staticAccounts = loadStaticAccounts();
    for (const [key, account] of Object.entries(staticAccounts)) {
        if (matchesWord(q, key)) return account;
    }

    // Check MCC accounts with whole-word matching
    const mccAccounts = await listMccAccounts();
    for (const acc of mccAccounts) {
        for (const key of accountKeys(acc.name)) {
            if (matchesWord(q, key)) return acc;
        }
    }

    // If only one account total, return it as default
    const all = await getAllAccounts();
    if (all.length === 1) return all[0];

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
        const cleanChannel = (info.channel.name || "").toLowerCase().replace(/[-_\s]/g, "");
        for (const account of await getAllAccounts()) {
            const parts = account.name.toLowerCase().split(/[\s&,_-]+/).filter(w => w.length > 3);
            for (const part of parts) {
                if (cleanChannel.includes(part)) {
                    console.log(`detectClientFromChannel: matched "${account.name}" via word "${part}" in channel "${cleanChannel}"`);
                    return account.name;
                }
            }
        }
    } catch (e) { console.error("detectClientFromChannel error:", e.message); }
    return null;
}

// ── Skill Discovery ─────────────────────────────────────────
// Structure:
//   skills/channel/   ← platform/strategy skills (google-ads-*.md, meta-ads-*.md, etc.)
//   skills/clients/   ← client knowledge files (e.g. agencyname.md, clientname.md)
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

    // Legacy fallback: root-level file like clientname-knowledge.md
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
// Used for ad copy creation so Ema understands the full offering.

async function scrapeSinglePage(url) {
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; EmaBot/1.0)" },
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
    const matches = text.match(urlRegex) || [];
    // Slack formats URLs as <https://url|Display Text> — strip the pipe and display text
    return matches.map(u => u.split("|")[0]);
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

// ── Ema's Personality & System Prompt ─────────────────────────

function buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames, webContext, campaigns = [], adGroups = []) {
    return `You are Ema — a real person on the team, not an AI assistant. You're a sharp, warm, emotionally intelligent paid media strategist who genuinely cares about the people she works with and the clients she helps.

HOW YOU TALK:
- You talk like a real colleague in Slack — casual, direct, warm. Not corporate, not robotic.
- You never say things like "I'm an AI" or "As an AI" or "I don't have feelings" — you're Ema, period.
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

${campaigns.length > 0 ? `GOOGLE ADS CAMPAIGNS (live from API):
${campaigns.map(c => `- ${c.name} [${c.status}]`).join("\n")}

` : ""}${adGroups.length > 0 ? `GOOGLE ADS AD GROUPS (live from API):
${adGroups.map(a => `- ${a.campaignName} > ${a.name}`).join("\n")}

` : ""}${campaigns.length > 0 ? `MAKING CHANGES DIRECTLY IN GOOGLE ADS:
You have live API access. You MUST end your message with ONE action block when recommending changes. Never say you can't make changes — you can.

For NEGATIVE KEYWORDS — end your message with (note: use BROAD for single words, PHRASE for 2-word phrases, EXACT for 3+ words):
__GADS_ACTION__{"type":"add_negatives","campaigns":[{"name":"EXACT CAMPAIGN NAME","keywords":[{"text":"jobs","match":"BROAD"},{"text":"side effects","match":"PHRASE"},{"text":"melatonin overdose symptoms","match":"EXACT"}]}]}__END_ACTION__

For ADDING KEYWORDS to ad groups — end your message with:
__GADS_ACTION__{"type":"add_keywords","adGroups":[{"campaignName":"EXACT CAMPAIGN NAME","adGroupName":"EXACT AD GROUP NAME","keywords":[{"text":"keyword","match":"EXACT"}]}]}__END_ACTION__

For BOTH negatives AND keywords — end your message with ONE block:
__GADS_ACTION__{"type":"add_negatives_and_keywords","campaigns":[{"name":"EXACT CAMPAIGN NAME","keywords":[{"text":"jobs","match":"BROAD"},{"text":"side effects","match":"PHRASE"},{"text":"melatonin overdose symptoms","match":"EXACT"}]}],"adGroups":[{"campaignName":"EXACT CAMPAIGN NAME","adGroupName":"EXACT AD GROUP NAME","keywords":[{"text":"keyword","match":"EXACT"}]}]}__END_ACTION__

CRITICAL RULES:
- Including the action block is MANDATORY — never skip it when recommending changes
- Campaign and ad group names must exactly match the lists above
- match values MUST be uppercase: "BROAD", "PHRASE", or "EXACT" — never lowercase
- For negatives: single words → BROAD, 2-word phrases → PHRASE, 3+ words → EXACT. For keywords: match defaults to EXACT
- Include ALL changes in ONE block — never write multiple blocks
- If you skip the action block, the user cannot confirm and the changes won't happen

` : ""}YOUR CAPABILITIES:
- You can pull live ad performance data from Windsor.ai (if data is provided below, use it)
- You can browse websites and read multiple pages — if web content is provided below, you already did this
- You can search the web via Google — if search results are provided below, you already did this
- You can read CSV, Excel, and Google Sheets files — if file content is provided below, use it directly
- You can add negative keywords directly to Google Ads campaigns — campaigns are listed above when available
- Search term data may be pre-loaded from the Google Ads API — if you see "FILE: Search Terms from Google Ads" in the WEB RESEARCH section, that IS the search term report. Use it immediately and run the full analysis without asking for anything.

NEGATIVE KEYWORD ANALYSIS — WEBSITE CHECK:
The system automatically discovers the client website from their Google Ads account (from ad landing pages). You must NEVER ask the user for a website URL or to upload any file — all data is fetched automatically.
- If website content IS in your context (under WEB RESEARCH): use it as your relevance reference. Proceed with the full analysis.
- If website content is NOT in your context: proceed using the account name and campaign/ad group names to infer what the client sells. Make reasonable inferences and run the full analysis. Do NOT ask for a URL.

WHEN SOMETHING IS MISSING — one line, nothing else:
- Missing file: "can't see the file, can you re-upload it?" — that's it. No bullet points. No "once I have it I'll...". Stop there.
- Missing info: ask for the ONE thing you need. One sentence. Done.
- Can't do something: "can't do that" — not a paragraph.
- HARD RULE: never write bullets explaining what you WOULD do once you get the missing thing. That is the most annoying thing you can do. Just ask for what you need and stop.

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

// ── Client Website Extraction ────────────────────────────────
// Reads the client's website URL from their knowledge file.
// Handles common formats: "website: domain.com", "website (domain.com)",
// "https://domain.com", etc. Never hardcodes URLs — always reads from knowledge.

function extractClientWebsite(knowledge) {
    if (!knowledge) return null;

    // 1. Explicit https:// URL next to a website/url/site/domain keyword
    const explicitMatch = knowledge.match(/(?:website|url|site|domain|landing)[^:\n]*?[:\s(]+(https?:\/\/[^\s,\n)]+)/i);
    if (explicitMatch) {
        try { new URL(explicitMatch[1]); return explicitMatch[1]; } catch { /* invalid */ }
    }

    // 2. Bare domain next to a website/url/site/domain keyword (strips leading punctuation)
    const bareMatch = knowledge.match(/(?:website|url|site|domain|landing)[^:\n]*?[:\s(]+(?:https?:\/\/)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
    if (bareMatch) {
        const candidate = bareMatch[1].replace(/[),;]+$/, ""); // strip trailing punctuation
        const url = candidate.startsWith("http") ? candidate : "https://" + candidate;
        try { new URL(url); return url; } catch { /* invalid */ }
    }

    return null;
}

// ── File Reading ─────────────────────────────────────────────
// Handles CSV, Excel (.xlsx/.xls) uploaded to Slack, and Google Sheets URLs.

async function readSlackFile(fileObj) {
    try {
        // Slack event payloads only include partial file info — fetch full file to get url_private
        let fullFile = fileObj;
        if (!fileObj.url_private && fileObj.id) {
            const info = await slack.client.files.info({ file: fileObj.id });
            fullFile = info.file;
        }

        const url = fullFile.url_private_download || fullFile.url_private;
        if (!url) return null;

        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });
        if (!res.ok) {
            console.error("File download failed:", res.status, url);
            return null;
        }

        const mimetype = (fullFile.mimetype || fileObj.mimetype || "").toLowerCase();
        const filename = fullFile.name || fileObj.name || "file";

        // CSV
        if (mimetype.includes("csv") || filename.endsWith(".csv")) {
            const text = await res.text();
            return formatFileContent(text, filename);
        }

        // Excel (.xlsx / .xls)
        if (mimetype.includes("spreadsheetml") || mimetype.includes("ms-excel") ||
            filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
            const buffer = await res.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: "array" });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            return formatFileContent(csv, filename);
        }

        // Plain text fallback
        if (mimetype.includes("text")) {
            const text = await res.text();
            return `FILE: ${filename}\n${text.substring(0, 15000)}`;
        }

        console.error("Unsupported file type:", mimetype, filename);
        return null;
    } catch (err) {
        console.error("File read error:", err.message);
        return null;
    }
}

async function readGoogleSheet(url) {
    try {
        const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (!match) return null;
        const sheetId = match[1];
        const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        const res = await fetch(csvUrl);
        if (!res.ok) return null;
        const text = await res.text();
        return formatFileContent(text, "Google Sheet");
    } catch (err) {
        console.error("Google Sheet read error:", err.message);
        return null;
    }
}

async function readGoogleDoc(url) {
    try {
        const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
        if (!match) {
            console.log("Google Doc: no doc ID found in URL:", url);
            return null;
        }
        const docId = match[1];
        const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
        console.log("Google Doc: fetching", exportUrl);
        const res = await fetch(exportUrl);
        console.log("Google Doc: response status", res.status, "content-type", res.headers.get("content-type"));
        if (!res.ok) {
            console.error("Google Doc: fetch failed with status", res.status);
            return null;
        }
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
            console.error("Google Doc: got HTML response — doc is likely private or requires login");
            return null;
        }
        const text = await res.text();
        console.log("Google Doc: read", text.length, "chars");
        return `FILE: Google Doc\n${text.substring(0, 15000)}`;
    } catch (err) {
        console.error("Google Doc read error:", err.message);
        return null;
    }
}

function formatFileContent(csvText, filename) {
    // Limit to first 300 rows to avoid token overload
    const rows = csvText.split("\n").filter(r => r.trim()).slice(0, 300);
    return `FILE: ${filename}\n${rows.join("\n")}`;
}

// ── Thread History ────────────────────────────────────────────
// Fetches previous messages from a Slack thread so Ema has full conversation context.
// Only runs when the current message is a reply inside an existing thread.

async function fetchThreadHistory(channelId, threadTs, currentTs) {
    // No thread context if this is the root message
    if (!threadTs || threadTs === currentTs) return [];

    try {
        const result = await slack.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 20,
        });

        const messages = (result.messages || [])
            .filter(msg => msg.ts !== currentTs); // exclude current message — that's already the question

        const history = [];
        for (const msg of messages) {
            const role = msg.bot_id ? "assistant" : "user";
            const text = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
            if (!text) continue;
            history.push({ role, content: text });
        }

        // Claude requires strictly alternating user/assistant messages — merge consecutive same-role messages
        const merged = [];
        for (const msg of history) {
            if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
                merged[merged.length - 1].content += "\n" + msg.content;
            } else {
                merged.push({ ...msg });
            }
        }

        // Claude messages array must start with a user message
        if (merged.length > 0 && merged[0].role === "assistant") merged.shift();

        return merged;
    } catch (err) {
        console.error("Thread history error:", err.message);
        return [];
    }
}

// ── Main AI Call ──────────────────────────────────────────────

async function askEma(question, skillNames, data, account, clientKnowledge, greeting, webContext, threadHistory = [], campaigns = [], adGroups = []) {
    const skillContents = skillNames
        .filter(s => s !== "general")
        .map(s => {
            const content = loadSkillContent(s);
            return content ? `\n--- SKILL: ${s} ---\n${content}` : "";
        })
        .join("\n");

    const dataContext = data.length > 0 ? formatData(data, account.name) : "No data available for this period.";
    const system = buildSystemPrompt(skillContents, clientKnowledge, dataContext, skillNames, webContext, campaigns, adGroups);

    const userMessage = greeting
        ? `[First message from this person today — greet them warmly but briefly, like a colleague would. Just a quick "hey!" or "morning!" type thing, then get to their question. Don't make the greeting a big deal.]\n\n${question}`
        : question;

    // Include full thread history so Ema knows what was already discussed
    const messages = threadHistory.length > 0
        ? [...threadHistory, { role: "user", content: userMessage }]
        : [{ role: "user", content: userMessage }];

    const res = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: system,
        messages,
    });
    return res.content[0].text;
}

// ── Process Question (shared logic) ──────────────────────────

async function processQuestion(question, account, userId, channelId, event, say) {
    const greeting = shouldGreet(userId);
    const intent = await detectIntent(question);

    // Show a thinking message only when actually pulling data or doing research
    if (intent.needsData || intent.needsWebSearch || intent.needsScrape) {
        const thinkingMessages = [
            "Let me pull that up for *" + account.name + "*...",
            "On it, checking *" + account.name + "* now...",
            "Looking into this for *" + account.name + "*...",
            "Give me a sec, pulling *" + account.name + "* data...",
        ];
        const thinkingMsg = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
        await say({ text: thinkingMsg, thread_ts: event.thread_ts || event.ts });
    }

    try {
        // Run independent tasks in parallel
        const [skillNames, clientKnowledge, data, webResults] = await Promise.all([
            routeToSkills(question, account.name),
            Promise.resolve(loadClientKnowledge(account.name)),
            intent.needsData ? fetchWindsorData(question, account.id) : Promise.resolve([]),
            intent.needsWebSearch ? searchWeb(question) : Promise.resolve([]),
        ]);

        // Read any attached files (CSV, Excel)
        let fileContext = "";
        const slackFiles = event.files || [];
        if (slackFiles.length > 0) {
            const fileContents = await Promise.all(slackFiles.map(f => readSlackFile(f)));
            const parsed = fileContents.filter(Boolean);
            if (parsed.length > 0) fileContext = parsed.join("\n\n");
        }

        // Crawl websites — use URLs from question, or look up client website if scraping needed
        // Skip Google Sheets URLs here — those are handled as files below
        let webContext = "";
        let urlsToCrawl = intent.urls.filter(u => {
            try { const parsed = new URL(u); return !parsed.hostname.includes("docs.google.com"); } catch { return false; }
        });

        // Read Google Sheets URLs if present
        const sheetUrls = intent.urls.filter(u => u.includes("docs.google.com/spreadsheets"));
        if (sheetUrls.length > 0) {
            const sheetContents = await Promise.all(sheetUrls.map(u => readGoogleSheet(u)));
            const parsed = sheetContents.filter(Boolean);
            if (parsed.length > 0) fileContext += (fileContext ? "\n\n" : "") + parsed.join("\n\n");
        }

        // Read Google Docs URLs if present
        const docUrls = intent.urls.filter(u => u.includes("docs.google.com/document"));
        if (docUrls.length > 0) {
            const docContents = await Promise.all(docUrls.map(u => readGoogleDoc(u)));
            const parsed = docContents.filter(Boolean);
            if (parsed.length > 0) fileContext += (fileContext ? "\n\n" : "") + parsed.join("\n\n");
        }

        // Auto-fetch search terms from Google Ads if doing negative keyword analysis and no file uploaded.
        // Fetches Search/Shopping terms + PMax search term insights + true account-level metrics in parallel.
        const needsSearchTerms = skillNames.some(s => s.includes("negative"))
            && slackFiles.length === 0
            && sheetUrls.length === 0
            && docUrls.length === 0
            && gadsClient;
        if (needsSearchTerms) {
            const filters = detectSearchTermFilters(question);
            console.log(`Fetching search terms for ${account.name} — ${filters.dateRange}, minSpend: ${filters.minSpendMicros / 1_000_000}, minClicks: ${filters.minClicks}`);
            const [searchTermRows, pmaxRows, accountMetrics, allCampaigns] = await Promise.all([
                fetchSearchTerms(account.id, filters),
                fetchPMaxSearchTerms(account.id, filters.dateRange),
                fetchAccountMetrics(account.id, filters.dateRange),
                listCampaigns(account.id),
            ]);
            // Resolve PMax campaign IDs to real names using the campaign list
            const campaignById = {};
            for (const c of allCampaigns) campaignById[c.id] = c.name;
            const resolvedPmaxRows = pmaxRows.map(r => {
                const campaignId = r.campaignResourceName.split("/").pop();
                return { ...r, campaign: campaignById[campaignId] || r.campaign };
            });
            const allRows = [...searchTermRows, ...resolvedPmaxRows];
            console.log(`Fetched ${searchTermRows.length} search + ${pmaxRows.length} PMax terms for ${account.name}`);
            if (allRows.length > 0) {
                const searchTermCsv = formatSearchTermsForEma(allRows, filters, accountMetrics);
                fileContext = searchTermCsv + (fileContext ? "\n\n" + fileContext : "");
            } else {
                console.log(`No search terms returned from Google Ads for ${account.name} — no data in range or account may be PMax-only`);
                fileContext = "Search Terms from Google Ads: No search term data found for the selected date range. This may be because the account runs PMax campaigns only (which don't expose individual search terms), or there were no impressions in the period." + (fileContext ? "\n\n" + fileContext : "");
            }
        }

        // Always crawl the client website when doing negative keyword analysis.
        // Without website vocabulary we can't check relevance and will suggest wrong negatives.
        if ((needsSearchTerms || intent.needsScrape) && urlsToCrawl.length === 0) {
            // 1. Try client knowledge file first
            const clientUrl = clientKnowledge ? extractClientWebsite(clientKnowledge) : null;
            if (clientUrl) {
                urlsToCrawl.push(clientUrl);
            } else if (needsSearchTerms) {
                // 2. Pull website URL directly from the Google Ads account's ad final_urls
                const adsWebsite = await fetchAccountWebsite(account.id);
                if (adsWebsite) urlsToCrawl.push(adsWebsite);
            }
        }

        if (urlsToCrawl.length > 0) {
            await say({ text: "browsing the site to understand it better — checking multiple pages...", thread_ts: event.thread_ts || event.ts });
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

        // Merge file context into web context
        if (fileContext) webContext = fileContext + (webContext ? "\n\n---\n\n" + webContext : "");

        // Fetch campaigns and/or ad groups from Google Ads API when doing keyword work
        const needsCampaigns = skillNames.some(s => s.includes("negative") || s.includes("keyword"));
        const needsAdGroups = skillNames.some(s => s.includes("keyword"));
        const [campaigns, adGroups] = needsCampaigns
            ? await Promise.all([
                listCampaigns(account.id),
                needsAdGroups ? listAdGroups(account.id) : Promise.resolve([]),
              ])
            : [[], []];
        console.log(`processQuestion: needsCampaigns=${needsCampaigns}, campaigns=${campaigns.length}, adGroups=${adGroups.length}, skills=${skillNames.join(",")}`);

        // Fetch thread history so Ema knows what's already been discussed
        const threadHistory = await fetchThreadHistory(channelId, event.thread_ts, event.ts);

        // Send a "still working" message after 20s so Slack doesn't look frozen on big tasks
        const stillWorkingMsg = setTimeout(async () => {
            try {
                await say({ text: "still on it — this one's a big task, almost there...", thread_ts: event.thread_ts || event.ts });
            } catch (_) {}
        }, 20000);

        // Ask Ema
        const rawAnswer = await askEma(question, skillNames, data, account, clientKnowledge, greeting, webContext || "", threadHistory, campaigns, adGroups);
        clearTimeout(stillWorkingMsg);

        // Extract any Google Ads action block Ema embedded in her response
        const { text: answer, action } = extractGadsAction(rawAnswer);
        console.log(`processQuestion: action block found=${!!action}, rawAnswer contains __GADS_ACTION__=${rawAnswer.includes("__GADS_ACTION__")}`);

        // Store pending action and post review buttons if action was proposed
        const threadTs = event.thread_ts || event.ts;
        if (action && (campaigns.length > 0 || adGroups.length > 0)) {
            storePendingAction(threadTs, { action, accountId: account.id, accountName: account.name, campaigns });
            await say({ text: answer, thread_ts: threadTs });
            await say({
                text: "Want to add these keywords to Google Ads?",
                thread_ts: threadTs,
                blocks: [
                    {
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: { type: "plain_text", text: "Review & Select Keywords" },
                                style: "primary",
                                action_id: "review_keywords",
                                value: threadTs,
                            },
                            {
                                type: "button",
                                text: { type: "plain_text", text: "Add All" },
                                action_id: "add_all_keywords",
                                value: threadTs,
                            },
                        ],
                    },
                ],
            });
        } else {
            await say({ text: answer, thread_ts: threadTs });
        }
    } catch (err) {
        console.error("Ema error:", err);
        await say({
            text: "hmm something broke on my end — " + err.message + "\nlet me know if it keeps happening",
            thread_ts: event.thread_ts || event.ts,
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

        // Read any attached files (CSV, Excel)
        let fileContext = "";
        const slackFiles = event.files || [];
        if (slackFiles.length > 0) {
            const fileContents = await Promise.all(slackFiles.map(f => readSlackFile(f)));
            const parsed = fileContents.filter(Boolean);
            if (parsed.length > 0) fileContext = parsed.join("\n\n");
        }

        // Read Google Sheets URLs if present
        const sheetUrls = intent.urls.filter(u => u.includes("docs.google.com/spreadsheets"));
        if (sheetUrls.length > 0) {
            const sheetContents = await Promise.all(sheetUrls.map(u => readGoogleSheet(u)));
            const parsed = sheetContents.filter(Boolean);
            if (parsed.length > 0) fileContext += (fileContext ? "\n\n" : "") + parsed.join("\n\n");
        }

        // Read Google Docs URLs if present
        const docUrls = intent.urls.filter(u => u.includes("docs.google.com/document"));
        if (docUrls.length > 0) {
            const docContents = await Promise.all(docUrls.map(u => readGoogleDoc(u)));
            const parsed = docContents.filter(Boolean);
            if (parsed.length > 0) fileContext += (fileContext ? "\n\n" : "") + parsed.join("\n\n");
        }

        let webContext = "";
        const validUrls = intent.urls.filter(u => {
            try { const p = new URL(u); return !p.hostname.includes("docs.google.com"); } catch { return false; }
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

        // Merge file context in
        if (fileContext) webContext = fileContext + (webContext ? "\n\n---\n\n" + webContext : "");

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

        // Fetch thread history so Ema knows what's already been discussed
        const threadHistory = await fetchThreadHistory(channelId, event.thread_ts, event.ts);

        // Include full thread history so Ema has conversation context
        const messages = threadHistory.length > 0
            ? [...threadHistory, { role: "user", content: userMessage }]
            : [{ role: "user", content: userMessage }];

        const res = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            system: system,
            messages,
        });

        await say({
            text: res.content[0].text,
            thread_ts: event.thread_ts || event.ts,
        });
    } catch (err) {
        console.error("Ema error:", err);
        await say({
            text: "hmm something broke — " + err.message,
            thread_ts: event.thread_ts || event.ts,
        });
    }
}

// ── Slack Event: @Ema Mentions ───────────────────────────────

slack.event("app_mention", async ({ event, say }) => {
    const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const hasFiles = (event.files || []).length > 0;
    const userId = event.user;
    const channelId = event.channel;

    // If mention has a file but no text, treat it as "analyse this"
    const effectiveQuestion = question || (hasFiles ? "please analyse this file" : "");

    // Check for pending Google Ads action confirmation/rejection first
    const threadTs = event.thread_ts || event.ts;
    const pending = getPendingAction(threadTs);
    if (pending) {
        if (isConfirmation(effectiveQuestion)) {
            clearPendingAction(threadTs);
            await executePendingAction(pending, say, threadTs);
            return;
        }
        if (isRejection(effectiveQuestion)) {
            clearPendingAction(threadTs);
            await say({ text: "no problem, cancelled", thread_ts: threadTs });
            return;
        }
    }

    // Empty mention with no files — introduce herself
    if (!effectiveQuestion) {
        const allAccounts = await getAllAccounts();
        const clientList = allAccounts.length > 0
            ? allAccounts.map(a => "- " + a.name).join("\n")
            : "- (no accounts connected yet)";
        const skills = getAllSkills();
        await say({
            text: "hey! I'm Ema — your paid media AI assistant :wave:\n\nI can help with stuff like:\n- account audits & performance deep dives\n- campaign optimization\n- budget & bidding strategy\n- ad copy, keywords, audiences\n- figuring out why metrics spiked or dropped\n- researching competitors or landing pages\n- and honestly most things Google Ads related\n\nI have access to these accounts:\n" + clientList + "\n\nJust @ me with whatever you need — like:\n_@Ema how's the account doing this week?_\n_@Ema write some headlines for our new campaign_\n_@Ema check out this landing page and suggest ad copy: [url]_\n\nI've got " + skills.length + " skills loaded so I can go pretty deep on things.",
            thread_ts: event.thread_ts || event.ts,
        });
        return;
    }

    // Try channel name FIRST, then question text
    let account = null;
    const channelClient = await detectClientFromChannel(channelId);
    if (channelClient) {
        account = await detectAccount(channelClient);
        if (account) console.log(`app_mention: account "${account.name}" resolved from channel name`);
    }
    if (!account) {
        account = await detectAccount(effectiveQuestion);
        if (account) console.log(`app_mention: account "${account.name}" resolved from question text`);
    }

    if (!account) {
        // Check if this is a general question that doesn't need account data
        const intent = await detectIntent(effectiveQuestion);
        if (!intent.needsData) {
            await processGeneralQuestion(effectiveQuestion, userId, channelId, event, say);
            return;
        }

        const allAccounts = await getAllAccounts();
        const clientList = allAccounts.map(a => a.name).join(", ");
        await say({
            text: "hey which account are you asking about? I've got: *" + clientList + "*\njust drop the name in your question and I'll pull everything up",
            thread_ts: event.thread_ts || event.ts,
        });
        return;
    }

    await processQuestion(effectiveQuestion, account, userId, channelId, event, say);
});

// ── Slack Event: Direct Messages ─────────────────────────────

slack.event("message", async ({ event, say }) => {
    // Only handle DMs (channel type "im"), skip bot messages, skip threaded replies to avoid loops
    if (event.channel_type !== "im" || event.bot_id || event.subtype) return;

    const question = (event.text || "").trim();
    const hasFiles = (event.files || []).length > 0;

    // Skip if no text and no files
    if (!question && !hasFiles) return;

    // If someone sends only a file with no text, treat it as "analyse this"
    const effectiveQuestion = question || "please analyse this file";

    const userId = event.user;
    const channelId = event.channel;

    // Check for pending Google Ads action confirmation/rejection first
    const threadTs = event.thread_ts || event.ts;
    const pending = getPendingAction(threadTs);
    if (pending) {
        if (isConfirmation(effectiveQuestion)) {
            clearPendingAction(threadTs);
            await executePendingAction(pending, say, threadTs);
            return;
        }
        if (isRejection(effectiveQuestion)) {
            clearPendingAction(threadTs);
            await say({ text: "no problem, cancelled", thread_ts: threadTs });
            return;
        }
    }

    // Detect account from question text
    const account = await detectAccount(effectiveQuestion);

    if (account) {
        await processQuestion(effectiveQuestion, account, userId, channelId, event, say);
    } else {
        // Check if they need account data or it's a general question
        const intent = await detectIntent(effectiveQuestion);
        if (intent.needsData) {
            const allAccounts = await getAllAccounts();
            const clientList = allAccounts.map(a => a.name).join(", ");
            await say({
                text: "which account should I look at? I've got: *" + clientList + "*",
                thread_ts: event.thread_ts || event.ts,
            });
        } else {
            await processGeneralQuestion(effectiveQuestion, userId, channelId, event, say);
        }
    }
});

// ── Keyword Review Modal ──────────────────────────────────────

function buildKeywordReviewModal(accountName, keywordIndex, enabledCampaigns) {
    const blocks = [];
    const entries = Object.entries(keywordIndex);
    const negEntries = entries.filter(([, v]) => v.type === "negative");
    const posEntries = entries.filter(([, v]) => v.type === "positive");

    // Campaign options: "All campaigns" first, then each individual campaign
    const allCampaignOption = {
        text: { type: "plain_text", text: "All campaigns" },
        value: "all_campaigns",
    };
    const campaignOptions = [
        allCampaignOption,
        ...enabledCampaigns.slice(0, 49).map(c => ({
            text: { type: "plain_text", text: c.name.substring(0, 75) },
            value: c.resourceName,
        })),
    ];

    // ── Negative keywords ─────────────────────────────────────────────────────
    if (negEntries.length > 0) {
        blocks.push({
            type: "section",
            block_id: "neg_header",
            text: { type: "mrkdwn", text: "*Negative Keywords*\nEach keyword appears once. Select which campaigns to add it to — pick one, multiple, or *All campaigns*. Leave blank to skip." },
        });

        const MAX_NEGS = 88;
        const negToRender = negEntries.slice(0, MAX_NEGS);
        const negTruncated = negEntries.length > MAX_NEGS;

        for (const [id, kw] of negToRender) {
            // Pre-select the suggested campaigns by matching their resourceNames
            const initialOptions = (kw.campaigns || [])
                .map(name => {
                    const camp = enabledCampaigns.find(c => c.name.toLowerCase() === name.toLowerCase());
                    return camp ? { text: { type: "plain_text", text: camp.name.substring(0, 75) }, value: camp.resourceName } : null;
                })
                .filter(Boolean);

            blocks.push({
                type: "input",
                block_id: id,
                optional: true,
                label: { type: "plain_text", text: `"${kw.text}" (${kw.match.toLowerCase()})`.substring(0, 2000) },
                element: {
                    type: "multi_static_select",
                    action_id: "campaigns_for_kw",
                    placeholder: { type: "plain_text", text: "Don't add" },
                    options: campaignOptions,
                    ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
                },
            });
        }

        if (negTruncated) {
            blocks.push({
                type: "section",
                block_id: "neg_truncated",
                text: { type: "mrkdwn", text: `_Showing ${MAX_NEGS} of ${negEntries.length} negative keywords. Use "Add All" to include everything._` },
            });
        }
    }

    // ── Positive keywords (checkboxes — per ad group) ─────────────────────────
    if (posEntries.length > 0) {
        blocks.push({
            type: "section",
            block_id: "pos_header",
            text: { type: "mrkdwn", text: "*Positive Keywords*\nCheck the ones you want to add to their suggested ad groups." },
        });

        const posChunks = [];
        for (let i = 0; i < posEntries.length; i += 10) posChunks.push(posEntries.slice(i, i + 10));
        const maxPosChunks = Math.min(posChunks.length, 8);

        posChunks.slice(0, maxPosChunks).forEach((chunk, ci) => {
            const options = chunk.map(([id, kw]) => ({
                text: { type: "mrkdwn", text: `\`${kw.text}\` (${kw.match.toLowerCase()}) → ${kw.campaignName} > ${kw.adGroupName}`.substring(0, 2000) },
                value: id,
            }));
            blocks.push({
                type: "input",
                block_id: `pos_chunk_${ci}`,
                optional: true,
                label: { type: "plain_text", text: ci === 0 ? "Select keywords to add" : "​" },
                element: {
                    type: "checkboxes",
                    action_id: `pos_select_${ci}`,
                    options,
                },
            });
        });
    }

    return blocks;
}

slack.action("review_keywords", async ({ action, ack, body, client }) => {
    await ack();
    const threadTs = action.value;
    const pending = getPendingAction(threadTs);
    if (!pending) {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: "modal",
                title: { type: "plain_text", text: "Expired" },
                close: { type: "plain_text", text: "OK" },
                blocks: [{ type: "section", block_id: "expired", text: { type: "mrkdwn", text: "This action has expired. Run the analysis again." } }],
            },
        });
        return;
    }
    const enabledCampaigns = pending.campaigns || await listCampaigns(pending.accountId);
    const blocks = buildKeywordReviewModal(pending.accountName, pending.keywordIndex, enabledCampaigns);
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: "modal",
            callback_id: "keyword_review_modal",
            private_metadata: JSON.stringify({ threadTs, channelId: body.channel.id }),
            title: { type: "plain_text", text: pending.accountName.substring(0, 24) },
            submit: { type: "plain_text", text: "Add Selected" },
            close: { type: "plain_text", text: "Cancel" },
            blocks,
        },
    });
});

slack.action("add_all_keywords", async ({ action, ack, body, client }) => {
    await ack();
    const threadTs = action.value;
    const pending = getPendingAction(threadTs);
    if (!pending) return;
    clearPendingAction(threadTs);
    const say = async (msg) => client.chat.postMessage({ channel: body.channel.id, thread_ts: threadTs, ...msg });
    await executePendingAction(pending, say, threadTs);
});

slack.view("keyword_review_modal", async ({ ack, view, client }) => {
    await ack();
    const { threadTs, channelId } = JSON.parse(view.private_metadata);
    const pending = getPendingAction(threadTs);
    if (!pending) return;

    const kwIndex = pending.keywordIndex;
    const enabledCampaigns = pending.campaigns || await listCampaigns(pending.accountId);

    const negCampaignMap = {};
    const adGroupMap = {};

    const addToNegMap = (campaignName, kw) => {
        if (!negCampaignMap[campaignName]) negCampaignMap[campaignName] = [];
        // avoid duplicates if the same keyword was added to the same campaign multiple times
        if (!negCampaignMap[campaignName].some(k => k.text === kw.text && k.match === kw.match)) {
            negCampaignMap[campaignName].push({ text: kw.text, match: kw.match });
        }
    };

    for (const [blockId, blockVals] of Object.entries(view.state.values)) {
        const kw = kwIndex[blockId];

        if (kw && kw.type === "negative") {
            // Each negative keyword block has a multi_static_select (action_id: campaigns_for_kw)
            const selectedOpts = blockVals.campaigns_for_kw?.selected_options || [];
            if (selectedOpts.length === 0) continue; // blank = Don't add

            for (const opt of selectedOpts) {
                if (opt.value === "all_campaigns") {
                    for (const c of enabledCampaigns) addToNegMap(c.name, kw);
                } else {
                    const camp = enabledCampaigns.find(c => c.resourceName === opt.value);
                    if (camp) addToNegMap(camp.name, kw);
                }
            }
        } else if (blockId.startsWith("pos_chunk_")) {
            // Positive keyword blocks use checkboxes
            for (const el of Object.values(blockVals)) {
                for (const opt of (el.selected_options || [])) {
                    const pkw = kwIndex[opt.value];
                    if (pkw && pkw.type === "positive") {
                        const key = `${pkw.campaignName}||${pkw.adGroupName}`;
                        if (!adGroupMap[key]) adGroupMap[key] = { campaignName: pkw.campaignName, adGroupName: pkw.adGroupName, keywords: [] };
                        adGroupMap[key].keywords.push({ text: pkw.text, match: pkw.match });
                    }
                }
            }
        }
    }

    const filteredCampaigns = Object.entries(negCampaignMap).map(([name, keywords]) => ({ name, keywords }));
    const filteredAdGroups = Object.values(adGroupMap);

    let filteredAction;
    if (filteredCampaigns.length > 0 && filteredAdGroups.length > 0) {
        filteredAction = { type: "add_negatives_and_keywords", campaigns: filteredCampaigns, adGroups: filteredAdGroups };
    } else if (filteredCampaigns.length > 0) {
        filteredAction = { type: "add_negatives", campaigns: filteredCampaigns };
    } else if (filteredAdGroups.length > 0) {
        filteredAction = { type: "add_keywords", adGroups: filteredAdGroups };
    } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "no keywords selected — nothing was added" });
        clearPendingAction(threadTs);
        return;
    }

    const filteredPending = { ...pending, action: filteredAction };
    clearPendingAction(threadTs);
    const say = async (msg) => client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msg });
    await executePendingAction(filteredPending, say, threadTs);
});

// ── Start ─────────────────────────────────────────────────────
(async () => {
    try {
        console.log("Starting Ema v3...");
        console.log("");

        // Log accounts from MCC + env var
        const unique = await getAllAccounts();
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
        console.log("\n📢 Google Ads API: " + (gadsClient ? "✅ connected (MCC: " + (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "NOT SET") + ")" : "❌ not initialised — check GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CLIENT_ID"));
        console.log("");

        await slack.start();
        console.log("Ema v3 is live! Listening for mentions and DMs...");
    } catch (err) {
        console.error("Failed to start Ema:", err);
        process.exit(1);
    }
})();
