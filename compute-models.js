#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('./database');
const { computeAllModels, backtestStats } = require('./models');

const SYMBOLS = ['MU', 'KLAC', 'AMD', 'AVGO', 'NVDA', 'LRCX', 'AMAT', 'MPWR', 'ADI', 'QCOM', 'SNDK', 'WDC', 'STX', 'SMH'];

async function computeAndStore() {
    console.log('[models] Loading price data...');
    const allData = {};
    for (const sym of SYMBOLS) {
        const rows = db.getPricesAll(sym);
        if (!rows.length) { console.warn(`  ${sym}: no price data — skipped`); continue; }
        allData[sym] = rows;
        console.log(`  ${sym}: ${rows.length} weeks`);
    }
    if (!Object.keys(allData).length) throw new Error('No price data in DB');

    console.log('[models] Loading earnings data...');
    const earningsData = {};
    for (const sym of SYMBOLS) {
        earningsData[sym] = db.getEarnings(sym);
        if (earningsData[sym].length) console.log(`  ${sym}: ${earningsData[sym].length} quarters`);
    }

    console.log('[models] Computing indicators + signals (chronological, no lookahead)...');
    const { dates, sectorHealth, results, regimeStats } = computeAllModels(allData, earningsData);
    console.log(`  Date range: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} weeks)`);

    console.log('[models] Storing indicators, signals, sector health...');
    db.saveSectorHealth(dates, sectorHealth);

    let totalSignals = 0;
    for (const [sym, res] of Object.entries(results)) {
        db.saveIndicators(sym, res.dates, res.closes, res.indicators, res.scores, res.components);
        db.saveSignals(res.signals);
        console.log(`  ${sym}: score=${res.scores[res.scores.length-1]?.toFixed(0) ?? '—'}  signals=${res.signals.length}`);
        totalSignals += res.signals.length;
    }

    const stats = backtestStats(results);
    db.setMeta('backtest_stats',     JSON.stringify(stats));
    db.setMeta('regime_stats',       JSON.stringify(regimeStats));
    db.setMeta('sector_health_latest', sectorHealth[sectorHealth.length - 1]?.toFixed(1) ?? 'null');
    db.setMeta('model_run_at',       new Date().toISOString());

    console.log(`[models] Done. ${totalSignals} total signals.`);
    console.log('[models] Overall backtest:');
    for (const [type, s] of Object.entries(stats))
        console.log(`  ${type.padEnd(16)} n=${s.n}  win%=${s.pctPositive}  avg4w=${s.avgFwd4w}%  avg12w=${s.avgFwd12w}%`);

    console.log('[models] Regime stats (high / medium / low):');
    const allTypes = [...new Set(Object.values(regimeStats).flatMap(r => Object.keys(r)))];
    for (const type of allTypes) {
        const h = regimeStats.high?.[type], m = regimeStats.medium?.[type], l = regimeStats.low?.[type];
        console.log(`  ${type.padEnd(16)} high:win%=${h?.pctPositive ?? '—'}  med:win%=${m?.pctPositive ?? '—'}  low:win%=${l?.pctPositive ?? '—'}`);
    }

    return { dates, results, sectorHealth, stats, regimeStats };
}

module.exports = { computeAndStore };

if (require.main === module)
    computeAndStore().catch(err => { console.error(err); process.exit(1); });
