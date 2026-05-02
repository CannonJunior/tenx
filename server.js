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
