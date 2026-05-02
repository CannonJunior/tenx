#!/usr/bin/env node
/**
 * fetch-transcripts.js  --  SEC EDGAR downloader for NLP model inputs
 *
 * These 10 large-cap semiconductor companies do NOT file earnings call
 * transcripts directly with the SEC (they go to Bloomberg/FactSet instead).
 * We therefore pull two richer, always-available sources:
 *
 *   1. EARNINGS PRESS RELEASES  (source_type = 'press_release')
 *      8-K Exhibit 99.1 filed on earnings date -- management quote, revenue,
 *      margin commentary, forward guidance.  ~1,000-5,000 words per quarter.
 *
 *   2. 10-Q MD&A SECTIONS  (source_type = '10q_mda')
 *      "Management's Discussion and Analysis" extracted from the quarterly
 *      10-Q filing.  Longer, regulatory-scrutinised narrative -- strategic
 *      direction, segment discussion, risk language.  ~5,000-15,000 words.
 *
 * Together these give 8 NLP data points per stock per year (~40 over 5 years)
 * across all 10 stocks without any API key or payment.
 *
 * SEC fair-access rules: User-Agent with contact info, ≤10 req/sec.
 * We use a 250 ms gap (~4 req/sec) throughout.
 *
 * NLP features extracted (no external dependencies):
 *   sentiment_score   -- Loughran-McDonald positive/negative word ratio
 *   ai_dc_mentions    -- AI/data-center keyword count (NVDA, AMD, AVGO leading)
 *   demand_pos/neg    -- positive/negative demand language
 *   pricing_pos/neg   -- pricing power vs pricing pressure
 *   memory_mentions   -- DRAM/HBM/NAND terms (MU signal)
 *   equip_mentions    -- WFE/backlog/utilisation terms (AMAT/LRCX/KLAC signal)
 *   guidance_up/down  -- guidance raised vs lowered language
 */

'use strict';

const https = require('https');
require('dotenv').config();
const db = require('./database');

const USER_AGENT = 'TenX-Stock-Analyzer/1.0 (research; contact: chris.cannon@gmail.com)';

