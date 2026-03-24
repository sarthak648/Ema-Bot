require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const path = require('path');

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const BARIMELTS_ACCOUNT = '746-735-8073';
const SKILLS_DIR = path.join(__dirname, 'skills');

const SKILLS = {
  'google-ads-account-audit': ['account audit','audit my google ads','account health','what should i fix','account review','where to start','google ads diagnostic','taking over'],
  'google-ads-ad-copy': ['ad copy','headline','rsa','write ads','improve my ads','des
cat > ~/Desktop/mia-bot/app.js << 'ENDOFFILE'
require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const path = require('path');

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const BARIMELTS_ACCOUNT = '746-735-8073';
const SKILLS_DIR = path.join(__dirname, 'skills');

const SKILLS = {
  'google-ads-account-audit': ['account audit','audit my google ads','account health','what should i fix','account review','where to start','google ads diagnostic','taking over'],
  'google-ads-ad-copy': ['ad copy','headline','rsa','write ads','improve my ads','description copy','cta copy','value proposition'],
  'google-ads-ad-extension-audit': ['extension audit','asset audit','missing extensions','extension coverage','sitelink audit','callout audit'],
  'google-ads-ad-extensions': ['ad extensions','sitelinks','callouts','structured snippets','call extension','lead form','image extension','ad assets'],
  'google-ads-anomaly-detection': ['performance drop','cpa spike','impressions dropped','ctr dropped','conversions disappeared','spend increased','anomaly','diagnose','went wrong','monitoring'],
  'google-ads-attribution': ['attribution','data-driven attribution','last click','assisted conversions','conversion window','multi-touch','which campaign is driving'],
  'google-ads-audiences': ['audience','remarketing','rlsa','customer match','lookalike','in-market','custom intent','retargeting'],
  'google-ads-audit-ecommerce': ['ecommerce audit','shopping audit','roas audit','product feed','pmax','cart abandonment'],
  'google-ads-audit-leadgen': ['lead gen audit','cpl audit','lead generation','b2b audit','lead quality','cost per lead'],
  'google-ads-bidding': ['bidding strategy','smart bidding','target cpa','target roas','maximize conversions','manual cpc','bid adjustment','tcpa','troas'],
  'google-ads-budget-management': ['budget pacing','underspending','overspending','monthly budget','shared budget','budget allocation','limited by budget'],
  'google-ads-conversion-tracking': ['conversion tracking','google tag','gtm','tag manager','enhanced conversions','conversion action','tracking not firing','missing conversions'],
  'google-ads-experiments': ['experiment','a/b test','ad variation','split test','statistical significance','uplift test'],
  'google-ads-keyword-cannibalization': ['cannibalization','campaigns competing','duplicate keywords','keyword overlap','internal competition','campaign conflict'],
  'google-ads-keywords': ['keyword research','keyword strategy','match types','keyword planner','keyword audit','broad match','phrase match','exact match'],
  'google-ads-negative-keywords': ['negative keywords','wasted spend','irrelevant traffic','negative keyword list','reduce wasted','irrelevant queries'],
  'google-ads-quality-score': ['quality score','qs','expected ctr','landing page experience','ad rank','low quality score','cpc too high'],
  'google-ads-scripts': ['script','automate','bulk changes','automation','auto pause','script alert','script report'],
  'google-ads-search-term-mining': ['search term report','search term analysis','search term mining','what are people searching','query analysis'],
  'google-ads-segmentation': ['device performance','mobile vs desktop','geo performance','dayparting','ad schedule','hourly performance','location targeting'],
  'google-ads-utm-generator': ['utm','utm parameters','utm generator','tracking url','auto-tagging','gclid','utm naming'],
};

function routeToSkill(question) {
  const q = question.toLowerCase();
  let bestSkill = 'google-ads-account-audit';
  let bestScore = 0;
  for (const [skillName, triggers] of Object.entries(SKILLS)) {
    const score = triggers.filter(t => q.includes(t)).length;
    if (score > bestScore) { bestScore = score; bestSkill = skillName; }
  }
  return bestSkill;
}

function loadSkill(skillName) {
  const filePath = path.join(SKILLS_DIR, `${skillName}.md`);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

async function fetchWindsorData(question) {
  const q = question.toLowerCase();
  let datePreset = 'last_30d';
  if (q.includes('today') || q.includes('yesterday') || q.includes('last week') || q.includes('7 day')) datePreset = 'last_7d';
  if (q.includes('this month')) datePreset = 'this_monthT';
  if (q.includes('90 day') || q.includes('3 month')) datePreset = 'last_90d';
  const needsCampaigns = ['audit','campaign','performance','drop','spike','anomaly','budget','bidding','roas','cpa','wasted','diagnose'].some(t => q.includes(t));
  const fields = needsCampaigns ? 'date,campaign,spend,roas,clicks,impressions,conversions,ctr,cpc' : 'date,spend,roas,clicks,impressions,conversions';
  try {
    const url = 'https://connectors.windsor.ai/google_ads?' + new URLSearchParams({ api_key: WINDSOR_API_KEY, account_id: BARIMELTS_ACCOUNT, date_preset: datePreset, fields });
    const res = await fetch(url);
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.error('Windsor error:', err.message);
    return [];
  }
}

function formatData(data) {
  if (!data.length) return 'No data available.';
  const totals = data.reduce((acc, r) => ({ spend: acc.spend + (r.spend||0), clicks: acc.clicks + (r.clicks||0), impressions: acc.impressions + (r.impressions||0), conversions: acc.conversions + (r.conversions||0), roasSum: acc.roasSum + (r.roas||0), count: acc.count + 1 }), { spend:0, clicks:0, impressions:0, conversions:0, roasSum:0, count:0 });
  const avgROAS = totals.roasSum / totals.count;
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0;
  const cpc = totals.clicks > 0 ? (totals.spend / totals.clicks) : 0;
  const cpa = totals.conversions > 0 ? (totals.spend / totals.conversions) : 0;
  let out = `ACCOUNT: Barimelts | PERIOD: ${data[0]?.date} to ${data[data.length-1]?.date}\n\nTOTALS:\n- Spend: $${totals.spend.toFixed(2)}\n- Avg ROAS: ${avgROAS.toFixed(1)}x\n- Clicks: ${totals.clicks.toLocaleString()}\n- Impressions: ${totals.impressions.toLocaleString()}\n- Conversions: ${totals.conversions.toFixed(2)}\n- CTR: ${ctr.toFixed(2)}%\n- Avg CPC: $${cpc.toFixed(2)}\n- CPA: $${cpa.toFixed(2)}`;
  if (data[0]?.campaign) {
    const camps = {};
    data.forEach(r => { if (!r.campaign) return; camps[r.campaign] = camps[r.campaign] || {spend:0,roas:0,clicks:0,conversions:0,n:0}; camps[r.campaign].spend += r.spend||0; camps[r.campaign].roas += r.roas||0; camps[r.campaign].clicks += r.clicks||0; camps[r.campaign].conversions += r.conversions||0; camps[r.campaign].n++; });
    out += '\n\nTOP CAMPAIGNS BY SPEND:\n';
    Object.entries(camps).sort((a,b) => b[1].spend - a[1].spend).slice(0,10).forEach(([name,m]) => { out += `- ${name}: $${m.spend.toFixed(2)} | ${(m.roas/m.n).toFixed(1)}x ROAS | ${m.conversions.toFixed(1)} conv\n`; });
  }
  return out;
}

async function askMia(question, skillName, data) {
  const skill = loadSkill(skillName);
  const dataContext = formatData(data);
  const system = `You are Mia, a Google Ads AI specialist and Slack bot for a performance marketing team at Webtopia. You answer questions about the Barimelts Google Ads account using live data and expert frameworks.\n\nEXPERTISE (${skillName}):\n${skill}\n\nLIVE ACCOUNT DATA:\n${dataContext}\n\nRULES:\n- Always reference actual numbers from the live data\n- Be specific and actionable\n- Flag anything concerning clearly\n- Keep responses concise and well formatted for Slack\n- Use *bold* for key points and bullet points for lists\n- Max 600 words unless a full audit is requested`;
  const res = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system, messages: [{ role: 'user', content: question }] });
  return res.content[0].text;
}

slack.event('app_mention', async ({ event, say }) => {
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) {
    await say({ text: `Hi! I'm *Mia* 👋 — your Google Ads AI for Barimelts.\n\nAsk me anything:\n• *@Mia audit the account — what are the top 3 issues?*\n• *@Mia why did our CPA spike this week?*\n• *@Mia which campaigns are wasting budget?*\n• *@Mia suggest negative keywords from last month*\n• *@Mia how is ROAS trending this month?*`, thread_ts: event.ts });
    return;
  }
  await say({ text: '⏳ On it — pulling live Barimelts data and analysing...', thread_ts: event.ts });
  try {
    const skillName = routeToSkill(question);
    const data = await fetchWindsorData(question);
    const answer = await askMia(question, skillName, data);
    await say({ text: `${answer}\n\n_🔧 Skill: \`${skillName}\` | 📊 Data: Windsor.ai → Barimelts_`, thread_ts: event.ts });
  } catch (err) {
    console.error('Mia error:', err);
    await say({ text: `❌ Something went wrong: ${err.message}`, thread_ts: event.ts });
  }
});

(async () => {
  await slack.start();
  console.log('✅ Mia is live! Listening for @Mia mentions in Slack...');
})();
