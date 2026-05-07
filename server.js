#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const db = require('./database');
const { computeAndStore } = require('./compute-models');
const { fetchAllEarnings } = require('./fetch-earnings');
const { fetchAllTranscripts } = require('./fetch-transcripts');
const { backtestStats } = require('./models');
const PORT = process.env.PORT || 9004;

// ── Claude CLI streaming helper ───────────────────────────────────────
// Uses the installed `claude` CLI (Claude Code) with the existing OAuth
// session — no separate ANTHROPIC_API_KEY needed.
const { spawn } = require('child_process');

function streamClaude(systemPrompt, userPrompt, serverRes) {
    return new Promise(resolve => {
        const claudePath = process.env.CLAUDE_PATH || 'claude';

        const proc = spawn(claudePath, [
            '-p', userPrompt,
            '--system-prompt', systemPrompt,
            '--output-format', 'stream-json',
            '--include-partial-messages',
            '--verbose',
            '--model', 'claude-sonnet-4-6',
        ], { env: process.env });

        let buf = '';

        proc.stdout.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop();           // keep incomplete trailing line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    // Incremental text deltas arrive as stream_event → content_block_delta
                    if (evt.type === 'stream_event' &&
                        evt.event?.type === 'content_block_delta' &&
                        evt.event?.delta?.type === 'text_delta') {
                        serverRes.write(`data: ${JSON.stringify({ text: evt.event.delta.text })}\n\n`);
                    }
                } catch { /* skip non-JSON or unknown event types */ }
            }
        });

        proc.stderr.on('data', chunk => {
            console.error('[inference]', chunk.toString().trim());
        });

        proc.on('close', code => {
            if (code !== 0 && code !== null) {
                serverRes.write(`data: ${JSON.stringify({ text: `\n\n*Claude process exited with code ${code}.*` })}\n\n`);
            }
            serverRes.write('data: [DONE]\n\n');
            resolve();
        });

        proc.on('error', err => {
            serverRes.write(`data: ${JSON.stringify({ text: `\n\n**Error spawning claude CLI:** ${err.message}` })}\n\n`);
            serverRes.write('data: [DONE]\n\n');
            resolve();
        });
    });
}

// ── Alpha Vantage news/sentiment fetch ────────────────────────────────
function fetchMediaFromAlphaVantage(symbol, fromDate) {
    const key  = process.env.ALPHA_VANTAGE_API_KEY;
    const from = fromDate ? fromDate.replace(/-/g,'').slice(0,8) + 'T0000' : '';
    const endpoint = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbol}&limit=50${from ? '&time_from='+from : ''}&apikey=${key}`;
    return new Promise((resolve, reject) => {
        https.get(endpoint, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    if (json['Error Message']) return reject(new Error(json['Error Message']));
                    if (json['Note'])          return reject(new Error('Rate limit: ' + json['Note']));
                    if (json['Information'])   return reject(new Error('API limit: ' + json['Information']));
                    const feed = json.feed || [];
                    const articles = feed.map(a => {
                        const ts = a.ticker_sentiment?.find(t => t.ticker === symbol);
                        return {
                            published_at:    a.time_published?.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'),
                            title:           a.title,
                            url:             a.url,
                            source:          a.source,
                            summary:         (a.summary || '').slice(0, 500),
                            sentiment_score: parseFloat(a.overall_sentiment_score) || null,
                            relevance_score: ts ? parseFloat(ts.relevance_score) : null,
                        };
                    });
                    resolve(articles);
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ── Build inference prompt from all available stock data ────────────��
function buildInferencePrompt(symbol) {
    const prices    = db.getPrices(symbol, 24);
    const inds      = db.getIndicators(symbol);
    const signals   = db.getAllSignals ? db.getAllSignals() : [];
    const sigs      = signals.filter(s => s.symbol === symbol).slice(-8);
    const transcSig = db.getTranscriptSignals(symbol);
    const media     = db.getMedia(symbol, 15);
    const allStocks = [...STOCKS];

    const latest    = inds[inds.length - 1] || {};
    const first     = prices[0], last = prices[prices.length - 1];
    const ret24m    = first && last ? (((last.close - first.close) / first.close) * 100).toFixed(1) : '?';
    const latestTS  = transcSig[transcSig.length - 1];

    const signalSummary = sigs.slice(-5).map(s =>
        `  • ${s.date} — ${s.type} (score ${s.score?.toFixed(0)})`).join('\n') || '  (none)';

    const mediaSummary = media.slice(0, 8).map(a =>
        `  • [${a.published_at?.slice(0,10)}] ${a.title} (sentiment: ${a.sentiment_score?.toFixed(2) ?? '?'})`
    ).join('\n') || '  (no media loaded)';

    const edgarSummary = latestTS
        ? `Latest quarter NLP: sentiment ${latestTS.sentiment_score?.toFixed(3)}, ` +
          `AI/DC mentions ${latestTS.ai_dc_mentions}, demand+ ${latestTS.demand_pos}, ` +
          `demand- ${latestTS.demand_neg}, guidance↑ ${latestTS.guidance_up}, guidance↓ ${latestTS.guidance_down}`
        : '  (no EDGAR data loaded)';

    const userPrompt = `Stock under analysis: **${symbol}**
