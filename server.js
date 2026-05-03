#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
require('dotenv').config();

const db = require('./database');
const { computeAndStore } = require('./compute-models');
const { fetchAllEarnings } = require('./fetch-earnings');
const { fetchAllTranscripts } = require('./fetch-transcripts');
const { backtestStats } = require('./models');
const PORT = process.env.PORT || 9004;

// Top 10 S&P 500 semiconductor stocks ranked by estimated 1-year growth (Apr 2025–Apr 2026)
const STOCKS = [
    { symbol: 'MU',   name: 'Micron Technology',         subIndustry: 'Semiconductors',                       estYearGrowth: 168 },
    { symbol: 'KLAC', name: 'KLA Corporation',            subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 112 },
    { symbol: 'AMD',  name: 'Advanced Micro Devices',     subIndustry: 'Semiconductors',                       estYearGrowth: 64  },
    { symbol: 'AVGO', name: 'Broadcom',                   subIndustry: 'Semiconductors',                       estYearGrowth: 41  },
    { symbol: 'NVDA', name: 'Nvidia',                     subIndustry: 'Semiconductors',                       estYearGrowth: 27  },
    { symbol: 'LRCX', name: 'Lam Research',               subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 25  },
    { symbol: 'AMAT', name: 'Applied Materials',          subIndustry: 'Semiconductor Materials & Equipment',  estYearGrowth: 22  },
    { symbol: 'MPWR', name: 'Monolithic Power Systems',   subIndustry: 'Semiconductors',                       estYearGrowth: 20  },
    { symbol: 'ADI',  name: 'Analog Devices',             subIndustry: 'Semiconductors',                       estYearGrowth: 15  },
    { symbol: 'QCOM', name: 'Qualcomm',                   subIndustry: 'Semiconductors',                       estYearGrowth: 10  },
    { symbol: 'SNDK', name: 'Sandisk',                    subIndustry: 'Data Storage',                         estYearGrowth: -11 },
    { symbol: 'WDC',  name: 'Western Digital',            subIndustry: 'Data Storage',                         estYearGrowth: -25 },
    { symbol: 'STX',  name: 'Seagate Technology',         subIndustry: 'Data Storage',                         estYearGrowth: -23 },
    { symbol: 'SMH',  name: 'VanEck Semiconductor ETF',   subIndustry: 'ETF',                                  estYearGrowth: 25,  isEtf: true },
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
        req.on('data', c => { buf += c; });
        req.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

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

    if (pathname === '/api/stocks') {
        json(res, {
            sector: 'Information Technology',
            subSector: 'Semiconductors',
            stocks: STOCKS.map(s => ({
                ...s,
                hasData: db.hasPrices(s.symbol),
                fetchLog: db.getFetchLog(s.symbol),
            })),
        });
        return;
    }

    if (pathname === '/api/watchlist') {
        json(res, {
            watchlist: WATCHLIST.map(s => ({
                ...s,
                hasData: db.hasPrices(s.symbol),
                fetchLog: db.getFetchLog(s.symbol),
            })),
        });
        return;
    }

    if (pathname === '/api/shortlist') {
        json(res, {
            shortlist: SHORTLIST.map(s => ({
                ...s,
                hasData: db.hasPrices(s.symbol),
                fetchLog: db.getFetchLog(s.symbol),
            })),
        });
        return;
    }

    if (pathname === '/api/marketcap') {
        json(res, {
            marketcap: MARKETCAP.map(s => ({
                ...s,
                hasData: db.hasPrices(s.symbol),
                fetchLog: db.getFetchLog(s.symbol),
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

    // --- Static files ---
    const filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