const STOCKS = [
    { symbol: 'MU',   name: 'Micron Technology',       cik: '723125'  },
    { symbol: 'KLAC', name: 'KLA Corporation',          cik: '319201'  },
    { symbol: 'AMD',  name: 'Advanced Micro Devices',   cik: '2488'    },
    { symbol: 'AVGO', name: 'Broadcom',                 cik: '1730168' },
    { symbol: 'NVDA', name: 'Nvidia',                   cik: '1045810' },
    { symbol: 'LRCX', name: 'Lam Research',             cik: '707549'  },
    { symbol: 'AMAT', name: 'Applied Materials',        cik: '6951'    },
    { symbol: 'MPWR', name: 'Monolithic Power Systems', cik: '1280452' },
    { symbol: 'ADI',  name: 'Analog Devices',           cik: '6281'    },
    { symbol: 'QCOM', name: 'Qualcomm',                 cik: '804328'  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function secGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
}

// ── HTML cleaning ─────────────────────────────────────────────────────
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        // iXBRL tags: strip the tag but keep text content
        .replace(/<ix:[^>]+>/gi, '').replace(/<\/ix:[^>]+>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|tr|li|h[1-6]|section|td|th)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
        .replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")
        .replace(/&#8212;/g, '-').replace(/&#8211;/g, '-')
        .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Remove financial-table lines (rows of numbers) ───────────────────
// Lines where more than 60% of tokens are numeric are likely table rows.
function stripFinancialTables(text) {
    return text.split('\n').filter(line => {
        const tokens = line.trim().split(/\s+/).filter(t => t.length > 0);
        if (tokens.length < 3) return true; // keep short lines
        const numCount = tokens.filter(t => /^[\$\(\),.\-\d]+$/.test(t)).length;
        return numCount / tokens.length < 0.6;
    }).join('\n');
}

// ── Section extraction ────────────────────────────────────────────────
// Find the ACTUAL MD&A section (not the TOC entry).
// SEC 10-Q structure: "Item 2. Management's Discussion" marks the actual section.
// TOC entries look like: "Management's Discussion ... 22" (just a page number after).
function extractMDA(text) {
    // Primary: "Item 2" prefix distinguishes real section from TOC
    const itemRe = /Item\s+2\.?\s*\n?\s*(?:Management['']?s?\s+Discussion\s+and\s+Analysis)/i;
    const endRe  = /Item\s+3\b|Quantitative\s+and\s+Qualitative\s+Disclosures|Part\s+II\b(?:\s|$)/i;

    let si = text.search(itemRe);

    // Fallback: find occurrences of the heading that are NOT followed by a lone page number
    if (si < 0) {
        const re = /Management['']?s?\s+Discussion\s+and\s+Analysis/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const after200 = text.slice(m.index + m[0].length, m.index + m[0].length + 150);
            const isTOC = /^\s*\n?\s*\d{1,3}\s*\n/m.test(after200);
            if (!isTOC) { si = m.index; break; }
        }
    }
    if (si < 0) return null;

    const section = text.slice(si);
    const ei = section.slice(400).search(endRe);
    const raw = (ei > 0 ? section.slice(0, ei + 400) : section).trim();

    // Strip number-heavy table lines to get clean prose
    return stripFinancialTables(raw);
}

// Identify a press release (financial results, NOT a transcript or balance sheet)
function isPressRelease(text) {
    const l     = text.toLowerCase();
    const words = (text.match(/\b\w+\b/g) || []).length;
    return (
        words >= 200 && words <= 20000 &&
        (l.includes('revenue') || l.includes('net income') || l.includes('earnings per share')) &&
        (l.includes('million') || l.includes('billion')) &&
        !l.includes('balance sheet') // not primarily a financial statement
    );
}

// ── Quarter / year inference ──────────────────────────────────────────
function inferQuarter(text) {
    const ordinals = { first:1, second:2, third:3, fourth:4, '1st':1,'2nd':2,'3rd':3,'4th':4 };
    const pats = [
        { re:/(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\s+(?:of\s+)?(?:fiscal\s+)?(?:year\s+)?(\d{4})/i,
          fn: m => ({ quarter: ordinals[m[1].toLowerCase()], year: +m[2] }) },
        { re:/Q([1-4])\s+(?:fiscal\s+)?(\d{4})/i,
          fn: m => ({ quarter: +m[1], year: +m[2] }) },
        { re:/fiscal\s+(?:year\s+)?(\d{4})[^0-9]+(?:first|second|third|fourth)\s+quarter/i,
          fn: m => ({ quarter: null, year: +m[1] }) },
        { re:/fiscal\s+(?:year\s+)?(\d{4})/i,
          fn: m => ({ quarter: null, year: +m[1] }) },
    ];
    for (const { re, fn } of pats) {
        const m = text.match(re);
        if (m) return fn(m);
    }
    return { quarter: null, year: null };
}

// ── NLP keyword dictionaries ──────────────────────────────────────────
const POS_STEMS = ['strong','record','growth','exceed','outperform','robust','accelerat',
    'momentum','upside','beat','expand','opportunit','innovat','ahead','confident',
    'favorabl','improv','increas','profit','leader','success','effici','deliver'];
const NEG_STEMS = ['declin','challeng','weak','miss','uncertain','headwind','soften',
    'compress','cautious','slow','deteriorat','difficult','lower','reduc','disappoint',
    'concern','volatil','macroeconomic','geopolit','pressur','restrict','tariff','sanction'];

const KW = {
    ai_dc: ['artificial intelligence','generative ai','gen ai','machine learning','deep learning',
        'large language model','llm','data center','hyperscaler','accelerated computing',
        'inference','training workload','gpu','h100','h200','b100','b200','gb200','gb300',
        'mi300','mi300x','instinct gpu','agentic','reasoning model','sovereign ai',
        'neural network','foundation model','ai accelerator','ai server','ai infrastructure'],
    demand_pos: ['strong demand','robust demand','exceptional demand','record demand','record orders',
        'backlog','supply-constrained','supply constrained','design win','lead time',
        'book-to-bill above','capacity constrained'],
    demand_neg: ['softer demand','weak demand','demand weakness','inventory digestion',
        'inventory correction','channel inventory','oversupply','end market softness','order push'],
    pricing_pos: ['pricing power','asp increase','pricing improvement','favorable pricing',
        'pricing recover','price increas','better pricing','stronger pricing'],
    pricing_neg: ['pricing pressure','asp declin','price competi','pricing headwind',
        'price erosion','pricing declin','lower pricing','weaker pricing'],
    memory: ['dram','nand','hbm','high bandwidth memory','nand flash','lpddr','gddr',
        'bit growth','memory pricing','memory demand','hbm3','hbm3e'],
    equipment: ['wafer fab equipment','wfe','tool order','equipment order','book-to-bill',
        'utilization rate','fab utilization','etch','deposition','inspection',
        'gate-all-around','gaa','advanced node','leading edge','2nm','3nm','angstrom'],
    guidance_up:   ['raise guidance','increase our outlook','raise our outlook','above our guidance',
        'exceed our guidance','ahead of guidance','increase guidance','better than expected'],
    guidance_down: ['lower guidance','reduce our outlook','lower our outlook','below our guidance',
        'softer than expected','revise downward','reduce guidance','below expectations'],
};

function countPhrases(text, phrases) {
    const l = text.toLowerCase();
    let n = 0;
    for (const p of phrases) {
        let pos = 0;
        while ((pos = l.indexOf(p, pos)) !== -1) { n++; pos += p.length; }
    }
    return n;
}
function countStems(words, stems) {
    let n = 0;
    for (const w of words) for (const s of stems) if (w.startsWith(s)) { n++; break; }
    return n;
}

function analyzeText(text, hasQA = false) {
    const words = (text.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
    const pos   = countStems(words, POS_STEMS);
    const neg   = countStems(words, NEG_STEMS);
    const denom = pos + neg;
    return {
        word_count:      words.length,
        has_qa:          hasQA ? 1 : 0,
        prepared_words:  words.length,
        qa_words:        0,
        sentiment_score: denom === 0 ? 0 : parseFloat(((pos - neg) / denom).toFixed(4)),
        ai_dc_mentions:  countPhrases(text, KW.ai_dc),
        demand_pos:      countPhrases(text, KW.demand_pos),
        demand_neg:      countPhrases(text, KW.demand_neg),
        pricing_pos:     countPhrases(text, KW.pricing_pos),
        pricing_neg:     countPhrases(text, KW.pricing_neg),
        memory_mentions: countPhrases(text, KW.memory),
        equip_mentions:  countPhrases(text, KW.equipment),
        guidance_up:     countPhrases(text, KW.guidance_up),
        guidance_down:   countPhrases(text, KW.guidance_down),
        positive_words:  pos,
        negative_words:  neg,
    };
}

// ── EDGAR filing index: return all document URLs in a filing ──────────
async function getFilingDocs(cik, accession) {
    const accClean = accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${accession}-index.htm`;
    await sleep(250);
    const { status, body } = await secGet(url);
    if (status !== 200) return [];

    // Extract document links from the HTML filing index table
    const docs = [];
    const rows = body.split(/<tr/i);
    for (const row of rows.slice(2)) {
        // Extract description, href, type from each table row
        const desc = (row.match(/<td[^>]*>([^<]*)<\/td>/i) || [])[1]?.trim() || '';
        const href = (row.match(/href="([^"]+\.(?:htm|html|txt)[^"]*)"/i) || [])[1] || '';
        const type = (row.match(/<td[^>]*>[^<]*<\/td>[^<]*<td[^>]*>([^<]*)<\/td>[^<]*<td[^>]*>([^<]*)<\/td>/i) || [])[2]?.trim() || '';

        if (!href || href.includes('index.htm')) continue;
        let finalUrl = href.startsWith('/ix?doc=') ? 'https://www.sec.gov' + href.replace('/ix?doc=', '') :
                       href.startsWith('/') ? 'https://www.sec.gov' + href : href;
        docs.push({ desc: desc.toLowerCase(), url: finalUrl, type: type.toLowerCase() });
    }
    return docs;
}

// ── Submissions API ────────────────────────────────────────────────────
async function getSubmissions(cik) {
    const padded = cik.padStart(10, '0');
    await sleep(250);
    const { status, body } = await secGet(`https://data.sec.gov/submissions/CIK${padded}.json`);
    if (status !== 200) throw new Error(`Submissions API: HTTP ${status}`);
    const data = JSON.parse(body);
    const r = data.filings.recent;
    const filings = [];
    for (let i = 0; i < r.accessionNumber.length; i++) {
        filings.push({
            accession:  r.accessionNumber[i],
            filingDate: r.filingDate[i],
            form:       r.form[i],
            items:      r.items?.[i] || '',
            primaryDoc: r.primaryDocument?.[i] || '',
        });
    }
    return { cik, name: data.name, filings };
}

// ── Per-document download + save ──────────────────────────────────────
async function downloadAndSave(symbol, filing, docUrl, sourceType, extraTitle) {
    await sleep(250);
    const { status, body } = await secGet(docUrl);
    if (status !== 200) return false;

    let text = htmlToText(body);

    // For 10-Q/10-K: extract just the MD&A section
    if (sourceType === '10q_mda' || sourceType === '10k_mda') {
        const mda = extractMDA(text);
        if (!mda || mda.split(/\s+/).length < 200) return false;
        text = mda;
    } else if (sourceType === 'press_release') {
        if (!isPressRelease(text)) return false;
    }

    const { quarter, year } = inferQuarter(text + ' ' + filing.filingDate);
    const signals = analyzeText(text);
    const label   = sourceType === 'press_release' ? 'PR' : sourceType === '10q_mda' ? 'MD&A' : 'ANN';
    const title   = `${symbol} ${label} Q${quarter ?? '?'} ${year ?? filing.filingDate.slice(0, 4)} ${extraTitle || ''}`.trim();

    db.saveTranscript(symbol, {
        filed_date:     filing.filingDate,
        fiscal_year:    year,
        fiscal_quarter: quarter,
        title,
        text,
        word_count:     signals.word_count,
        has_qa:         0,
        source_type:    sourceType,
        filing_url:     docUrl,
        accession:      filing.accession,
        signals,
    });
    return true;
}

// ── Per-stock fetch orchestration ─────────────────────────────────────
async function fetchForStock(stock, cutoffDate) {
    const { symbol, cik } = stock;

    let sub;
    try { sub = await getSubmissions(cik); }
    catch (err) { console.error(`  [${symbol}] submissions failed: ${err.message}`); return { symbol, fetched: 0, errors: 1 }; }

    const existing = new Set(
        db.getTranscriptAccessions(symbol).map(a => a) // existing accessions
    );

    let fetched = 0, errors = 0;

    for (const filing of sub.filings) {
        if (filing.filingDate < cutoffDate) continue;

        // ── Earnings press releases: 8-K with item 2.02 ──────────────
        if (filing.form === '8-K' && filing.items.includes('2.02')) {
            const key = filing.accession + '::press_release';
            if (existing.has(key)) continue;

            const docs = await getFilingDocs(cik, filing.accession);

            // Look for exhibit 99.1 or the first suitable exhibit
            const candidates = docs.filter(d =>
                d.url.endsWith('.htm') &&
                !d.url.includes('-index') &&
                (d.type.includes('99') || d.desc.includes('press') || d.desc.includes('99') ||
                 d.url.split('/').pop().includes('pr') || d.url.split('/').pop().includes('99'))
            );
            // Also include the primary document as fallback
            if (filing.primaryDoc) {
                const primaryUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accession.replace(/-/g, '')}/${filing.primaryDoc}`;
                if (!candidates.some(c => c.url === primaryUrl)) {
                    candidates.push({ desc: '', url: primaryUrl, type: '' });
                }
            }

            for (const cand of candidates) {
                const saved = await downloadAndSave(symbol, { ...filing, accession: filing.accession }, cand.url, 'press_release', '');
                if (saved) {
                    console.log(`  ✓ PR   ${filing.filingDate} ${symbol}`);
                    existing.add(key);
                    fetched++;
                    break;
                }
            }
        }

        // ── 10-Q MD&A ─────────────────────────────────────────────────
        if (filing.form === '10-Q') {
            const key = filing.accession + '::10q_mda';
            if (existing.has(key)) continue;

            const docs = await getFilingDocs(cik, filing.accession);

            // Primary document is the 10-Q form itself -- check it first
            const primaryUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accession.replace(/-/g, '')}/${filing.primaryDoc}`;
            const toCheck = [{ url: primaryUrl }, ...docs.filter(d => d.url !== primaryUrl && d.url.endsWith('.htm'))];

            for (const cand of toCheck.slice(0, 3)) {  // check max 3 docs to avoid rate-limit burn
                const saved = await downloadAndSave(symbol, { ...filing, accession: filing.accession }, cand.url, '10q_mda', '');
                if (saved) {
                    console.log(`  ✓ 10-Q ${filing.filingDate} ${symbol}`);
                    existing.add(key);
                    fetched++;
                    break;
                }
            }
        }

        // ── 10-K annual MD&A ──────────────────────────────────────────
        if (filing.form === '10-K') {
            const key = filing.accession + '::10k_mda';
            if (existing.has(key)) continue;

            const primaryUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accession.replace(/-/g, '')}/${filing.primaryDoc}`;
            const saved = await downloadAndSave(symbol, { ...filing, accession: filing.accession }, primaryUrl, '10k_mda', '');
            if (saved) {
                console.log(`  ✓ 10-K ${filing.filingDate} ${symbol}`);
                existing.add(key);
                fetched++;
            }
        }
    }

    return { symbol, fetched, errors };
}

// ── Public API ────────────────────────────────────────────────────────
async function fetchAllTranscripts(symbols = null, cutoffDate = '2021-01-01') {
    const targets = symbols
        ? STOCKS.filter(s => symbols.includes(s.symbol))
        : STOCKS;

    console.log(`[transcripts] SEC EDGAR -- press releases + 10-Q MD&A for ${targets.length} stocks`);
    console.log(`[transcripts] Cutoff: ${cutoffDate}  Rate: ~4 req/sec`);

    const results = {};
    let total = 0;
    for (const stock of targets) {
        console.log(`\n[${stock.symbol}] ${stock.name} (CIK: ${stock.cik})`);
        results[stock.symbol] = await fetchForStock(stock, cutoffDate);
        total += results[stock.symbol].fetched;
    }

    console.log(`\n[transcripts] Done -- ${total} documents stored`);
    for (const [sym, r] of Object.entries(results)) {
        if (r.fetched) console.log(`  ${sym}: ${r.fetched} fetched`);
    }
    return results;
}

module.exports = { fetchAllTranscripts, analyzeText, KW, STOCKS };

if (require.main === module) {
    const cutoff = process.argv[2] || '2021-01-01';
    fetchAllTranscripts(null, cutoff).catch(err => { console.error(err); process.exit(1); });
}