Current price: $${last?.close?.toFixed(2) ?? '?'}  |  24M return: ${ret24m}%
Breakout score: ${latest.score?.toFixed(0) ?? '?'}/100  |  RSI: ${latest.rsi?.toFixed(1) ?? '?'}  |  Peer rank: ${latest.peer_rank != null ? '#'+(10-Math.round(latest.peer_rank*9)) : '?'}

Recent model signals:
${signalSummary}

EDGAR / MD&A NLP signals (${transcSig.length} quarters loaded):
${edgarSummary}

Recent media headlines:
${mediaSummary}

---
Based on the data above, please:
1. Identify the 2-3 most significant business trends or strategic shifts visible in ${symbol}'s price action, signals, management language, and media coverage.
2. For each trend, identify specific publicly-traded companies (whether listed in this app or not) that could be materially impacted — positively or negatively.
3. For each implied relationship, explain the mechanism (supply chain, licensing, competitive displacement, co-investment, etc.) and estimate the directional impact on those companies' stock prices.
4. Flag any second/third-order effects that are non-obvious but potentially significant.

Be specific about company names, ticker symbols where known, and quantitative estimates where possible. Format your response with clear headers.`;

    const systemPrompt = `You are a senior technology equity analyst and supply chain strategist. You specialize in identifying cross-stock implications — how trends at one company ripple through its ecosystem partners, competitors, and adjacent industries. You think in second and third-order effects. Be direct, specific, and actionable.`;

    return { userPrompt, systemPrompt };
}

// Top 10 S&P 500 semiconductor stocks ranked by estimated 1-year growth (Apr 2025–Apr 2026)
const STOCKS = [
    { symbol: 'MU',    name: 'Micron Technology',         subIndustry: 'Semiconductors',                       estYearGrowth: 168 },
    { symbol: 'KLAC',  name: 'KLA Corporation',            subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 112 },
    { symbol: 'HXSCL', name: 'SK Hynix',                   subIndustry: 'Semiconductors',                       estYearGrowth: 80  },
    { symbol: 'AMD',   name: 'Advanced Micro Devices',     subIndustry: 'Semiconductors',                       estYearGrowth: 64  },
    { symbol: 'AVGO',  name: 'Broadcom',                   subIndustry: 'Semiconductors',                       estYearGrowth: 41  },
    { symbol: 'TSM',   name: 'Taiwan Semiconductor',       subIndustry: 'Semiconductors',                       estYearGrowth: 32  },
    { symbol: 'NVDA',  name: 'Nvidia',                     subIndustry: 'Semiconductors',                       estYearGrowth: 27  },
    { symbol: 'LRCX',  name: 'Lam Research',               subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 25  },
    { symbol: 'VRT',   name: 'Vertiv Holdings',            subIndustry: 'Data Center Infra',                    estYearGrowth: 24  },
    { symbol: 'AMAT',  name: 'Applied Materials',          subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 22  },
    { symbol: 'MPWR',  name: 'Monolithic Power Systems',   subIndustry: 'Semiconductors',                       estYearGrowth: 20  },
    { symbol: 'ADI',   name: 'Analog Devices',             subIndustry: 'Semiconductors',                       estYearGrowth: 15  },
    { symbol: 'QCOM',  name: 'Qualcomm',                   subIndustry: 'Semiconductors',                       estYearGrowth: 10  },
    { symbol: 'SNDK',  name: 'Sandisk',                    subIndustry: 'Data Storage',                         estYearGrowth: -11 },
    { symbol: 'WDC',   name: 'Western Digital',            subIndustry: 'Data Storage',                         estYearGrowth: -25 },
    { symbol: 'STX',   name: 'Seagate Technology',         subIndustry: 'Data Storage',                         estYearGrowth: -23 },
    { symbol: 'SMH',   name: 'VanEck Semiconductor ETF',   subIndustry: 'ETF',                                  estYearGrowth: 25,  isEtf: true },
];

// S&P 500 stocks with highest short interest % of float (May 2026), ranked descending
// Sources: Barchart, MarketBeat, Fintel — confirmed S&P 500 members
const SHORTLIST = [
    { symbol: 'CAR',  name: 'Avis Budget Group',           subIndustry: 'Car Rental',           estYearGrowth: -8,  shortPct: 54 },
    { symbol: 'RH',   name: 'RH (Restoration Hardware)',   subIndustry: 'Luxury Furniture',      estYearGrowth: 12,  shortPct: 32 },
    { symbol: 'IONQ', name: 'IonQ Inc',                    subIndustry: 'Quantum Computing',     estYearGrowth: 40,  shortPct: 23 },
    { symbol: 'MRNA', name: 'Moderna',                     subIndustry: 'Biotechnology',         estYearGrowth: -10, shortPct: 20 },
    { symbol: 'CHTR', name: 'Charter Communications',      subIndustry: 'Cable / Broadband',     estYearGrowth: -5,  shortPct: 17 },
    { symbol: 'H',    name: 'Hyatt Hotels',                subIndustry: 'Hotels & Resorts',      estYearGrowth: 12,  shortPct: 16 },
    { symbol: 'CZR',  name: 'Caesars Entertainment',       subIndustry: 'Casinos & Gaming',      estYearGrowth: 8,   shortPct: 16 },
    { symbol: 'NCLH', name: 'Norwegian Cruise Line',       subIndustry: 'Cruise Lines',          estYearGrowth: 15,  shortPct: 15 },
    { symbol: 'RIVN', name: 'Rivian Automotive',           subIndustry: 'Electric Vehicles',     estYearGrowth: 30,  shortPct: 14 },
    { symbol: 'SMCI', name: 'Super Micro Computer',        subIndustry: 'AI Servers',            estYearGrowth: 25,  shortPct: 14 },
    { symbol: 'CCL',  name: 'Carnival Corporation',        subIndustry: 'Cruise Lines',          estYearGrowth: 14,  shortPct: 13 },
    { symbol: 'DKNG', name: 'DraftKings',                  subIndustry: 'Sports Betting',        estYearGrowth: 20,  shortPct: 13 },
    { symbol: 'GPS',  name: 'Gap Inc',                     subIndustry: 'Apparel Retail',        estYearGrowth: -4,  shortPct: 12 },
    { symbol: 'PVH',  name: 'PVH Corp',                    subIndustry: 'Apparel Brands',        estYearGrowth: 6,   shortPct: 12 },
    { symbol: 'MGM',  name: 'MGM Resorts International',   subIndustry: 'Casinos & Gaming',      estYearGrowth: 10,  shortPct: 11 },
    { symbol: 'WBD',  name: 'Warner Bros. Discovery',      subIndustry: 'Streaming / Media',     estYearGrowth: 8,   shortPct: 11 },
    { symbol: 'UAL',  name: 'United Airlines Holdings',    subIndustry: 'Airlines',              estYearGrowth: 14,  shortPct: 10 },
    { symbol: 'NKE',  name: 'Nike Inc',                    subIndustry: 'Athletic Apparel',      estYearGrowth: 11,  shortPct: 9  },
    { symbol: 'LVS',  name: 'Las Vegas Sands',             subIndustry: 'Casinos & Gaming',      estYearGrowth: 14,  shortPct: 8  },
    { symbol: 'BA',   name: 'Boeing',                      subIndustry: 'Aerospace & Defense',   estYearGrowth: 10,  shortPct: 7  },
];

// Top 20 S&P 500 stocks by market cap (May 2026, approximate)
const MARKETCAP = [
    { symbol: 'AAPL', name: 'Apple Inc',           subIndustry: 'Consumer Electronics', estYearGrowth: 12, marketCapT: 3.2 },
    { symbol: 'MSFT', name: 'Microsoft',            subIndustry: 'Cloud / Software',     estYearGrowth: 14, marketCapT: 3.0 },
    { symbol: 'NVDA', name: 'Nvidia',               subIndustry: 'Semiconductors',       estYearGrowth: 27, marketCapT: 2.9 },
    { symbol: 'AMZN', name: 'Amazon',               subIndustry: 'E-Commerce / Cloud',   estYearGrowth: 20, marketCapT: 2.3 },
    { symbol: 'GOOGL',name: 'Alphabet (Google)',     subIndustry: 'Search / Cloud / AI',  estYearGrowth: 16, marketCapT: 2.0 },
    { symbol: 'META', name: 'Meta Platforms',        subIndustry: 'Social Media / AI',    estYearGrowth: 18, marketCapT: 1.6 },
    { symbol: 'AVGO', name: 'Broadcom',             subIndustry: 'Semiconductors',       estYearGrowth: 41, marketCapT: 1.1 },
    { symbol: 'LLY',  name: 'Eli Lilly',            subIndustry: 'Pharmaceuticals',      estYearGrowth: 15, marketCapT: 0.95 },
    { symbol: 'TSLA', name: 'Tesla',                subIndustry: 'Electric Vehicles',    estYearGrowth: 25, marketCapT: 0.82 },
    { symbol: 'WMT',  name: 'Walmart',              subIndustry: 'Retail',               estYearGrowth: 12, marketCapT: 0.75 },
    { symbol: 'JPM',  name: 'JPMorgan Chase',       subIndustry: 'Banking',              estYearGrowth: 10, marketCapT: 0.72 },
    { symbol: 'V',    name: 'Visa',                 subIndustry: 'Payments',             estYearGrowth: 14, marketCapT: 0.62 },
    { symbol: 'MA',   name: 'Mastercard',           subIndustry: 'Payments',             estYearGrowth: 15, marketCapT: 0.52 },
    { symbol: 'COST', name: 'Costco Wholesale',      subIndustry: 'Retail',               estYearGrowth: 12, marketCapT: 0.51 },
    { symbol: 'XOM',  name: 'ExxonMobil',           subIndustry: 'Oil & Gas',            estYearGrowth: 5,  marketCapT: 0.50 },
    { symbol: 'NFLX', name: 'Netflix',              subIndustry: 'Streaming',            estYearGrowth: 18, marketCapT: 0.42 },
    { symbol: 'HD',   name: 'Home Depot',           subIndustry: 'Home Improvement',     estYearGrowth: 8,  marketCapT: 0.40 },
    { symbol: 'ORCL', name: 'Oracle',               subIndustry: 'Cloud / Databases',    estYearGrowth: 20, marketCapT: 0.40 },
    { symbol: 'UNH',  name: 'UnitedHealth Group',   subIndustry: 'Health Insurance',     estYearGrowth: 10, marketCapT: 0.38 },
    { symbol: 'ABBV', name: 'AbbVie',               subIndustry: 'Biopharmaceuticals',   estYearGrowth: 8,  marketCapT: 0.35 },
];

// S&P 500 stocks that ≥100% in past 12 months (May 2025–May 2026), not already in STOCKS
const WATCHLIST = [
    { symbol: 'INTC', name: 'Intel Corporation',     subIndustry: 'Semiconductors',    estYearGrowth: 35, gain12m: 356 },
    { symbol: 'TER',  name: 'Teradyne',              subIndustry: 'Semicond. Test',    estYearGrowth: 28, gain12m: 366 },
    { symbol: 'PLTR', name: 'Palantir Technologies', subIndustry: 'Software / AI',     estYearGrowth: 22, gain12m: 290 },
    { symbol: 'APP',  name: 'AppLovin Corporation',  subIndustry: 'AI Advertising',    estYearGrowth: 18, gain12m: 275 },
];

const MIME = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

const CACHE_CONTROL = {
    'text/html':        'no-cache',
    'text/javascript':  'max-age=3600',
    'text/css':         'max-age=3600',
    'image/svg+xml':    'max-age=3600',
    'image/x-icon':     'max-age=86400',
    'application/json': 'no-store',
};

// Per-symbol cooldown for inference (60 s) — prevents concurrent Claude spawns
const _inferCooldown = new Map();
let _bellRunning = false;
let _closeRunning = false;

// Rate-limited fetch queue: Alpha Vantage free tier = 5 req/min, 25 req/day
const fetchQueue = [];
let queueRunning = false;

async function processQueue() {
    if (queueRunning) return;
    queueRunning = true;
    while (fetchQueue.length > 0) {
        const { symbol, resolve, reject } = fetchQueue.shift();
        try {
            console.log(`[fetch] ${symbol}`);
            const prices = await fetchFromAlphaVantage(symbol);
            db.savePrices(symbol, prices);
            console.log(`[saved] ${symbol}: ${prices.length} records`);
            resolve({ success: true, symbol, count: prices.length });
        } catch (err) {
            console.error(`[error] ${symbol}:`, err.message);
            reject(err);
        }
        if (fetchQueue.length > 0) {
            // 13 s gap keeps us under 5 req/min
            await sleep(13000);
        }
    }
    queueRunning = false;
}

function enqueue(symbol) {
    return new Promise((resolve, reject) => {
        fetchQueue.push({ symbol, resolve, reject });
        processQueue();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function notifyGreen(text) {
    const url   = process.env.GREEN_PUSH_URL   || 'http://localhost:9003/api/notify';
    const token = process.env.GREEN_PUSH_TOKEN || '';
    if (!token) return Promise.resolve();
    const body = JSON.stringify({ text });
    return new Promise(resolve => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port:     parseInt(u.port) || 80,
            path:     u.pathname,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization':  `Bearer ${token}`,
            },
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', err => { console.error('[bell] Green notify error:', err.message); resolve(); });
        req.end(body);
    });
}

function buildBellSummary() {
    const dateStr = new Date().toLocaleDateString('en-US', {
        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    });
    const indicators   = db.getLatestIndicators();
    const sectorHealth = db.getMeta('sector_health_latest');
    const stockSymbols = new Set(STOCKS.map(s => s.symbol));
    const scored = indicators
        .filter(r => stockSymbols.has(r.symbol) && r.score != null)
        .sort((a, b) => b.score - a.score);
    const high = scored.filter(r => r.score >= 65);
    const low  = scored.filter(r => r.score < 35);
    const lines = [`NYSE open — ${dateStr}`];
    if (sectorHealth != null)
        lines.push(`Sector health: ${parseFloat(sectorHealth).toFixed(2)}`);
    if (high.length > 0) {
        lines.push('');
        lines.push('High breakout: ' + high.map(r => `${r.symbol} ${Math.round(r.score)}`).join('  '));
    }
    if (low.length > 0)
        lines.push('Low: ' + low.map(r => `${r.symbol} ${Math.round(r.score)}`).join('  '));
    if (high.length === 0 && low.length === 0)
        lines.push('No strong signals today.');
    return lines.join('\n');
}

function fetchCombinedMedia(symbols) {
    const key      = process.env.ALPHA_VANTAGE_API_KEY;
    const tickers  = symbols.filter(s => s !== 'HXSCL').join(',');
    const endpoint = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${tickers}&limit=50&apikey=${key}`;
    return new Promise((resolve, reject) => {
        https.get(endpoint, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    if (data['Error Message']) return reject(new Error(data['Error Message']));
                    if (data['Note'])          return reject(new Error('Rate limit: ' + data['Note']));
                    if (data['Information'])   return reject(new Error('API limit: ' + data['Information']));
                    resolve((data.feed || []).map(a => ({
                        published_at:    (a.time_published || '').replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'),
                        title:           a.title           || '',
                        source:          a.source          || '',
                        summary:         (a.summary        || '').slice(0, 300),
                        sentiment_score: parseFloat(a.overall_sentiment_score) || null,
                        tickers:         (a.ticker_sentiment || []).map(t => t.ticker).join(', '),
                    })));
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function buildClosePrompt(indicators, articles) {
    const dateStr = new Date().toLocaleDateString('en-US', {
        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    });
    const stockSymbols = new Set(STOCKS.map(s => s.symbol));
    const scored = indicators
        .filter(r => stockSymbols.has(r.symbol) && r.score != null)
        .sort((a, b) => b.score - a.score);

    const stockTable = scored.map(r => {
        const roc = r.roc_4w != null ? `${r.roc_4w >= 0 ? '+' : ''}${(r.roc_4w * 100).toFixed(1)}%` : '?';
        const vol = r.vol_ratio != null ? `${r.vol_ratio.toFixed(2)}x` : '?';
        return `  ${r.symbol.padEnd(6)} score:${String(Math.round(r.score)).padStart(3)}  vol:${vol.padStart(5)}  rsi:${String(r.rsi?.toFixed(0) ?? '?').padStart(3)}  4w:${roc}`;
    }).join('\n');

    const newsList = articles.slice(0, 40).map(a => {
        const tks  = a.tickers ? ` [${a.tickers}]` : '';
        const sent = a.sentiment_score != null ? ` (${a.sentiment_score >= 0 ? '+' : ''}${a.sentiment_score.toFixed(2)})` : '';
        return `  ${a.published_at.slice(0, 10)} ${a.title}${tks}${sent}`;
    }).join('\n');

    const systemPrompt = `You are a senior semiconductor sector analyst writing a market-close briefing for a portfolio manager. Analyze what happened today. Plain text only, no markdown, no bullet symbols. Keep the entire response under 1800 characters.`;

    const userPrompt = `NYSE CLOSE — ${dateStr}

TRACKED STOCKS (vol_ratio = 4-week avg / prior 10-week avg volume):
${stockTable}

TODAY'S NEWS (${articles.length} articles):
${newsList}

Write a close briefing with exactly these four labeled sections:

VOLUME: Top 3 stocks by unusual volume (highest and lowest vol_ratio outliers). State each ratio.

STORIES: 2-3 trending narratives driving the sector today based on the news.

SMART MONEY: Analyst upgrades/downgrades, institutional position changes, insider trades, or notable fund/bank commentary visible in today's news. If none found, say so.

WATCH: 1-2 specific tickers or themes to monitor at tomorrow's open.

Plain text only. Specific tickers. Under 1800 characters total.`;

    return { systemPrompt, userPrompt };
}

// Uses TIME_SERIES_WEEKLY_ADJUSTED (free tier): full history, split-adjusted prices.
// "5. adjusted close" corrects for stock splits (e.g. NVDA 10:1 in Jun 2024, AVGO 10:1 in Jul 2024).
function fetchFromAlphaVantage(symbol) {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    const endpoint = `https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY_ADJUSTED&symbol=${symbol}&apikey=${key}`;

    return new Promise((resolve, reject) => {
        https.get(endpoint, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    if (json['Error Message']) return reject(new Error(json['Error Message']));
                    if (json['Note'])          return reject(new Error('Rate limit: ' + json['Note']));
                    if (json['Information'])   return reject(new Error('API limit: ' + json['Information']));
                    const ts = json['Weekly Adjusted Time Series'];
                    if (!ts) return reject(new Error('No time series in response'));
                    const prices = Object.entries(ts)
                        .map(([date, v]) => ({
                            date,
                            close:  parseFloat(v['5. adjusted close']),
                            volume: parseInt(v['6. volume'], 10),
                        }))
                        .sort((a, b) => a.date < b.date ? -1 : 1);
                    resolve(prices);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve) => {
        let buf = '';
        req.on('data', c => {
            buf += c;
            if (buf.length > 65536) { req.destroy(); resolve({}); }
        });
        req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
}

const server = http.createServer(async (req, res) => {
    const parsed   = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const query    = Object.fromEntries(parsed.searchParams);

    if (req.method === 'OPTIONS') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST' });
        res.end();
        return;
    }

    // --- API routes ---

    if (pathname === '/api/config') {
        json(res, { apiKey: process.env.ALPHA_VANTAGE_API_KEY ? 'loaded' : 'missing' });
        return;
    }

    if (pathname === '/api/edgar-summary') {
        json(res, db.getEdgarSummary());
        return;
    }

    // ── Advanced analysis API routes ─────────────────────────────────

    // GET /api/advanced-status/:symbol — button states (has data?)
    if (pathname.startsWith('/api/advanced-status/')) {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        json(res, db.getAdvancedStatus(symbol));
        return;
    }

    // GET /api/media/:symbol — recent articles
    if (pathname.startsWith('/api/media/') && !pathname.startsWith('/api/media/fetch')) {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        json(res, { symbol, articles: db.getMedia(symbol), fetchLog: db.getMediaFetchLog(symbol) });
        return;
    }

    // POST /api/media/fetch — fetch news from Alpha Vantage NEWS_SENTIMENT
    if (pathname === '/api/media/fetch' && req.method === 'POST') {
        const body    = await readBody(req);
        const symbol  = (body.symbol || '').toUpperCase();
        const fromDate = body.fromDate || null;
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        try {
            const articles = await fetchMediaFromAlphaVantage(symbol, fromDate);
            db.saveMedia(symbol, articles);
            json(res, { symbol, count: articles.length, saved: articles.length });
        } catch(err) {
            json(res, { error: err.message }, 500);
        }
        return;
    }

    // GET /api/inference/:symbol — retrieve cached inference result
    if (pathname.startsWith('/api/inference/') && req.method === 'GET') {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        json(res, db.getInferenceResult(symbol) || {});
        return;
    }

    // POST /api/infer/:symbol — stream Claude inference via SSE, save result when complete
    if (pathname.startsWith('/api/infer/') && req.method === 'POST') {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        const lastRun = _inferCooldown.get(symbol) ?? 0;
        if (Date.now() - lastRun < 60000)
            return json(res, { error: 'cooldown: inference for this symbol was triggered recently' }, 429);
        _inferCooldown.set(symbol, Date.now());
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // Intercept writes to accumulate full text while still streaming to client
        let fullResult = '';
        const intercepted = {
            write(chunk) {
                res.write(chunk);
                if (typeof chunk === 'string') {
                    for (const line of chunk.split('\n')) {
                        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
                        try { const e = JSON.parse(line.slice(6)); if (e.text) fullResult += e.text; }
                        catch { /* ignore */ }
                    }
                }
            }
        };

        const { userPrompt, systemPrompt } = buildInferencePrompt(symbol);
        await streamClaude(systemPrompt, userPrompt, intercepted);

        if (fullResult.trim()) db.saveInferenceResult(symbol, fullResult);

        res.end();
        return;
    }

    if (pathname === '/api/stocks') {
        const symbols     = STOCKS.map(s => s.symbol);
        const priceStatus = db.getPriceStatus(symbols);
        const fetchLogs   = db.getFetchLogs(symbols);
        json(res, {
            sector: 'Information Technology',
            subSector: 'Semiconductors',
            stocks: STOCKS.map(s => ({
                ...s,
                hasData:  priceStatus[s.symbol],
                fetchLog: fetchLogs[s.symbol],
            })),
        });
        return;
    }

    if (pathname === '/api/watchlist') {
        const symbols     = WATCHLIST.map(s => s.symbol);
        const priceStatus = db.getPriceStatus(symbols);
        const fetchLogs   = db.getFetchLogs(symbols);
        json(res, {
            watchlist: WATCHLIST.map(s => ({
                ...s,
                hasData:  priceStatus[s.symbol],
                fetchLog: fetchLogs[s.symbol],
            })),
        });
        return;
    }

    if (pathname === '/api/shortlist') {
        const symbols     = SHORTLIST.map(s => s.symbol);
        const priceStatus = db.getPriceStatus(symbols);
        const fetchLogs   = db.getFetchLogs(symbols);
        json(res, {
            shortlist: SHORTLIST.map(s => ({
                ...s,
                hasData:  priceStatus[s.symbol],
                fetchLog: fetchLogs[s.symbol],
            })),
        });
        return;
    }

    if (pathname === '/api/marketcap') {
        const symbols     = MARKETCAP.map(s => s.symbol);
        const priceStatus = db.getPriceStatus(symbols);
        const fetchLogs   = db.getFetchLogs(symbols);
        json(res, {
            marketcap: MARKETCAP.map(s => ({
                ...s,
                hasData:  priceStatus[s.symbol],
                fetchLog: fetchLogs[s.symbol],
            })),
        });
        return;
    }

    if (pathname === '/api/prices') {
        const symbol = query.symbol;
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        const prices = db.getPrices(symbol, 24);
        json(res, { symbol, prices, count: prices.length });
        return;
    }

    if (pathname === '/api/fetch' && req.method === 'POST') {
        const body = await readBody(req);
        const symbol = (body.symbol || query.symbol || '').toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        try {
            const result = await enqueue(symbol);
            json(res, result);
        } catch (err) {
            json(res, { error: err.message }, 500);
        }
        return;
    }

    if (pathname === '/api/fetch-all' && req.method === 'POST') {
        const queued = STOCKS.map(s => s.symbol);
        STOCKS.forEach(s => {
            enqueue(s.symbol).catch(err => console.error(`bg fetch ${s.symbol}:`, err.message));
        });
        json(res, {
            message: `Queued ${queued.length} stocks. ~${Math.ceil(queued.length * 13 / 60)} min to complete.`,
            queued,
        });
        return;
    }

    // ── Model API routes ──────────────────────────────────────────────

    // GET /api/models — scanner: latest breakout scores for all stocks
    if (pathname === '/api/models') {
        const rows = db.getLatestIndicators();
        const statsRaw = db.getMeta('backtest_stats');
        const sectorHealth = db.getMeta('sector_health_latest');
        const runAt = db.getMeta('model_run_at');
        json(res, {
            indicators: rows,
            sectorHealth: sectorHealth ? parseFloat(sectorHealth) : null,
            backtestStats: statsRaw ? JSON.parse(statsRaw) : {},
            modelRunAt: runAt,
            hasModels: rows.length > 0,
        });
        return;
    }

    // GET /api/model/:symbol — full indicator history + signals for one stock
    if (pathname.startsWith('/api/model/')) {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        const indicators = db.getIndicators(symbol);
        const signals    = db.getSignals(symbol);
        const prices     = db.getPrices(symbol, 24);
        json(res, { symbol, indicators, signals, prices });
        return;
    }

    // GET /api/signals — all signals across all stocks
    if (pathname === '/api/signals') {
        const all = db.getAllSignals();
        json(res, { signals: all, count: all.length });
        return;
    }

    // POST /api/compute-models — trigger full model recomputation
    if (pathname === '/api/compute-models' && req.method === 'POST') {
        json(res, { message: 'Model computation started in background' });
        computeAndStore().catch(err => console.error('[models] compute error:', err.message));
        return;
    }

    // ── Transcript API routes ─────────────────────────────────────────

    // GET /api/transcripts/:symbol — list of stored transcripts (no text body)
    if (pathname.startsWith('/api/transcripts/')) {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        json(res, { symbol, transcripts: db.getTranscripts(symbol) });
        return;
    }

    // GET /api/transcript/:id — full text of one transcript
    if (pathname.startsWith('/api/transcript/') && !pathname.startsWith('/api/transcripts/')) {
        const id = parseInt(pathname.split('/')[3], 10);
        if (!id) return json(res, { error: 'id required' }, 400);
        const t = db.getTranscriptText(id);
        if (!t) return json(res, { error: 'not found' }, 404);
        json(res, t);
        return;
    }

    // GET /api/transcript-signals/:symbol — NLP features over time
    if (pathname.startsWith('/api/transcript-signals/')) {
        const symbol = pathname.split('/')[3]?.toUpperCase();
        if (!symbol) return json(res, { error: 'symbol required' }, 400);
        json(res, { symbol, signals: db.getTranscriptSignals(symbol) });
        return;
    }

    // POST /api/fetch-transcripts — trigger SEC EDGAR download (background)
    if (pathname === '/api/fetch-transcripts' && req.method === 'POST') {
        const body = await readBody(req);
        const cutoff = body.cutoff || '2021-01-01';
        const symbols = body.symbols || null;
        json(res, { message: `Transcript fetch started (cutoff: ${cutoff})` });
        fetchAllTranscripts(symbols, cutoff)
            .catch(err => console.error('[transcripts] fetch error:', err.message));
        return;
    }

    // GET /api/backtest-regime — signal accuracy split by sector-health regime
    if (pathname === '/api/backtest-regime') {
        const raw = db.getMeta('regime_stats');
        json(res, raw ? JSON.parse(raw) : {});
        return;
    }

    // POST /api/fetch-earnings — fetch EPS data for all stocks
    if (pathname === '/api/fetch-earnings' && req.method === 'POST') {
        json(res, { message: 'Earnings fetch queued (~2 min for 10 stocks)' });
        fetchAllEarnings()
            .then(() => computeAndStore())
            .catch(err => console.error('[earnings] fetch error:', err.message));
        return;
    }

    // POST /api/bell — market-open sequence: fetch all prices then recompute models
    if (pathname === '/api/bell' && req.method === 'POST') {
        if (_bellRunning) {
            json(res, { skipped: true, reason: 'Bell sequence already in progress' });
            return;
        }
        _bellRunning = true;
        json(res, { triggered: true, startedAt: new Date().toISOString() });
        console.log('[bell] Market-open sequence started');
        const fetches = STOCKS.map(s =>
            enqueue(s.symbol).catch(err => console.error(`[bell] fetch error for ${s.symbol}:`, err.message))
        );
        Promise.all(fetches)
            .then(() => {
                console.log('[bell] Fetches complete — running compute-models');
                return computeAndStore();
            })
            .then(() => {
                console.log('[bell] Bell sequence complete');
                db.setMeta('bell_last_success', new Date().toISOString());
                const summary = buildBellSummary();
                return notifyGreen(summary);
            })
            .catch(err => console.error('[bell] Error:', err.message))
            .finally(() => { _bellRunning = false; });
        return;
    }

    // POST /api/close — market-close sequence: fetch news, Claude analysis, Signal notification
    if (pathname === '/api/close' && req.method === 'POST') {
        if (_closeRunning) {
            json(res, { skipped: true, reason: 'Close analysis already in progress' });
            return;
        }
        _closeRunning = true;
        json(res, { triggered: true, startedAt: new Date().toISOString() });
        console.log('[close] Market-close analysis started');

        (async () => {
            try {
                const symbols = STOCKS.map(s => s.symbol).filter(s => s !== 'HXSCL');
                console.log('[close] Fetching combined news...');
                const articles = await fetchCombinedMedia(symbols);
                console.log(`[close] ${articles.length} articles fetched`);

                const indicators = db.getLatestIndicators();
                const { systemPrompt, userPrompt } = buildClosePrompt(indicators, articles);

                let claudeOutput = '';
                const accumulator = {
                    write(chunk) {
                        if (typeof chunk !== 'string') return;
                        for (const line of chunk.split('\n')) {
                            if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
                            try { const e = JSON.parse(line.slice(6)); if (e.text) claudeOutput += e.text; }
                            catch { /* ignore */ }
                        }
                    }
                };

                console.log('[close] Running Claude analysis...');
                await streamClaude(systemPrompt, userPrompt, accumulator);

                if (claudeOutput.trim()) {
                    db.setMeta('close_last_analysis', claudeOutput.trim());
                    db.setMeta('close_last_success', new Date().toISOString());
                    const dateStr = new Date().toLocaleDateString('en-US', {
                        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
                    });
                    await notifyGreen(`NYSE close — ${dateStr}\n\n${claudeOutput.trim()}`);
                    console.log('[close] Analysis complete and sent');
                } else {
                    console.error('[close] Claude returned empty output');
                }
            } catch (err) {
                console.error('[close] Error:', err.message);
            } finally {
                _closeRunning = false;
            }
        })();
        return;
    }

    // GET /api/schedules — job config with last-run status
    if (pathname === '/api/schedules') {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'schedules.json'), 'utf8'));
            json(res, {
                timezone: config.timezone,
                jobs: config.jobs.map(job => ({
                    ...job,
                    lastRun:     db.getLastSchedulerRun(job.id),
                    lastSuccess: job.id === 'market-open-bell' ? db.getMeta('bell_last_success')
                               : job.id === 'market-close'     ? db.getMeta('close_last_success')
                               : null,
                    running:     job.id === 'market-open-bell' ? _bellRunning
                               : job.id === 'market-close'     ? _closeRunning
                               : false,
                })),
            });
        } catch (err) {
            json(res, { error: err.message }, 500);
        }
        return;
    }

    // --- Static files ---
    const publicDir = path.join(__dirname, 'public');
    const filePath  = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext         = path.extname(filePath).toLowerCase();
        const contentType = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type':  contentType,
            'Cache-Control': CACHE_CONTROL[contentType] || 'max-age=3600',
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`TenX Stock Analyzer → http://localhost:${PORT}`);
    console.log(`Tracking ${STOCKS.length} semiconductor stocks (${STOCKS.map(s => s.symbol).join(', ')})`);
    console.log(`Alpha Vantage key: ${process.env.ALPHA_VANTAGE_API_KEY ? '✓' : '✗ MISSING'}`);

    // Auto-compute models on startup if price data exists but indicators haven't been built yet
    if (!db.hasIndicators() && STOCKS.some(s => db.hasPrices(s.symbol))) {
        console.log('[startup] Running initial model computation...');
        computeAndStore().catch(err => console.error('[startup] model error:', err.message));
    }
});
