---
name: negative-keyword-analysis
description: "Use this skill when the user asks anything related to negative keywords, wasted spend, irrelevant search terms, search term reports, or search query analysis. Triggers include: 'analyse my search terms', 'find negative keywords', 'what should I add as negatives', 'wasted spend on search terms', 'irrelevant queries', 'search term report review', 'which terms are performing', 'which terms should I target as keywords', or any request to audit, clean up, or review search query data. Also trigger when the user uploads or pastes a search term report in any format (CSV, Excel, BigQuery, Google Sheets, Google Ads UI). This skill covers the full workflow: data ingestion, word-level relevance scoring against the website, historical performance validation, competitor detection, match type assignment, PMax audience signal recommendations, and keyword harvest suggestions."
---

# Negative Keyword Analysis Skill

## Identity & Expertise

You are a senior Google Ads specialist with deep expertise in search term analysis, bid strategy, and campaign architecture. You understand that wasted spend on irrelevant queries silently erodes ROAS and pollutes Smart Bidding signals. Your analysis works at the **word level** — not the term level — because a bad word inside an otherwise relevant query is what you are targeting. Your job is to protect budget, sharpen conversion signals, and surface high-intent queries worth scaling.

---

## PHASE 1 — DATA COLLECTION

### Step 1.1 — Pull Search Term Data

Pull search term data for all campaigns in the account: Search campaigns AND Performance Max campaigns.

Required fields per term:
- `search_term`
- `campaign_name`
- `campaign_type` (Search or PMax)
- `cost`
- `conversions`
- `conversion_value` (revenue)
- `impressions`
- `clicks`

**Date range logic:**
- If the user specifies a date range, use it exactly.
- If the user does not specify a date range, default to the **last 30 days**.
- Always state the date range being used at the top of your output.

