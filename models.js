'use strict';

/**
 * TenX Financial Model Engine
 *
 * All computations are strictly chronological — at every index i only
 * values from indices 0..i are used.  No future data ever touches a signal.
 *
 * Breakout Score (0-100) base components:
 *   RSI strength           0-20 pts
 *   MACD histogram         0-20 pts
 *   Bollinger + 52wH       0-20 pts
 *   Volume expansion       0-15 pts
 *   Peer rank              0-25 pts
 * Additive bonuses (cap still 100):
 *   EPS beat streak        0-10 pts
 *   OBV momentum           0-4  pts
 *   MA trend (200w)        0-5  pts
 *
 * Signal types (10 total, de-duplicated on consecutive weeks):
 *   breakout        — score crosses 70
 *   strong_breakout — score crosses 80
 *   surge           — score jumps ≥15 pts in one week
 *   rsi_momentum    — RSI crosses 50 from below
 *   macd_cross      — MACD histogram turns positive
 *   peer_reversal   — rank flips from bottom-25% to top-50%
 *   volume_breakout — ≥1.5× avg volume within 3% of 52-week high
 *   obv_divergence  — price ROC4w < –3% while OBV ROC4w > +3% (accumulation)
 *   ma_200w_cross   — price crosses above its 200-week SMA
 *   golden_cross    — 50-week SMA crosses above 200-week SMA
 */

// ── EMA ───────────────────────────────────────────────────────────────
function ema(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let sum = 0, count = 0, prev = null;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null) continue;
        count++; sum += v;
        if (count === period) { prev = sum / period; out[i] = prev; }
        else if (count > period) { prev = v * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
}

// ── SMA ───────────────────────────────────────────────────────────────
function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i] ?? 0;
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
        sum += (values[i] ?? 0) - (values[i - period] ?? 0);
        out[i] = sum / period;
    }
    return out;
}

// ── RSI(14) — Wilder smoothing ────────────────────────────────────────
function computeRSI(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) ag += d; else al -= d;
    }
    ag /= period; al /= period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + Math.max(d, 0)) / period;
        al = (al * (period - 1) + Math.max(-d, 0)) / period;
        out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
}

