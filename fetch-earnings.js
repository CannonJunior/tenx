#!/usr/bin/env node
/**
 * fetch-earnings.js
 * Fetches quarterly EPS data from Alpha Vantage EARNINGS endpoint (free tier).
 * Stores reported vs estimated EPS so models can compute consecutive-beat streaks.
 *
 * Additional data that would improve the model but requires paid sources:
 *   - Revenue guidance raise/lower (call transcript NLP — e.g., Sentieo, Refinitiv)
 *   - Short interest % of float (Nasdaq weekly file or Finviz premium)
 *   - Insider Form-4 transactions (SEC EDGAR bulk data — free but complex to parse)
 *   - News sentiment / AI-mention frequency (Alpha Vantage News — premium tier)
 *   - Book-to-bill ratio for equipment makers AMAT/LRCX/KLAC (SEMI.org monthly report)
 *   - DRAM/NAND spot pricing for MU (DRAMeXchange / TrendForce — subscription)
 */

'use strict';

const https = require('https');
require('dotenv').config();
const db = require('./database');

const SYMBOLS = ['MU', 'KLAC', 'AMD', 'AVGO', 'NVDA', 'LRCX', 'AMAT', 'MPWR', 'ADI', 'QCOM'];

function fetchEarnings(symbol) {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${key}`;
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(raw);
                    if (j['Error Message']) return reject(new Error(j['Error Message']));
                    if (j['Note'])          return reject(new Error('Rate limit'));
                    if (j['Information'])   return reject(new Error('API limit'));
                    const quarterly = j.quarterlyEarnings || [];
                    const rows = quarterly
                        .filter(q => q.reportedDate && q.reportedDate !== 'None')
                        .map(q => ({
                            fiscal_date:   q.fiscalDateEnding,
                            reported_date: q.reportedDate,
                            reported_eps:  q.reportedEPS  !== 'None' ? parseFloat(q.reportedEPS)  : null,
                            estimated_eps: q.estimatedEPS !== 'None' ? parseFloat(q.estimatedEPS) : null,
                            surprise_pct:  q.surprisePercentage !== 'None' ? parseFloat(q.surprisePercentage) : null,
                        }))
                        .filter(r => r.reported_eps != null);
                    resolve(rows);
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllEarnings(symbols = SYMBOLS) {
    const results = {};
    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        try {
            console.log(`[earnings] ${sym} (${i + 1}/${symbols.length})`);
            const rows = await fetchEarnings(sym);
            db.saveEarnings(sym, rows);
            results[sym] = { count: rows.length };
            console.log(`  saved ${rows.length} quarters`);
        } catch (err) {
            console.error(`  failed: ${err.message}`);
            results[sym] = { error: err.message };
        }
        if (i < symbols.length - 1) await sleep(13000); // 5 req/min rate limit
    }
    return results;
}

module.exports = { fetchAllEarnings, fetchEarnings };

// Run directly
if (require.main === module) {
    fetchAllEarnings().then(r => {
        console.log('Done:', r);
    }).catch(console.error);
}