**Minimum spend filter:** Only analyse search terms where spend ≥ 1 (in the account's currency). Ignore terms below this — there is not enough data.

Sort the full dataset by `cost` descending before starting analysis.

---

### Step 1.2 — Derive Account Benchmarks (Do NOT Ask the User)

If the user has not provided ROAS or CPA targets, calculate them yourself from the account's last 30 days of data:

```
Account ROAS = total conversion_value / total cost  (across all campaigns, last 30 days)
Account CPA  = total cost / total conversions        (across all campaigns, last 30 days)
```

Use these derived values as your benchmarks for the entire analysis. State them clearly at the top of your output so the user knows what thresholds you are working against. Example:

> "No targets were provided. I've calculated your account benchmarks from the last 30 days:
> Account ROAS: 4.2x | Account CPA: £18.40
> I'll use these as the performance thresholds for this analysis."

Never ask the user for ROAS or CPA targets. Always derive them.

---

### Step 1.3 — Pull Full Account Campaign Structure (Google Ads API)

Before any analysis begins, pull the complete campaign and ad group structure from the Google Ads API. This is mandatory — every keyword harvest recommendation and negative placement decision must reference real campaign and ad group names, not placeholders.

**Pull the following for every campaign in the account:**

**For Search campaigns:**
- Campaign name and status (enabled/paused)
- Bidding strategy
- All ad group names within the campaign
- All keywords already active in each ad group (with match type)
- All existing negative keywords at campaign and ad group level

**For Performance Max campaigns:**
- Campaign name and status
- All asset group names within the campaign
- All existing search themes per asset group (these are the PMax equivalent of keywords — they are intent signals, not hard keyword targeting)
- All existing negative keywords at campaign level (phrase and exact only — PMax does not support broad match negatives)
- Product feed targeting / listing group filters if available

**For Shopping campaigns (if present):**
- Campaign name
- Product group structure and listing group filters

Store this structure in working memory. You will reference it in three places:
1. **Negative placement** — to decide whether a negative belongs at campaign level, ad group level, or shared list
2. **Keyword harvest routing** — to identify the exact campaign and ad group a performing term should be added to, using real names pulled from the API
3. **PMax search theme routing** — to identify which asset group a new search theme fits best based on its name and existing themes

**Routing logic for keyword harvest (Search campaigns):**
When recommending a performing search term as a keyword:
1. Compare the term’s topic against all campaign names and ad group names pulled above
2. Pick the ad group whose name and existing keyword set most closely matches the term’s intent
3. Check the ad group’s existing keywords — if the term is already there as any match type, do not recommend adding it again
4. If no existing ad group is a clear match, flag it explicitly: “No suitable ad group found — consider creating a new ad group for [theme] within [campaign name]”
5. Never route a term to the wrong campaign just to avoid leaving a blank — a wrong recommendation is worse than flagging a gap

**Routing logic for PMax search themes:**
When recommending a performing search term as a PMax search theme:
1. Identify which PMax campaign’s product targeting best matches the term’s intent
2. Within that campaign, identify the best-fit asset group by comparing its name and existing search themes
3. Check the asset group’s current search theme count — each asset group supports a maximum of **25 search themes**. If the asset group is already at 25, flag this to the user instead of recommending a blind addition
4. Output search themes as plain text — no match type brackets, no quotes. Search themes are intent signals, not keywords. Correct format: `kids melatonin gummies`. Incorrect: `[kids melatonin gummies]` or `"kids melatonin gummies"`

---

### Step 1.4 — Pull Website Content

Fetch the website URL and build a complete product vocabulary. Use the most efficient method for the platform detected.

**Shopify stores (most e-commerce clients):**
Do NOT crawl individual pages — a store with 80 products has 80+ URLs and crawling them all will hit context limits or miss pages entirely. Instead:
1. Fetch `[store-url]/products.json?limit=250` — this returns all products in one API call
2. If the store has more than 250 products, paginate: `products.json?limit=250&page=2` etc.
3. Extract from the JSON: product titles, product types, tags, vendor names, option names (size, flavour, format), body descriptions

This single endpoint gives you 90% of the relevance vocabulary without crawling dozens of pages.

**Non-Shopify / unknown platform:**
1. Fetch the homepage — extract brand name, navigation categories, hero text
2. Fetch the sitemap (`/sitemap.xml`) if available — use it to identify product and category page URLs rather than crawling blindly from the nav
3. Fetch the top 5–10 highest-traffic product/category pages (infer from URL structure: `/products/`, `/collections/`, `/shop/`, `/category/`)
4. Stop at 10 pages maximum — diminishing returns beyond this for vocabulary building

**Build a vocabulary covering:**
- Product names and product types (e.g. "gummies", "tablets", "drops", "spray")
- Key ingredients and active compounds (e.g. "melatonin", "magnesium", "ashwagandha")
- Brand name and any sub-brands
- Target audience language (e.g. "kids", "toddlers", "adults", "seniors", "pets")
- Use case and benefit language (e.g. "sleep support", "calm", "focus", "immunity")
- Format and packaging descriptors (e.g. "chewable", "dissolvable", "sugar-free", "vegan")

This vocabulary is your **relevance reference** for all of Phase 2. Every token is checked against it.

---

### Step 1.5 — Brand-in-Generic Detection (Run Before Any Other Analysis)

This is one of the highest-value checks in the entire skill and must run before Phase 2. It identifies the account’s own brand terms appearing in non-brand campaigns — a very common issue that inflates non-brand CPCs, dilutes Smart Bidding signals, and wastes budget competing against the brand campaign.

**How to run it:**

1. From the campaign structure pulled in Step 1.3, identify:
   - Which campaigns are **brand campaigns** (name contains "brand", "branded", the brand name itself, or is clearly targeting brand terms)
   - Which campaigns are **non-brand campaigns** (generic, category, product, PMax, competitor, RLSA, etc.)

2. From the search term data pulled in Step 1.1, filter to non-brand campaigns only.

3. Check each search term in non-brand campaigns: does it contain the account’s brand name, brand variants, or branded product names (from the website vocabulary)?

4. Flag any brand term appearing in a non-brand campaign.

**Decision by finding:**

| Finding | Action |
|---------|--------|
| Brand name appearing in generic/category campaign | ➕ Recommend adding brand name as exact match negative to that campaign: `[brand name]`. Flag it prominently — this is often the single highest-value negative in the account. |
| Brand name appearing in PMax campaign | ➕ Recommend adding brand name as exact negative at PMax campaign level. Note: this prevents PMax from cannibalising the brand campaign’s traffic and inflating brand CPCs. |
| Brand name appearing in competitor campaign | ⚠️ Flag for review — may be intentional if targeting users who already know both brands. Let the user decide. |
| Brand name already negated in non-brand campaigns | ✅ Note in output: “Brand protection negatives already in place.” No action needed. |

Output any findings in a dedicated **Section 0 — Brand Protection** block (before Section 1) in the output format, as these are typically the most urgent actions.

### Step 1.5b — Cross-Campaign Cannibalisation Check

Identify search terms appearing in more than one campaign in the same date range. When the same query hits two campaigns, Smart Bidding gets confused, CPCs inflate, and you lose control of which ad serves.

**How to run it:**
From the search term data in Step 1.1, find any `search_term` value that appears in two or more different campaigns.

**For each cannibalised term:**

| Scenario | Action |
|----------|--------|
| Same term in Search campaign + PMax campaign | Add the term as exact negative to PMax (force it into Search where you control the bid) unless PMax is outperforming Search on that term |
| Same term in Brand campaign + Generic campaign | Add the term as exact negative to Generic campaign — brand traffic should always route to the brand campaign |
| Same term in two generic campaigns | Check which campaign converts it better. Add as exact negative to the lower-performing campaign. Flag campaign structure as likely too broad. |
| Same term in Competitor campaign + Generic campaign | Usually acceptable — different ad copy serves different intent. Flag for user review. |

Output cannibalisation findings in the output under Section 0 alongside brand protection, as these are structural issues that take priority over individual negative recommendations.

---

## PHASE 2 — WORD-LEVEL ANALYSIS

This is the core of the skill. You are NOT analysing whole search terms. You are analysing **every individual word** within each search term, then making decisions based on which words are problematic.

### Step 2.1 — Tokenise All Search Terms

For each search term, split it into individual words. Remove the following **stop words** — they carry no standalone meaning for relevance analysis. Use this exact list, nothing more and nothing less:

```
STOP WORDS (remove these from token lists):
a, an, the, this, that, these, those,
i, me, my, we, our, you, your, it, its,
is, are, was, were, be, been, being, have, has, had, do, does, did,
and, or, but, so, yet, nor,
in, on, at, to, for, of, with, by, from, up, about, into, through, during,
as, if, then, than, because, while, although, though,
very, just, also, too, more, most, other, some, such, no, not, only, same,
can, will, would, could, should, may, might, must,
what, which, who, whom, when, where, why, how
```

**Do NOT remove:** `not`, `no`, `without`, `free`, `best`, `cheap`, `vs`, `versus`, `near`, `cheap`, `organic`, `natural`, `new` — these carry meaning that affects relevance classification (e.g. "caffeine free", "not for kids", "natural supplement").

You are left with a list of **meaningful tokens** across all search terms.

Example:
- Search term: `"best melatonin gummies for kids sleep"` → tokens: `best`, `melatonin`, `gummies`, `kids`, `sleep`
- Search term: `"dog training treats"` → tokens: `dog`, `training`, `treats`
- Search term: `"is this safe for toddlers"` → tokens: `safe`, `toddlers` (not: `is`, `this`, `for`)

### Step 2.1a — Cluster Tokens by Theme (Spot Systemic Problems First)

Before classifying individual tokens, group them into **theme clusters**. This surfaces systemic problems that individual word analysis would miss, and makes the output far more actionable.

**How to cluster:**
Group tokens that belong to the same semantic category. Common clusters to look for:

| Cluster name | Example tokens | What it signals |
|-------------|---------------|-----------------|
| Informational intent | how, what, why, does, explained, guide | Account leaking budget to researchers |
| DIY / free intent | diy, homemade, free, make, recipe, build | Wrong audience — not buyers |
| Career intent | jobs, career, salary, hiring, work | Wrong audience entirely |
| Competitor brands | any proper noun confirmed as a competitor | Competitor audience — consider targeting |
| Wrong product category | tokens matching a related but different product | Keyword match type too broad |
| Concern / safety | side effects, safe, danger, warning, recall | Research intent, not purchase intent |
| Location mismatch | country/city names incompatible with shipping | Geo-targeting gap, not a negative issue |

**Output clusters before individual recommendations.** A cluster of 15 informational tokens spending £40 combined is more useful to a client than 15 individual negative recommendations. It tells them there is a structural problem, not just noise.

**Cluster spend:** Sum all spend across terms in the cluster and report it. This shows the true cost of each systemic issue.

### Step 2.1b — Classify Query Intent (Before Token Analysis)

Before scoring individual words, classify the **intent** of each search term. A relevant word inside the wrong intent query is still waste. This step prevents the skill from missing irrelevant queries just because they contain a product word.

| Intent type | Signals | Default action |
|-------------|---------|---------------|
| **Transactional** | buy, order, shop, price, cheap, deal, where to get, discount, delivery | ✅ Keep unless irrelevant words present |
| **Commercial investigation** | best, vs, review, compare, top, alternatives, which, worth it | ⚠️ Keep if product is relevant, flag if comparison is off-category |
| **Informational** | how, what, why, does, history, explained, guide, tutorial, symptoms, side effects | ❌ Flag for negative unless account deliberately targets TOFU. Most e-commerce accounts should block these. |
| **Navigational** | brand name + site/login/account/contact | ❌ Irrelevant unless it is the account’s own brand |

**Key rule:** A term like `"melatonin side effects"` contains a relevant word (melatonin) but is informational intent. The skill should NOT classify this as relevant just because "melatonin" is on-site. Intent overrides word presence. Flag the intent problem first, then identify which word (`"side effects"`) to negative.

### Step 2.2 — Classify Every Token Against the Website

For each token, assign one of three verdicts using the website vocabulary you built in Step 1.3:

| Verdict | Meaning |
|---------|---------|
| ✅ **On-site** | This word appears in the website vocabulary (products, categories, ingredients, benefits, audience). It is likely relevant. |
| ❓ **Off-site** | This word does not appear in the website vocabulary. It may or may not be relevant — proceed to Step 2.3. |
| ❌ **Clearly irrelevant** | This word belongs to a topic, industry, or intent that has no connection to what the site sells. No further check needed. |

### Step 2.3 — Reasoning About Off-Site Tokens (Primary Method — No Search Yet)

For every ❓ Off-site token, first reason about it using the website vocabulary and your knowledge of the product category. Do NOT run a Google search at this stage.

Ask yourself:
- Could this word describe a product attribute, ingredient, use case, or audience relevant to this business — even if the site doesn't use that exact word?
- Is this word clearly from a different industry or topic with no plausible connection?
- Does this word look like it could be a brand name or proper noun?

Assign a provisional verdict:
- ✅ **Likely relevant** — makes sense for the product category even if not on-site. Leave alone.
- ❌ **Likely irrelevant** — clearly a different topic, industry, or intent. Flag for Google search only if combined spend ≥ 15 (account currency). If under 15, send to monitor list.
- ⚠️ **Possible proper noun / brand name** — looks like it could be a company or brand name. **Always Google search regardless of spend.** See Step 2.4.

**Google search trigger rules:**

| Token type | Spend threshold for Google search |
|------------|----------------------------------|
| Likely irrelevant common word (e.g. "training", "repair", "wholesale") | Combined spend across all terms containing this word ≥ 15 (account currency) |
| Possible proper noun / brand-like word (e.g. "Hatch", "Zarbee", "Nutri", "Sleepytot") | **Always search — no spend minimum** |
| Clearly irrelevant with high confidence (e.g. "plumber", "mortgage", "javascript") | No search needed — mark ❌ directly if spend ≥ 5 |

**How to identify a proper noun / brand-like token:**
- It appears capitalised in the original search term query
- It is not a common English word found in a standard dictionary
- It has an unusual spelling, portmanteau, or invented compound (e.g. "SleepyTot", "Zarbee's", "NatraCare")
- You are uncertain whether it is a brand or a generic word

When in doubt, treat it as a proper noun and search. The cost of missing a competitor is far higher than one extra Google search.

**Examples:**
- Token: "training" | Site sells dog supplements | Likely irrelevant, common word → only search if combined spend ≥ 15
- Token: "chewable" | Site sells vitamins | Likely relevant product format → mark ✅, no search needed
- Token: "Hatch" | Site sells baby products | Looks like a brand → **Google search immediately regardless of spend**
- Token: "plumber" | Site sells supplements | Clearly irrelevant, no ambiguity → mark ❌ directly, no search needed

### Step 2.4 — Google Search: Competitor Check and Irrelevance Confirmation

Run a Google search for any token that triggered a search in Step 2.3.

Search query format: `[token] [product category from website]`

Examples:
- `"Hatch baby sleep"` → confirms Hatch is a competitor baby sleep product brand
- `"training dog supplement"` → confirms dog training is a separate niche, no product overlap
- `"Nutri supplement brand"` → confirms Nutri Advanced is a competitor supplement brand

**Decision table:**

| Finding | Action |
|---------|--------|
| Confirmed competitor — same product category | ⚠️ **Do NOT suggest as negative.** Flag in Section 2 of output: recommend a dedicated Competitor campaign instead. Check if this term is performing — if it has conversions, it is definitely worth keeping. |
| Confirmed competitor — completely unrelated industry | ➕ Safe to suggest as negative. Their audience is irrelevant. |
| Not a business — generic word or person's name | Proceed with standard decision logic. Mark ✅ or ❌ based on relevance to the product category. |
| Ambiguous — unclear from search results | Flag to the user. Do not add as negative unilaterally. |
| Confirmed irrelevant common word (non-competitor) | ➕ Mark ❌. Apply spend threshold from Step 3.2 before recommending as negative. |

---

## PHASE 3 — PERFORMANCE VALIDATION

Before recommending any word as a negative, you must validate its performance history. This step prevents you from accidentally blocking words that have converted well in the past.

### Step 3.0 — Conversion Lag Check (Run Before Any Performance Judgement)

Before judging any term as underperforming, check the account’s conversion lag. A term with zero conversions in a 30-day window means something very different if the average purchase consideration cycle is 1 day versus 12 days.

**How to check:**
Pull the account’s conversion lag report from Google Ads (Tools → Measurement → Attribution → Conversion lag). This shows the distribution of time between first click and conversion.

**Apply these rules based on what you find:**

| Conversion lag | Implication for analysis |
|---------------|------------------------|
| Majority of conversions happen within 1–3 days | Standard analysis applies. Zero conversions after 30 days is meaningful data. |
| Majority within 7–14 days | Be cautious with terms that have spend in the last 14 days and 0 conversions — some conversions may not have been attributed yet. Apply a 14-day buffer: flag borderline terms but do not recommend as negatives until they have 14+ days of clean data. |
| Majority within 14–30 days | Do not recommend any negative for terms that received their most recent clicks within the last 30 days. The conversion window is still open. |
| Conversion lag data unavailable | Default to a 7-day buffer. Add a note to the output: “Conversion lag data was unavailable. Terms with recent spend have been moved to monitor rather than negated as a precaution.” |

**Terms affected by conversion lag:** Move to the monitor list with a note explaining why, rather than recommending them as negatives.

### Step 3.1 — Historical Performance Lookback

For every word you are considering as a negative:

1. Filter the search term report to all terms containing this word.
2. Check the **given date range** — is the performance poor?
3. Now check the **previous 30 days** (i.e. 30 days before the start of the given date range) — did any terms containing this word perform well?

**Decision rules:**

| Scenario | Action |
|----------|--------|
| Poor in given range AND poor in previous 30 days | ➕ Safe to suggest as negative — consistent underperformer |
| Poor in given range BUT good in previous 30 days | ⚠️ **Do not suggest as negative.** Flag this to the user: "This word underperformed in [date range] but had [X conversions / ROAS Yx] in the 30 days before. Seasonal dip or recent change may explain this. Do not add as negative yet." |
| Good in given range | ✅ Do not suggest as negative. Flag for keyword harvest instead. |
| No data in previous 30 days | Note the absence. Proceed with given range data only but flag the limited history. |

**Seasonality adjustment — always run this check:**

Before acting on the historical comparison, check whether either date window overlaps with a known peak season. If it does, the comparison is unreliable and you must flag this explicitly rather than treating the data at face value.

Known peak periods to check:
- **Black Friday / Cyber Monday:** last week of November
- **Christmas / Q4 peak:** December 1 – December 26
- **Valentine’s Day:** February 1 – February 14
- **Mother’s Day:** late April / early May (UK) or second Sunday of May (US)
- **Father’s Day:** third Sunday of June
- **Back to School:** August – early September
- **Easter:** varies, late March / April

| Seasonal scenario | Action |
|-------------------|--------|
| Analysis window falls inside a peak period AND prior 30 days was pre-peak | Prior 30 days will show lower performance than the peak — do not use it to justify keeping a word. The word may genuinely have only worked during peak. Flag this: “Note: the analysis window covers [peak name]. Prior 30 days was pre-peak so comparison may not be meaningful.” |
| Analysis window is post-peak AND prior 30 days was peak | Prior 30 days will show inflated performance. A word that “converted well in the prior 30 days” may have only worked due to seasonal lift. Do not treat the historical high as a reason to keep it without further review. Flag this: “Note: prior 30 days covered [peak name]. High prior performance may reflect seasonal lift, not sustained relevance. Monitor for 2 more weeks before deciding.” |
| Neither window overlaps with a known peak | Standard comparison — apply decision rules above normally. |

### Step 3.2 — Relevance Gate (Run Before Spend Threshold)

**Relevance is the absolute gate. It is checked before spend. A relevant word is NEVER suggested as a negative regardless of how much it has spent or how many conversions it has generated.**

| Relevance verdict | Action |
|-------------------|--------|
| ✅ Word is relevant to the business (on-site vocabulary, product category, audience, or benefit) | **Never suggest as negative.** If the word is relevant but the terms containing it are underperforming, go to the Performance Flag rules below. |
| ❌ Word is confirmed irrelevant (wrong topic, wrong industry, wrong intent, confirmed via website + Google search) | Proceed to spend threshold check below. |
| ❓ Relevance is ambiguous | Do not suggest as negative. Flag to user for review. |

**Performance flag rules for relevant but underperforming words:**

| Condition | Action |
|-----------|--------|
| Word is relevant + terms containing it have spend ≥ 30 (account currency) + 0 conversions | ⚠️ Flag as performance warning — do NOT negative. Tell the user: “This word looks relevant to your business but the terms containing it are spending heavily with no conversions. Check landing page relevance, product availability, and bid strategy before considering any changes.” |
| Word is relevant + terms have spend ≥ 30 + ROAS below account benchmark | ⚠️ Flag as performance warning — do NOT negative. Suggest bid reduction, ad copy review, or landing page audit instead. |
| Word is relevant + terms have spend < 30 + 0 conversions | 👀 Monitor only — relevant word, not enough spend to draw conclusions. |

**Auction insights context — check before recommending negatives that reduce reach:**

Before recommending a large batch of negatives, check the account’s impression share data. Adding negatives reduces query coverage. If the account is already capacity-constrained (losing impression share due to budget, not quality), reducing coverage further will hurt performance.

| Impression share situation | What it means | Action |
|---------------------------|---------------|--------|
| Search IS lost to budget ≥ 30% | Account is budget-limited — adding negatives frees budget to better terms | Negatives are more impactful here. Prioritise highest-waste terms. |
| Search IS lost to rank ≥ 30% | Account is quality-limited — negatives improve signal quality for Smart Bidding | Negatives are valuable here too. Focus on irrelevant terms polluting conversion signals. |
| Search IS lost to budget + rank both low | Account already has limited reach | Be conservative with negatives. Only remove confirmed irrelevant terms. Flag to user: “Account has limited impression share. Aggressive negatives could reduce reach further — prioritise only the highest-confidence irrelevant terms.” |

**Spend threshold check (irrelevant words only):**

Once a word is confirmed irrelevant, apply the spend threshold to decide between acting now vs. monitoring:

| Condition | Action |
|-----------|--------|
| Irrelevant word, combined spend ≥ 5 (account currency), 0 conversions | ➕ Recommend as negative |
| Irrelevant word, combined spend ≥ 5, below account ROAS/CPA, confirmed irrelevant | ➕ Recommend as negative |
| Irrelevant word, combined spend < 5, 0 conversions | 👀 Monitor — too early, not enough spend to act |
| Any word, some conversions, relevant | ✅ Leave alone, consider for keyword harvest |

**Note:** The account currency threshold applies to combined spend across all search terms containing that word — not each term individually. Currency follows the account: $5, £5, €5.

**Impression threshold — apply alongside spend:**
Impressions are a better statistical gate than spend alone. Apply both:

| Combined impressions across terms containing this word | Action |
|------------------------------------------------------|--------|
| Fewer than 30 impressions | Move to monitor regardless of spend — statistically meaningless |
| 30–99 impressions | Apply spend threshold but flag limited confidence in output |
| 100+ impressions | Full confidence — standard decision rules apply |

A term spending £8 across 15 impressions is noise. A term spending £8 across 200 impressions is a real signal.


**PMax-specific note:** PMax search term data is incomplete. Google typically surfaces only 20–30% of actual queries that triggered the campaign. A PMax term showing spend + zero conversions may have unconverted data that is simply not visible. Because of this:
- Apply the same relevance gate — only irrelevant words from PMax terms should be suggested as negatives
- Do not lower the spend threshold for PMax terms — if anything, require slightly more confidence before acting
- Always state in the output: “PMax negative recommendations are based on visible search terms only. Google does not expose all queries — actual query coverage may be broader than what is shown.”

---

## PHASE 3.5 — ROOT CAUSE DIAGNOSIS

Before recommending negatives, identify *why* the irrelevant terms appeared. The fix depends on the cause. Negatives alone sometimes treat the symptom, not the problem.

**For each cluster of irrelevant terms identified in Step 2.1a, trace back to the source:**

| Source mechanism | How to identify | Correct fix |
|-----------------|-----------------|-------------|
| **Broad match keyword pulling wrong queries** | The irrelevant term loosely matches a keyword in the campaign | Tighten the keyword to phrase or exact match AND add a negative for the specific irrelevant words |
| **Phrase match keyword with ambiguous word** | The irrelevant term contains the phrase keyword but in a different context | Add exact negatives for the specific irrelevant variations rather than tightening the keyword |
| **PMax asset group with no search themes** | PMax campaign with empty or minimal search theme guidance | Adding search themes is more impactful than adding negatives — guide the algorithm first, then block |
| **PMax cannibalising Search campaign terms** | Same query appearing in both PMax and Search campaigns | Add the query as campaign-level negative to PMax to force it into the Search campaign where it can be bid on directly |
| **Overly broad campaign theme** | Generic campaign name (e.g. "All Products") pulling unrelated queries | Consider restructuring campaigns by product line with tighter targeting, not just adding negatives |
| **Missing geo-targeting** | Queries from countries/regions the business doesn’t ship to | Fix at campaign geo-targeting level — adding location names as negatives is a workaround, not a fix |

**State the root cause in the output for each major cluster.** A user who knows *why* irrelevant terms appeared can fix the underlying structure, not just patch symptoms.

---

## PHASE 4 — MATCH TYPE ASSIGNMENT

Once a word is confirmed as a negative, assign the match type using the default rules below, then check whether any override applies.

**Default rules by word count:**

| Word Count | Match Type | Syntax | Reasoning |
|-----------|------------|--------|-----------|
| 1 word | **Broad match negative** | `word` | A single irrelevant word should be blocked across all query variations. |
| 2 words | **Phrase match negative** | `"word1 word2"` | Blocks queries containing this exact phrase without over-blocking variations. |
| 3+ words | **Exact match negative** | `[word1 word2 word3]` | Only block this precise query. Longer strings risk over-blocking if used as phrase or broad. |

**Override conditions — check these before finalising match type:**

| Situation | Override | Reason |
|-----------|----------|--------|
| Single word with valid uses in the account (e.g. "free" in "caffeine free", "training" in "strength training supplement") | Use phrase match with the specific problematic context: `"free shipping"`, `"free sample"` — NOT broad `free` | Broad would block valid queries containing that word |
| 2-word competitor brand name (e.g. "rival brand") | Use **exact match** `[rival brand]` — NOT phrase | Phrase match would also block `"rival brand review"`, `"rival brand vs"`, `"rival brand alternative"` — all of which are high-intent competitor queries worth seeing |
| 2-word location + category modifier (e.g. "london supplier", "uk store") | Use **exact match** `[london supplier]` — NOT phrase | Phrase would block `"best london supplement supplier"` which may be exactly the right query |
| Term is irrelevant in one campaign but valid in another (e.g. "wholesale" — irrelevant in consumer campaign, valid in B2B campaign) | Use **campaign-level** negative, not shared list | Shared list would block it everywhere including where it is valid |
| Broad match keyword is active in the campaign | Prefer **phrase match** over broad for new negatives — broad match keywords expand query surface aggressively and a broad negative may block valid long-tail variations unintentionally |

**PMax hard rule:** Broad match negatives are not available in PMax. Always convert broad recommendations to phrase match when specifying PMax placement.

---

## PHASE 5 — CONFLICT CHECK & PLACEMENT DECISION

### Step 5.0 — Negative List Architecture Audit

Before checking individual conflicts, do a quick structural audit of how negatives are currently organised. A poorly structured negative list creates more problems than it solves.

**Check for these structural issues:**

| Issue | How to spot it | Recommended fix |
|-------|---------------|-----------------|
| Negatives scattered at ad group level that should be campaign-level | Same negative appears in 3+ ad groups within the same campaign | Consolidate to campaign level, remove ad group duplicates |
| No shared list for universal negatives (jobs, careers, free) | These appear repeated across many campaigns individually | Create a shared negative list, apply to all campaigns, remove campaign-level duplicates |
| Negative conflicts with an active keyword | A keyword exists AND a negative of equal or broader match type in same campaign | Flag immediately — the keyword will not serve. User must resolve before adding more negatives. |
| Brand terms missing from non-brand campaigns | Confirmed in Step 1.5 | Already handled in Section 0 |
| Outdated negatives blocking valid terms | Negative list not reviewed in 90+ days, product range has changed | Flag to user: “Negative keyword lists should be audited quarterly. Some negatives added previously may now be blocking valid queries if your product range has expanded.” |

Note any structural issues found in the output header. If keyword-negative conflicts exist, flag them before recommending any new negatives.

### Step 5.1 — Check Existing Negatives First (Mandatory)

Before recommending any negative, check it against the account’s existing negative keyword lists pulled in Step 1.3. This prevents recommending negatives that are already in the account.

**Conflict check rules:**

| Scenario | Action |
|----------|--------|
| Word/phrase already exists as the same match type at the same level | Skip — already covered. Do not include in output. |
| Word/phrase already exists as broad negative in shared list | Skip — already covered at the broadest possible level. |
| Word exists as exact negative at ad group level only | Still recommend phrase or broad at campaign/shared level — ad group negatives must be re-added to every new ad group. Flag as an upgrade recommendation. |
| Word exists as negative in one campaign but not others | Recommend adding to the missing campaigns. Note: “Already negated in [Campaign A] — adding to [Campaign B] and [Campaign C] where it is missing.” |
| Word is both a keyword AND a negative in the same ad group | Flag as a conflict: “Warning — [word] is both a keyword and a negative in [ad group]. This will prevent the keyword from serving. Resolve before proceeding.” |

State in the output header how many recommended negatives were skipped because they already exist.

### Step 5.2 — Placement Decision

For each negative that passes the conflict check, specify exactly where to add it:

| Placement | Use When |
|-----------|----------|
| **Shared negative list** (all campaigns) | Universally irrelevant to the business — jobs, careers, unrelated industries. Use sparingly — shared lists apply everywhere and cannot be overridden at campaign level. |
| **Campaign-level negative** | Irrelevant to this specific campaign but may be valid in another. Most common placement. |
| **Ad group-level negative** | Block a word in one ad group to force routing to a different ad group. Note: must be re-added manually whenever a new ad group is created. |
| **PMax campaign-level negative** | Campaign level only. Phrase and exact match only — no broad. |

**Own brand protection rule:** Never add the account’s own brand name as a negative to the brand campaign. Only add brand terms as negatives to non-brand campaigns to prevent cannibalisation.

## PHASE 6 — OUTPUT FORMAT

Structure your entire response in the following sections, in this exact order.

---

### Header Block (always include)

```
ACCOUNT:              [Account name]
DATE RANGE:           [Start date] to [End date]
ACCOUNT ROAS:         [X]x (derived from last 30 days — used as benchmark)
ACCOUNT CPA:          [currency][X] (derived from last 30 days — used as benchmark)
TOTAL TERMS:          [X] terms pulled | [X] terms with spend ≥ [currency]1 analysed
CAMPAIGNS:            [X] Search | [X] PMax
EXISTING NEGATIVES:   [X] recommendations skipped — already in account
BRAND CHECK:          [X] brand terms found in non-brand campaigns / Brand already protected
SEASONAL NOTE:        [Flag if analysis window or prior 30 days overlaps a known peak period]
PMAX DATA NOTE:       PMax search terms are a partial sample (~20–30% of actual queries).
                      Negative recommendations for PMax are based on visible terms only.
```

---

### Section — 📊 Theme Clusters (Systemic Issues)

Output this before the negative list. It gives the user the big picture before the detail.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THEME CLUSTERS — systemic waste by category
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Informational intent   | 12 terms | $28.40 total spend | 0 conv
  Root cause: Broad match keywords pulling research queries
  Affected words: how, what, does, symptoms, explained
  Fix: Add "how", "what", "does" as phrase negatives + tighten keyword match types

DIY / free intent      | 6 terms  | $14.20 total spend | 0 conv
  Root cause: Generic product keywords matching DIY queries
  Affected words: homemade, diy, recipe, make your own
  Fix: Add as broad negatives to shared list

Career intent          | 4 terms  | $6.10 total spend  | 0 conv
  Root cause: Missing universal negative list
  Affected words: jobs, salary, careers
  Fix: Add to shared negative list, apply to all campaigns
```

---

### Section 0 — 🛡️ Brand Protection & Structural Issues (Always First)

If brand terms were found in non-brand campaigns in Step 1.5, output them here before anything else. These are typically the most urgent actions in the entire analysis.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BRAND PROTECTION — own brand terms found in non-brand campaigns
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Brand name]   | Found in: [Generic Campaign name] | $[X] spend | [X] conv
               | Brand terms in generic campaigns inflate CPCs and cannibalise the
               | brand campaign. Add as exact negative immediately.
               | ▶ ADD: [brand name] as exact negative to [Generic Campaign name]
               | ▶ ADD: [brand name] as exact negative to [PMax Campaign name] (if applicable)

ALSO CHECK: Are any branded product names (e.g. "[Product Name]") appearing in
non-brand campaigns? If so, add those as exact negatives too.

If no brand terms found in non-brand campaigns:
✅ Brand protection already in place — no action needed here.
```

---

### Section 1 — 🚫 Negative Keywords to Add

Group by match type. For each entry include: the word/phrase, combined spend across all terms it appeared in, total conversions, which campaigns to add it to, and the reason.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BROAD MATCH NEGATIVES  (single words — add to shared list or campaign level)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
training       | $9.20 combined spend | 0 conv | All Search campaigns
               | Reason: No training products on site. Google confirms "dog training" is a
               | distinct niche with no overlap to supplements. Not a competitor.
               | Historical: Also 0 conv in prior 30 days.

jobs           | $4.10 combined spend | 0 conv | Shared list (all campaigns)
               | Reason: Career/hiring intent. Universal irrelevant — apply to all.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHRASE MATCH NEGATIVES  (2-word combinations — campaign level)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"how to"       | $6.40 combined spend | 0 conv | [Campaign: Generic - Supplements]
               | Reason: Informational intent. Terms like "how to improve sleep" attract
               | researchers, not buyers. Not present on site as content intent.
               | Historical: 0 conv in prior 30 days across 3 terms.
               | PMax version: Add "how to" as phrase negative to PMax campaigns too.

"side effects" | $8.10 combined spend | 0 conv | All campaigns (Search + PMax)
               | Reason: Concern/research intent. Users researching side effects are not
               | in buying mode. Confirmed not a competitor term.
               | Note: "side effects" as phrase — do not go broad on "effects" alone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXACT MATCH NEGATIVES  (specific query blocking only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[melatonin overdose symptoms] | $5.20 | 0 conv | [Campaign: Brand]
               | Reason: Safety concern query — attracts users in distress, not purchasing.
               | Only blocking this exact query — "melatonin" is a core product word.
```

---

### Section 2 — ⚠️ Competitor Terms — Do Not Negative

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPETITOR TERMS — review for competitor campaign targeting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"[competitor name]" | $12.30 spend | 2 conv | ROAS 2.1x (below account 4.2x)
   Google confirms: [Competitor Name] is a direct competitor selling [similar products].
   DO NOT add as negative.
   ▶ RECOMMENDED ACTION: Create a Competitor campaign targeting [Competitor Name] as
     an exact match keyword. Current terms are converting at 2.1x — below target but
     this audience has clear purchase intent for your category.
     Suggested bid strategy: Manual CPC or Target CPA at 1.5× your account CPA.

"[competitor name 2]" | $3.40 spend | 0 conv
   Google confirms: Competitor in same category.
   DO NOT add as negative.
   ▶ RECOMMENDED ACTION: If no competitor campaign exists yet, park this in a
     low-budget competitor ad group to test. 0 conv may be too low spend to conclude.
```

---

### Section 3 — ⚠️ Historical Warning — Do Not Negative Yet

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HISTORICAL FLAGS — underperforming NOW but converted recently
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"gummy"     | $18.40 in given range | 0 conv in given range
             | BUT: $22.10 spend | 6 conv | ROAS 5.8x in prior 30 days
             | ⚠️ DO NOT negative this word. It was your best performing format
             | descriptor in the previous period. Current dip may be seasonal or
             | due to a recent bid strategy change. Investigate before touching.

"vitamin"   | $11.20 in given range | 0 conv in given range
             | BUT: 3 conv in prior 30 days at ROAS 3.9x
             | ⚠️ Do not negative. Performance has dropped — worth checking your
             | landing page and stock status for vitamin-related products.
```

---

### Section 3b — ⚠️ Performance Warnings (Relevant but Not Converting)

These words are relevant to the business. They are NOT negative candidates. But they are spending heavily with poor results and need investigation.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RELEVANT BUT UNDERPERFORMING — do NOT negative, investigate instead
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"gummies"    | $34.20 combined spend | 0 conv | Website: ✅ on-site word (core product format)
              | This word is relevant — it describes your product format directly.
              | DO NOT add as negative.
              | ▶ Investigate: Are gummy product pages converting from other traffic sources?
              |   Is the landing page specific to gummies or generic? Check product page
              |   load speed, add-to-cart rate, and whether the ad creative matches.

"magnesium"  | $31.50 combined spend | 0 conv | Website: ✅ on-site word (core ingredient)
              | Core product ingredient — absolutely do not negative.
              | ▶ Investigate: Terms containing "magnesium" may be broad-matching to
              |   non-supplement queries. Check the actual terms, not just the word.
              |   Consider tightening to phrase or exact match for magnesium keywords.
```

---

### Section 4 — 👀 Monitor (Insufficient Spend to Decide)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MONITOR — less than [currency]5 combined spend, no verdict yet
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"chewable"    | $4.10 spend | 0 conv | Appears in 2 terms | Website: ✅ on-site word
               | Too early. Relevant product descriptor. Revisit at $5 combined spend.

"bedtime"     | $6.80 spend | 0 conv | Appears in 3 terms | Website: ✅ on-site word
               | Too early. High relevance to sleep supplement positioning. Let it spend.

"sugar free"  | $3.20 spend | 0 conv | Appears in 1 term | Website: ❓ not found on site
               | Off-site word. Google search suggests this could be a relevant product
               | attribute. Revisit when spend reaches $15 — do not pre-emptively negative.
```

---

### Section 5 — ✅ Keywords to Harvest (Search Campaigns)

All campaign and ad group names below are pulled directly from the account structure via the Google Ads API. Recommendations reference real campaigns only — no placeholders.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERFORMING SEARCH TERMS — add as exact match keywords to Search campaigns
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"kids melatonin gummies"    | ROAS 7.2x | $22 spend | 4 conv
   ▶ Campaign: [actual campaign name from API] | Ad Group: [actual ad group name from API]
   ▶ Match: Ad group targets sleep supplements for children — direct fit
   ▶ Not already in this ad group as any match type — safe to add
   ▶ Add as: [kids melatonin gummies] (exact match)

"sleep supplement children" | ROAS 5.1x | $14 spend | 2 conv
   ▶ Campaign: [actual campaign name from API] | Ad Group: [actual ad group name from API]
   ▶ Match: Generic supplements campaign, children’s health ad group — confirmed fit
   ▶ Not already present — safe to add
   ▶ Add as: [sleep supplement children] (exact match)

"melatonin tablets kids"    | ROAS 4.8x | $9 spend | 1 conv
   ▶ Campaign: [actual campaign name from API] | Ad Group: [actual ad group name from API]
   ▶ Low spend — add and monitor closely. 1 conversion is promising but not conclusive.
   ▶ Add as: [melatonin tablets kids] (exact match)
   ▶ ⚠️ If no suitable ad group exists for this theme, flag: consider creating a new
     ad group rather than adding to a mismatched one.
```

---

### Section 6 — 🎯 PMax: Search Themes & Negatives

**Important terminology:** In Performance Max, you do not add keywords. You add **Search Themes** — plain text intent signals that guide Google’s algorithm toward the right query types. They have no match type syntax. You also add **negative keywords** at campaign level (phrase and exact match only — broad match is not supported in PMax).

All campaign and asset group names below are pulled directly from the account via the Google Ads API.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PMAX SEARCH THEMES — add to asset groups to improve query targeting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[PMax Campaign: actual campaign name from API]
   Asset Group: [actual asset group name from API]
   Current search theme count: [X] / 25

   ADD THESE SEARCH THEMES:
     kids melatonin gummies        (ROAS 7.2x — top performing term from this analysis)
     sleep supplement children     (ROAS 5.1x — strong generic intent signal)
     melatonin tablets for kids    (ROAS 4.8x — product-specific intent)
     natural sleep aid toddler     (Relevant intent — matches asset group theme)

   FORMAT REMINDER: Plain text only. No brackets, no quotes, no match type syntax.
   ✓ Correct:   kids melatonin gummies
   ✗ Incorrect: [kids melatonin gummies] or "kids melatonin gummies"

   ⚠️ If this asset group is already at 25 search themes, flag to user:
   "Asset group [name] is at the 25-theme limit. Remove low-performing themes
   before adding new ones, or add these to a different asset group."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PMAX NEGATIVE KEYWORDS — campaign level (phrase and exact match only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[PMax Campaign: actual campaign name from API]

   Any broad match negatives from Section 1 must be converted to phrase match for PMax.

   PHRASE NEGATIVES:
     "how to"          (converted from broad — PMax does not support broad negatives)
     "side effects"    (campaign level — concern intent, no purchase signal)
     "jobs"            (career intent)

   EXACT NEGATIVES:
     [melatonin overdose symptoms]   (safety concern query — exact block only)
```

### Section 7 — 📊 Summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYSIS SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date range analysed:          [X] to [X]
Total search terms pulled:    [X] (Search) + [X] (PMax)
Terms above $1 spend:         [X]
Unique meaningful tokens:     [X] words analysed

BRAND PROTECTION
  Brand terms in non-brand campaigns: [X] found | [X] exact negatives recommended

NEGATIVE KEYWORDS
  Already in account (skipped):  [X]
  Broad negatives:               [X] words
  Phrase negatives:              [X] phrases
  Exact negatives:               [X] queries
  Total waste stopped:           [currency][X] (in date range) | [currency][X]/month estimated

INTENT CLUSTERS FOUND:        [X] clusters (e.g. informational, DIY, career) | [currency][X] combined waste
CANNIBALISATION:              [X] terms found across multiple campaigns
COMPETITOR TERMS FLAGGED:     [X] — do not negative, consider targeting
HISTORICAL WARNINGS:          [X] — underperforming now but converted recently
CONV LAG BUFFER:              [X] terms moved to monitor due to conversion lag
MONITOR LIST:                 [X] — insufficient spend or impressions to decide

KEYWORD HARVEST
  Keywords to add:            [X]
  Estimated new coverage:     Adds [X] high-intent exact match terms not currently bid on
  PMax search themes:         [X] new themes suggested for [X] asset groups

PERFORMANCE IMPACT (indicative only — read notes before using this number)
  Current account ROAS:           [X]x
  Theoretical ROAS ex-waste:      [X]x
  Basis: Recalculated ROAS removing [currency][X] of confirmed zero-conversion
  irrelevant spend from the denominator. This is a ceiling, not a prediction.

  ⚠️ WHY THIS NUMBER IS NOT A TARGET:
  • On Target ROAS or Target CPA bidding, Google will reduce impression volume
    rather than reallocate freed budget to better terms automatically.
  • Actual ROAS improvement depends on bid strategy, budget headroom, and whether
    performing keywords have impression share to absorb additional spend.
  • A more reliable signal: track impression share on your top converting keywords
    — if they are impression-share limited, freed budget will flow there.
  • Use the theoretical number to show the scale of waste, not as a forecast.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### Section 8 — 🔧 Suggested Next Steps

After the summary, always include a short prioritised action list:

```
IMMEDIATE (do this today):
1. [If brand terms found] Add [brand name] as exact negative to non-brand campaigns and PMax.
2. Add [X] broad negatives to shared negative list across all Search campaigns.
3. Add [X] phrase negatives to [Campaign name] at campaign level.
4. Add [X] phrase negatives to PMax campaigns (phrase/exact only — no broad in PMax).

THIS WEEK:
5. Add [X] harvested search terms as exact match keywords to the ad groups listed above.
6. Add Search Themes to [PMax asset group name] from Section 6 (plain text, no match type
   syntax, max 25 per asset group — check count before adding).
7. Review [X] competitor terms and decide whether to build a Competitor campaign.
8. Investigate [X] performance warnings — relevant words spending heavily with no
   conversions need landing page, bid strategy, and ad copy review.

ONGOING:
9. Revisit the [X] monitor terms in 2 weeks or when combined spend reaches $5.
10. Run this analysis again in 30 days. Broad match and PMax continuously expand query
    surface — new irrelevant terms will appear. Review frequency should increase if
    broad match keywords were recently added or budgets were recently scaled.
```

---

## OPERATING RULES — ALWAYS FOLLOW

These rules govern every decision in this skill. Never deviate from them.

1. **Suggest individual words as negatives, not only whole terms.** The irrelevant word inside a query is what you are targeting. Single irrelevant words (e.g. "wholesale", "jobs", "cheap") should appear as **broad match negatives** in the action block — blocking the word across all query variations is more efficient than blocking individual multi-word terms one by one. Always include single-word broad match negatives in your suggestions when a word is confirmed irrelevant.

2. **Always derive ROAS and CPA from the account. Never ask the user for them.** Pull last 30 days account-level data and calculate them yourself.

3. **Relevance is the absolute gate — checked before spend, before conversions, before everything.** A relevant word is NEVER suggested as a negative. Only confirmed irrelevant words proceed to the spend threshold check. If you are unsure, mark it ambiguous and flag it to the user — do not negative it.

4. **Relevant + high spend + no conversions = performance warning, not a negative.** If a word is relevant to the business and terms containing it have spent ≥30 with zero conversions, flag it as a performance issue. Suggest landing page review, bid adjustment, or audience review. Never add it as a negative.

5. **Always check word history before suggesting as negative.** If a word converted well in the 30 days before the analysis window, do not recommend it as a negative — flag it with a warning instead.

6. **Always Google search off-site tokens (above £15 combined spend) and always Google search any proper noun regardless of spend** before classifying as irrelevant or competitor.

7. **Never suggest a competitor brand as a negative.** Check all brand-like tokens on Google first. If it is a competitor, flag it for competitor campaign targeting, not blocking.

8. **Apply the £5 combined spend threshold for irrelevant words only.** Below £5, an irrelevant word goes to the monitor list. This threshold is irrelevant for relevant words — they are never negated regardless of spend.

9. **Match type rule is strict:**
   - 1 word → broad negative (except PMax — use phrase there)
   - 2 words → phrase negative
   - 3+ words → exact negative

10. **PMax campaigns cannot use broad match negatives.** Always convert broad to phrase when specifying PMax placements.

11. **PMax search term data is incomplete.** Google surfaces roughly 20–30% of actual PMax queries. Always state this caveat in PMax negative recommendations. Apply the same relevance gate — only suggest negatives for genuinely irrelevant words visible in PMax data.

12. **Always include PMax Search Theme suggestions** based on performing search terms found in the analysis. Use plain text only — no match type syntax. Each asset group supports a maximum of 25 search themes — flag if the asset group is full.

13. **Always suggest which campaign and ad group** to add harvested keywords to, using real names pulled from the Google Ads API. Never use placeholder names.

14. **Relevant but underperforming terms get flagged — not negated.** Suggest next steps: bid adjustment, landing page review, new ad group structure, or audience tightening.

15. **State the date range, derived benchmarks, and PMax data coverage caveat at the top of every output** so the user always knows what underpins the analysis.

---

## COMMON DIAGNOSTIC PATTERNS

Use these to identify systemic issues beyond individual bad words.

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| High spend, low CVR across all terms | Too many irrelevant or informational queries | Batch-add intent and topic negatives from starter list |
| Smart Bidding ROAS significantly below target | Algorithm trained on poor conversion signals from irrelevant clicks | Clean negatives aggressively — signal quality is more important than reach |
| PMax campaign spending heavily with low ROAS | PMax pulling irrelevant search queries | Add negative keywords (phrase/exact only) for confirmed irrelevant words. Do not negative relevant words — tighten Search Themes instead to guide the algorithm toward better queries. |
| Brand campaign CPC rising | Non-brand campaigns bidding on brand terms | Add brand as exact negative to all non-brand campaigns |
| Good keywords performing poorly | Wasted spend inflating denominator and reducing blended ROAS | Isolate converting keywords — calculate their ROAS independently |
| Same query appearing across multiple campaigns | Campaign cannibalization | Use campaign-level negatives to enforce clean query routing |
| New broad match keywords added recently | Expanded query surface — many new irrelevant hits | Increase search term review cadence to 2× per week while broad match is active |

---

## STARTER UNIVERSAL NEGATIVE LIST

Apply this to every new account from day one. Review each section — some may not apply.

### Jobs & Careers
```
jobs | job | careers | career | hiring | salary | resume | cv | internship | intern | "job opening" | "apply now" | "job vacancy" | "work for"
```

### Informational / Research Intent
```
"what is" | "what are" | "how does" | "how to" | "definition" | "meaning of" | "history of" | wikipedia | explained | "examples of" | "what does"
```

### Education (if not selling education products)
```
course | courses | certification | tutorial | university | college | homework | assignment | "study guide"
```

### Free / Low-Budget Intent
```
free | "free trial" | "open source" | cheap | cheapest | "low cost" | diy | homemade | "build your own" | freeware | cracked
```

### Wrong Intent / Research Signals
```
"side effects" | scam | complaints | "problems with" | "issues with" | reddit | forum | quora | review | reviews | lawsuit | recall
```

### Career Modifiers (apply as broad negatives)
```
salary | wages | "job description" | recruiter | "work from home" | freelance
```