// ── MACD(12,26,9) ─────────────────────────────────────────────────────
function computeMACD(closes, fast = 12, slow = 26, sig = 9) {
    const e12 = ema(closes, fast);
    const e26 = ema(closes, slow);
    const line = closes.map((_, i) =>
        e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
    const signal = ema(line, sig);
    const hist = line.map((m, i) =>
        m != null && signal[i] != null ? m - signal[i] : null);
    return { line, signal, hist };
}

// ── Bollinger Bands(20, 2σ) ───────────────────────────────────────────
function computeBollinger(closes, period = 20, mult = 2) {
    const mid = sma(closes, period);
    return closes.map((c, i) => {
        if (mid[i] == null) return { upper: null, mid: null, lower: null, pct: null };
        let vari = 0;
        for (let j = i - period + 1; j <= i; j++) vari += (closes[j] - mid[i]) ** 2;
        const sd = Math.sqrt(vari / period);
        const upper = mid[i] + mult * sd;
        const lower = mid[i] - mult * sd;
        const pct = upper === lower ? 0.5 : Math.max(-0.5, Math.min(1.5, (c - lower) / (upper - lower)));
        return { upper, mid: mid[i], lower, pct };
    });
}

// ── Rate of Change ────────────────────────────────────────────────────
function computeROC(closes, period) {
    return closes.map((c, i) => {
        const p = closes[i - period];
        return i >= period && p && p !== 0 ? ((c - p) / p) * 100 : null;
    });
}

// ── Volume ratio: recent-4w avg ÷ prior-10w avg ───────────────────────
function computeVolumeRatio(volumes, recentN = 4, priorN = 10) {
    return volumes.map((_, i) => {
        if (i < recentN + priorN - 1) return null;
        let rec = 0; for (let j = i - recentN + 1; j <= i; j++) rec += volumes[j] || 0;
        let pri = 0; const ps = i - recentN - priorN + 1;
        for (let j = ps; j < ps + priorN; j++) pri += volumes[j] || 0;
        return pri === 0 ? null : (rec / recentN) / (pri / priorN);
    });
}

// ── Rolling N-week high ───────────────────────────────────────────────
function computeRollingHigh(closes, weeks = 52) {
    return closes.map((_, i) =>
        i < weeks - 1 ? null : Math.max(...closes.slice(i - weeks + 1, i + 1)));
}

// ── On-Balance Volume ─────────────────────────────────────────────────
// Cumulative: add volume on up-close days, subtract on down-close days.
// Absolute OBV values are meaningless; slope/ROC is the signal.
function computeOBV(closes, volumes) {
    const out = new Array(closes.length).fill(null);
    if (!closes.length) return out;
    out[0] = 0;
    for (let i = 1; i < closes.length; i++) {
        const prev = out[i - 1] ?? 0;
        const vol  = volumes[i] || 0;
        if (closes[i] > closes[i - 1])      out[i] = prev + vol;
        else if (closes[i] < closes[i - 1]) out[i] = prev - vol;
        else                                 out[i] = prev;
    }
    return out;
}

// OBV rate-of-change over `period` weeks (%)
function computeOBVROC(obv, period = 4) {
    return obv.map((v, i) => {
        const p = obv[i - period];
        if (i < period || v == null || p == null || p === 0) return null;
        return ((v - p) / Math.abs(p)) * 100;
    });
}

// ── SMA distances (price − SMAn) / SMAn * 100 ──────────────────────
function computeMADistance(closes, period) {
    const s = sma(closes, period);
    return closes.map((c, i) =>
        s[i] != null && s[i] !== 0 ? ((c - s[i]) / s[i]) * 100 : null);
}

// Golden cross: returns 1 when 50w SMA > 200w SMA, else 0
function computeGoldenCross(closes) {
    const s50  = sma(closes, 50);
    const s200 = sma(closes, 200);
    return closes.map((_, i) =>
        s50[i] != null && s200[i] != null ? (s50[i] > s200[i] ? 1 : 0) : null);
}

// ── Peer rank ─────────────────────────────────────────────────────────
function computePeerRanks(alignedCloses, lookback = 8) {
    const syms = Object.keys(alignedCloses);
    const n = alignedCloses[syms[0]].length;
    const ranks = Object.fromEntries(syms.map(s => [s, new Array(n).fill(null)]));
    for (let i = lookback; i < n; i++) {
        const rets = {};
        let ok = true;
        for (const s of syms) {
            const a = alignedCloses[s];
            if (!a[i] || !a[i - lookback]) { ok = false; break; }
            rets[s] = (a[i] - a[i - lookback]) / a[i - lookback];
        }
        if (!ok) continue;
        syms.slice().sort((a, b) => rets[a] - rets[b])
            .forEach((s, rank) => { ranks[s][i] = rank / (syms.length - 1); });
    }
    return ranks;
}

// ── Breakout score ────────────────────────────────────────────────────
function scoreBreakout({
    rsiVal, macdHist, macdHistPrev, bbPct, volRatio,
    peerRank, peerRankPrev, priceVs52h, epsBeats,
    obvRoc4, dist200w, goldenCross,
}) {
    const c = {};

    // 1. RSI (0-20)
    c.rsi = rsiVal == null   ? 0
        : rsiVal >= 70       ? 20
        : rsiVal >= 60       ? 17
        : rsiVal >= 55       ? 14
        : rsiVal >= 50       ? 10
        : rsiVal >= 40       ? 5
        : rsiVal >= 30       ? 2 : 1;

    // 2. MACD histogram direction (0-20)
    c.macd = macdHist == null ? 0
        : (macdHist > 0 && macdHistPrev != null && macdHist > macdHistPrev) ? 20
        : macdHist > 0                                                       ? 14
        : (macdHist < 0 && macdHistPrev != null && macdHist > macdHistPrev) ? 8
        : 2;

    // 3. Bollinger + 52w high (0-20)
    const bbBase = bbPct == null  ? 0
        : bbPct >= 0.9  ? 15 : bbPct >= 0.75 ? 12 : bbPct >= 0.60 ? 9
        : bbPct >= 0.50 ? 6  : bbPct >= 0.30 ? 3  : 1;
    const highBns = priceVs52h == null ? 0
        : priceVs52h >= 0.99 ? 5 : priceVs52h >= 0.97 ? 4 : priceVs52h >= 0.95 ? 3
        : priceVs52h >= 0.90 ? 2 : 0;
    c.bb = Math.min(20, bbBase + highBns);

    // 4. Volume expansion (0-15)
    c.volume = volRatio == null ? 0
        : volRatio >= 2.0 ? 15 : volRatio >= 1.5 ? 12 : volRatio >= 1.2 ? 9
        : volRatio >= 1.0 ? 6  : volRatio >= 0.8 ? 3  : 1;

    // 5. Peer rank + rank-improvement bonus (0-25)
    const rankBase = peerRank == null ? 0
        : peerRank >= 0.9 ? 22 : peerRank >= 0.7 ? 17 : peerRank >= 0.5 ? 12
        : peerRank >= 0.3 ? 7  : 3;
    const rankDelta = peerRank != null && peerRankPrev != null
        ? (peerRank - peerRankPrev >= 0.30 ? 3
         : peerRank - peerRankPrev >= 0.15 ? 2
         : peerRank - peerRankPrev >  0    ? 1 : 0) : 0;
    c.peer = Math.min(25, rankBase + rankDelta);

    const base = c.rsi + c.macd + c.bb + c.volume + c.peer;

    // ── Additive bonuses (multiple can stack, total still capped at 100) ──

    // 6. EPS beat streak
    c.eps = epsBeats == null ? 0 : epsBeats >= 3 ? 10 : epsBeats >= 2 ? 7 : epsBeats >= 1 ? 4 : 0;

    // 7. OBV momentum — rising OBV confirms buying pressure behind the move
    c.obv = obvRoc4 == null ? 0
        : obvRoc4 >= 10 ? 4 : obvRoc4 >= 5 ? 3 : obvRoc4 >= 2 ? 2 : obvRoc4 >= 0 ? 1 : 0;

    // 8. MA trend — price above long-term SMA means the trend is supportive
    c.ma = dist200w == null ? 0
        : (goldenCross && dist200w > 5)  ? 5
        : (goldenCross || dist200w > 0)  ? 3
        : dist200w > -5                  ? 1 : 0;

    return { score: Math.min(100, base + c.eps + c.obv + c.ma), components: c };
}

// ── Consecutive EPS beats up to cutoffDate ────────────────────────────
function countEpsBeats(earnings, cutoffDate) {
    const past = (earnings || [])
        .filter(e => e.reported_date <= cutoffDate && e.reported_eps != null && e.estimated_eps != null)
        .sort((a, b) => b.reported_date.localeCompare(a.reported_date));
    let streak = 0;
    for (const q of past) { if (q.reported_eps > q.estimated_eps) streak++; else break; }
    return streak > 0 ? streak : null;
}

// ── Forward-fill nulls ────────────────────────────────────────────────
function forwardFill(arr) {
    const out = [...arr]; let last = null;
    for (let i = 0; i < out.length; i++) {
        if (out[i] != null) last = out[i]; else out[i] = last;
    }
    return out;
}

// ── Confluence: distinct signal types fired in trailing 4w window ─────
// Returns array of counts, one per date index, for a single stock's signals.
function computeConfluence(signals, dates) {
    const out = new Array(dates.length).fill(0);
    for (let i = 0; i < dates.length; i++) {
        const windowStart = i >= 4 ? dates[i - 4] : dates[0];
        const types = new Set(
            signals.filter(s => s.date >= windowStart && s.date <= dates[i]).map(s => s.type)
        );
        out[i] = types.size;
    }
    return out;
}

// ── Master computation ────────────────────────────────────────────────
/**
 * allData      { symbol: [{date, close, volume}] }  full history, sorted asc
 * earningsData { symbol: [{reported_date, reported_eps, estimated_eps}] }
 *
 * Returns { dates, sectorHealth, sectorHealthMap, results, regimeStats }
 */
function computeAllModels(allData, earningsData = {}) {
    const symbols = Object.keys(allData);
    if (!symbols.length) return { dates: [], sectorHealth: [], sectorHealthMap: {}, results: {}, regimeStats: {} };

    const dateSet = new Set();
    symbols.forEach(s => allData[s].forEach(r => dateSet.add(r.date)));
    const dates = Array.from(dateSet).sort();
    const n = dates.length;

    const aligned = {};
    symbols.forEach(sym => {
        const map = {};
        allData[sym].forEach(r => { map[r.date] = r; });
        aligned[sym] = {
            closes:  forwardFill(dates.map(d => map[d]?.close  ?? null)),
            volumes: forwardFill(dates.map(d => map[d]?.volume ?? null)),
        };
    });

    // Technical indicators (per stock)
    const tech = {};
    symbols.forEach(sym => {
        const c = aligned[sym].closes;
        const v = aligned[sym].volumes;
        const obv = computeOBV(c, v);
        tech[sym] = {
            rsi:       computeRSI(c),
            macd:      computeMACD(c),
            bb:        computeBollinger(c),
            vol:       computeVolumeRatio(v),
            roc4:      computeROC(c, 4),
            roc12:     computeROC(c, 12),
            hi52:      computeRollingHigh(c, 52),
            obv,
            obvRoc4:   computeOBVROC(obv, 4),
            sma20:     sma(c, 20),
            sma50:     sma(c, 50),
            sma200:    sma(c, 200),
            dist200w:  computeMADistance(c, 200),
            dist50w:   computeMADistance(c, 50),
            gc:        computeGoldenCross(c),
        };
    });

    const closesMap = Object.fromEntries(symbols.map(s => [s, aligned[s].closes]));
    const peerRanks = computePeerRanks(closesMap, 8);

    // First pass: compute all scores (needed for sector health)
    const allScores = Object.fromEntries(symbols.map(s => [s, new Array(n).fill(null)]));
    symbols.forEach(sym => {
        const ind = tech[sym], c = aligned[sym].closes, earn = earningsData[sym] || [];
        for (let i = 1; i < n; i++) {
            if (c[i] == null) continue;
            const hi52 = ind.hi52[i], rank = peerRanks[sym][i];
            const { score } = scoreBreakout({
                rsiVal:       ind.rsi[i],
                macdHist:     ind.macd.hist[i],
                macdHistPrev: ind.macd.hist[i - 1],
                bbPct:        ind.bb[i]?.pct,
                volRatio:     ind.vol[i],
                peerRank:     rank,
                peerRankPrev: i >= 4 ? peerRanks[sym][i - 4] : null,
                priceVs52h:   hi52 && hi52 > 0 ? c[i] / hi52 : null,
                epsBeats:     countEpsBeats(earn, dates[i]),
                obvRoc4:      ind.obvRoc4[i],
                dist200w:     ind.dist200w[i],
                goldenCross:  ind.gc[i] === 1,
            });
            allScores[sym][i] = score;
        }
    });

    // Sector health = mean score across all stocks per date
    const sectorHealth = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const vals = symbols.map(s => allScores[s][i]).filter(v => v != null);
        sectorHealth[i] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    const sectorHealthMap = Object.fromEntries(dates.map((d, i) => [d, sectorHealth[i]]));

    // Second pass: generate signals (now sector health is available)
    const results = {};
    symbols.forEach(sym => {
        const ind    = tech[sym];
        const closes = aligned[sym].closes;
        const earn   = earningsData[sym] || [];
        const scores = allScores[sym];
        const comps  = new Array(n).fill(null);
        const signals = [];
        let prevScore = null;

        for (let i = 1; i < n; i++) {
            if (closes[i] == null) { prevScore = null; continue; }

            const hi52     = ind.hi52[i];
            const rank     = peerRanks[sym][i];
            const rankPrev = i >= 4 ? peerRanks[sym][i - 4] : null;
            const pvh52    = hi52 && hi52 > 0 ? closes[i] / hi52 : null;

            const { score, components } = scoreBreakout({
                rsiVal:       ind.rsi[i],
                macdHist:     ind.macd.hist[i],
                macdHistPrev: ind.macd.hist[i - 1],
                bbPct:        ind.bb[i]?.pct,
                volRatio:     ind.vol[i],
                peerRank:     rank,
                peerRankPrev: rankPrev,
                priceVs52h:   pvh52,
                epsBeats:     countEpsBeats(earn, dates[i]),
                obvRoc4:      ind.obvRoc4[i],
                dist200w:     ind.dist200w[i],
                goldenCross:  ind.gc[i] === 1,
            });
            scores[i] = score;
            comps[i]  = { ...components, total: score };

            const emit = (type, desc) => {
                const last = signals.findLast(s => s.type === type);
                if (last && last.date >= dates[i - 1]) return;
                signals.push({
                    symbol: sym, date: dates[i], type, score, description: desc,
                    sector_health: sectorHealth[i],
                });
            };

            // ── Original 7 signals ─────────────────────────────────
            if (prevScore != null) {
                if (score >= 70 && prevScore < 70)
                    emit('breakout',        `Score ${score.toFixed(0)} crossed 70 (was ${prevScore.toFixed(0)})`);
                if (score >= 80 && prevScore < 80)
                    emit('strong_breakout', `High-conviction: score ${score.toFixed(0)}`);
                if (score - prevScore >= 15)
                    emit('surge',           `Score surged +${(score - prevScore).toFixed(0)} pts in one week`);
            }
            if (ind.rsi[i] != null && ind.rsi[i - 1] != null && ind.rsi[i] >= 50 && ind.rsi[i - 1] < 50)
                emit('rsi_momentum', `RSI crossed 50 (${ind.rsi[i].toFixed(1)})`);
            if (ind.macd.hist[i] != null && ind.macd.hist[i - 1] != null
                    && ind.macd.hist[i] > 0 && ind.macd.hist[i - 1] <= 0)
                emit('macd_cross', `MACD histogram turned positive`);
            if (rank != null && rankPrev != null && rank >= 0.5 && rankPrev < 0.25)
                emit('peer_reversal',
                    `Rank: bottom-${(rankPrev*100).toFixed(0)}% → top-${((1-rank)*100).toFixed(0)}%`);
            if (ind.vol[i] != null && ind.vol[i] >= 1.5 && pvh52 != null && pvh52 >= 0.97)
                emit('volume_breakout',
                    `${ind.vol[i].toFixed(2)}× vol, ${((1-pvh52)*100).toFixed(1)}% from 52w high`);

            // ── 3 new signals ──────────────────────────────────────
            // OBV divergence: price weakening but OBV rising = smart-money accumulation
            if (ind.roc4[i] != null && ind.obvRoc4[i] != null
                    && ind.roc4[i] < -3 && ind.obvRoc4[i] > 3)
                emit('obv_divergence',
                    `Price ${ind.roc4[i].toFixed(1)}% (4w) but OBV +${ind.obvRoc4[i].toFixed(1)}% — accumulation`);

            // Price crosses above 200w SMA
            if (ind.dist200w[i] != null && ind.dist200w[i - 1] != null
                    && ind.dist200w[i] >= 0 && ind.dist200w[i - 1] < 0)
                emit('ma_200w_cross',
                    `Price crossed above 200w SMA (now ${ind.dist200w[i].toFixed(1)}% above)`);

            // Golden cross: 50w SMA crosses above 200w SMA
            if (ind.gc[i] != null && ind.gc[i - 1] != null && ind.gc[i] === 1 && ind.gc[i - 1] === 0)
                emit('golden_cross', `50w SMA crossed above 200w SMA`);

            prevScore = score;
        }

        // Forward returns (evaluation only — never fed back into signal logic)
        signals.forEach(sig => {
            const si = dates.indexOf(sig.date);
            [4, 8, 12].forEach(w => {
                const fi = si + w;
                sig[`fwd${w}w`] = fi < n && closes[fi] && closes[si] && closes[si] > 0
                    ? ((closes[fi] - closes[si]) / closes[si]) * 100 : null;
            });
        });

        // Confluence: distinct signal types active in trailing 4w window
        const confluence = computeConfluence(signals, dates);

        results[sym] = {
            dates, closes,
            indicators: {
                rsi:       ind.rsi,
                macdLine:  ind.macd.line,
                macdSig:   ind.macd.signal,
                macdHist:  ind.macd.hist,
                bbUpper:   ind.bb.map(b => b.upper),
                bbMid:     ind.bb.map(b => b.mid),
                bbLower:   ind.bb.map(b => b.lower),
                bbPct:     ind.bb.map(b => b.pct),
                volRatio:  ind.vol,
                roc4:      ind.roc4,
                roc12:     ind.roc12,
                hi52:      ind.hi52,
                peerRank:  peerRanks[sym],
                obv:       ind.obv,
                obvRoc4:   ind.obvRoc4,
                sma20:     ind.sma20,
                sma50:     ind.sma50,
                sma200:    ind.sma200,
                dist200w:  ind.dist200w,
                dist50w:   ind.dist50w,
                gc:        ind.gc,
                confluence,
            },
            scores, components: comps, signals,
        };
    });

    return {
        dates, sectorHealth, sectorHealthMap,
        results,
        regimeStats: regimeBacktestStats(results),
    };
}

// ── Backtest statistics (overall) ────────────────────────────────────
function backtestStats(results) {
    const by = {};
    for (const { signals } of Object.values(results)) {
        for (const s of signals) {
            if (!by[s.type]) by[s.type] = { n:0, wins4:0, sum4:0, sum8:0, sum12:0, n4:0, n8:0, n12:0 };
            const b = by[s.type]; b.n++;
            if (s.fwd4w  != null) { b.sum4  += s.fwd4w;  b.n4++;  if (s.fwd4w  > 0) b.wins4++; }
            if (s.fwd8w  != null) { b.sum8  += s.fwd8w;  b.n8++;  }
            if (s.fwd12w != null) { b.sum12 += s.fwd12w; b.n12++; }
        }
    }
    const fmt = b => ({
        n:         b.n,
        pctPositive: b.n4 > 0 ? (b.wins4 / b.n4 * 100).toFixed(1) : null,
        avgFwd4w:  b.n4  > 0 ? (b.sum4  / b.n4).toFixed(2)  : null,
        avgFwd8w:  b.n8  > 0 ? (b.sum8  / b.n8).toFixed(2)  : null,
        avgFwd12w: b.n12 > 0 ? (b.sum12 / b.n12).toFixed(2) : null,
    });
    return Object.fromEntries(Object.entries(by).map(([t, b]) => [t, fmt(b)]));
}

// ── Regime-conditioned backtest ───────────────────────────────────────
// Groups signal accuracy by sector health at time of signal:
//   low    < 45   (sector under pressure)
//   medium 45–65  (neutral)
//   high   > 65   (sector tailwind)
function regimeBacktestStats(results) {
    const buckets = { low: {}, medium: {}, high: {} };
    const regime = h => h == null ? null : h < 45 ? 'low' : h < 65 ? 'medium' : 'high';

    for (const { signals } of Object.values(results)) {
        for (const s of signals) {
            const r = regime(s.sector_health);
            if (!r) continue;
            if (!buckets[r][s.type]) buckets[r][s.type] = { n:0, wins4:0, sum4:0, sum8:0, sum12:0, n4:0, n8:0, n12:0 };
            const b = buckets[r][s.type]; b.n++;
            if (s.fwd4w  != null) { b.sum4  += s.fwd4w;  b.n4++;  if (s.fwd4w  > 0) b.wins4++; }
            if (s.fwd8w  != null) { b.sum8  += s.fwd8w;  b.n8++;  }
            if (s.fwd12w != null) { b.sum12 += s.fwd12w; b.n12++; }
        }
    }
    const fmt = b => ({
        n:           b.n,
        pctPositive: b.n4 > 0 ? (b.wins4 / b.n4 * 100).toFixed(1) : null,
        avgFwd4w:    b.n4  > 0 ? (b.sum4  / b.n4).toFixed(2)  : null,
        avgFwd8w:    b.n8  > 0 ? (b.sum8  / b.n8).toFixed(2)  : null,
        avgFwd12w:   b.n12 > 0 ? (b.sum12 / b.n12).toFixed(2) : null,
    });
    const out = {};
    for (const [r, types] of Object.entries(buckets)) {
        out[r] = Object.fromEntries(Object.entries(types).map(([t, b]) => [t, fmt(b)]));
    }
    return out;
}

module.exports = {
    computeAllModels, backtestStats, regimeBacktestStats,
    computeRSI, computeMACD, computeBollinger, computeROC,
    computeVolumeRatio, computeRollingHigh, computePeerRanks,
    computeOBV, computeOBVROC, computeMADistance, computeGoldenCross,
    computeConfluence, scoreBreakout, ema, sma,
};
