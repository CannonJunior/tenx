/* TenX – Semiconductor Sector Dashboard */

const COLORS = {
    MU:   '#FF6B6B',
    KLAC: '#4ECDC4',
    AMD:  '#45B7D1',
    AVGO: '#96CEB4',
    NVDA: '#76B041',
    LRCX: '#DDA0DD',
    AMAT: '#F7DC6F',
    MPWR: '#F0B27A',
    ADI:  '#85C1E9',
    QCOM: '#F1948A',
    SNDK: '#A78BFA',
    WDC:  '#34D399',
    STX:  '#FB923C',
    SMH:   '#FFDD57',
    HXSCL: '#EA580C',
    TSM:   '#2563EB',
    VRT:   '#059669',
    // Watchlist doublers
    INTC: '#0071C5',
    TER:  '#E05C2A',
    PLTR: '#FF6200',
    APP:  '#7C4DFF',
    // High short interest panel
    CAR:  '#EF4444',
    RH:   '#B45309',
    IONQ: '#7C3AED',
    MRNA: '#0284C7',
    CHTR: '#475569',
    H:    '#0F766E',
    CZR:  '#BE185D',
    NCLH: '#1D4ED8',
    RIVN: '#15803D',
    SMCI: '#CA8A04',
    CCL:  '#6D28D9',
    DKNG: '#9F1239',
    GPS:  '#3F6212',
    PVH:  '#1E40AF',
    MGM:  '#9A3412',
    WBD:  '#374151',
    UAL:  '#1E3A8A',
    NKE:  '#B91C1C',
    LVS:  '#78350F',
    BA:   '#0C4A6E',
    // Market cap panel
    AAPL: '#A2AAAD',
    MSFT: '#00A4EF',
    AMZN: '#FF9900',
    GOOGL:'#4285F4',
    META: '#1877F2',
    LLY:  '#C8102E',
    TSLA: '#E82127',
    WMT:  '#0071DC',
    JPM:  '#1A3D6D',
    V:    '#1A1F71',
    MA:   '#F79E1B',
    COST: '#005DAA',
    XOM:  '#EB1C2D',
    NFLX: '#E50914',
    HD:   '#F96302',
    ORCL: '#C74634',
    UNH:  '#316BBE',
    ABBV: '#023C91',
};

// ── Data freshness helpers ────────────────────────────────────────────
function getFreshnessColor(stock) {
    const s = typeof settings !== 'undefined' ? settings : {};
    if (!stock?.hasData || !stock.fetchLog?.last_fetched)
        return s.freshnessStaleColor ?? '#EF4444';
    const ageH = (Date.now() - new Date(stock.fetchLog.last_fetched).getTime()) / 3600000;
    if (ageH <= (s.freshnessT1Hours ?? 24))  return s.freshnessT1Color ?? '#3B82F6';
    if (ageH <= (s.freshnessT2Hours ?? 48))  return s.freshnessT2Color ?? '#22C55E';
    if (ageH <= (s.freshnessT3Hours ?? 120)) return s.freshnessT3Color ?? '#EAB308';
    return s.freshnessStaleColor ?? '#EF4444';
}

function isStaleFetch(stock) {
    if (!stock?.hasData || !stock.fetchLog?.last_fetched) return false;
    const s = typeof settings !== 'undefined' ? settings : {};
    const ageH = (Date.now() - new Date(stock.fetchLog.last_fetched).getTime()) / 3600000;
    return ageH > (s.freshnessT3Hours ?? 120);
}

function buildAgeText(stock) {
    if (!stock?.fetchLog?.last_fetched) return '';
    const ageH = (Date.now() - new Date(stock.fetchLog.last_fetched).getTime()) / 3600000;
    return ageH < 24
        ? `Data: ${Math.round(ageH)}h ago`
        : `Data: ${(ageH / 24).toFixed(1)}d ago`;
}

function updateCardFreshness(symbol, ctx = '') {
    const sid  = ctx + symbol;
    const card = $(`card-${sid}`);
    if (!card) return;
    const allStocks = [...state.stocks, ...Object.values(state.panels).flat()];
    const stock = allStocks.find(s => s.symbol === symbol);
    if (!stock) return;
    card.style.borderTopColor = getFreshnessColor(stock);
    const staleBanner = $(`stale-${sid}`);
    if (!staleBanner) return;
    if (isStaleFetch(stock)) {
        const ageEl = staleBanner.querySelector('.stale-age');
        if (ageEl) ageEl.textContent = buildAgeText(stock);
        staleBanner.classList.remove('hidden');
    } else {
        staleBanner.classList.add('hidden');
    }
}

function updateStockFetchLog(symbol, rowCount) {
    const now = new Date().toISOString();
    const allStocks = [...state.stocks, ...Object.values(state.panels).flat()];
    for (const s of allStocks) {
        if (s.symbol === symbol) {
            s.fetchLog = { symbol, last_fetched: now, status: 'success', row_count: rowCount };
            s.hasData = true;
        }
    }
}

function refreshAllFreshnessBorders() {
    for (const stock of state.stocks) updateCardFreshness(stock.symbol);
    for (const [name, items] of Object.entries(state.panels)) {
        for (const stock of items) updateCardFreshness(stock.symbol, name + '_');
    }
}

// hex → rgba helper
function rgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ── Growth-based color helpers ────────────────────────────────────────
function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function getGlobalMaxGrowth() {
    if (state.maxGrowth != null) return state.maxGrowth;
    const all  = [...(state.stocks || []), ...Object.values(state.panels || {}).flat()];
    const vals = all.map(s => s.estYearGrowth).filter(g => g != null && g > 0);
    state.maxGrowth = vals.length ? Math.max(...vals) : 1;
    return state.maxGrowth;
}

// Maps estYearGrowth → hex color on a red–grey–green scale.
// negative → darker-to-brighter red, 0 → grey, positive → darker-to-brighter green.
// The stock with the highest estYearGrowth always gets the brightest green.
function getGrowthColor(growth) {
    if (growth == null || growth === 0) return '#888888';
    if (growth < 0) {
        const t = Math.min(Math.abs(growth) / 50, 1);
        return hslToHex(0, Math.round(55 + t * 45), Math.round(30 + t * 20));
    }
    const t = Math.min(growth / getGlobalMaxGrowth(), 1);
    return hslToHex(120, Math.round(40 + t * 60), Math.round(26 + t * 29));
}

const state = {
    stocks:  [],
    panels:  { shortlist: [], watchlist: [], marketcap: [] },
    prices:  {},
    dailyVol: {},
    charts:  {},
    volCharts: {},
    compareChart: null,
    view:    'grid',
    pollTimer: null,
    maxGrowth: null,   // cached result of getGlobalMaxGrowth(); null = stale
};

// ── Panel system ──────────────────────────────────────────────────────
const PANEL_DEFS = {
    shortlist: { title: 'High Short Interest', sub: 'S&P 500 · % of float',        accent: 'var(--red)',    apiUrl: '/api/shortlist' },
    watchlist: { title: 'S&P 500 Doublers',    sub: '≥100% gain · 12 months', accent: 'var(--yellow)', apiUrl: '/api/watchlist' },
    marketcap: { title: 'Top 20 by Mkt Cap',   sub: 'S&P 500 · largest companies', accent: 'var(--accent)', apiUrl: '/api/marketcap' },
};

function loadPanelConfig() {
    try { return JSON.parse(localStorage.getItem('tenx-panels')); } catch { return null; }
}
function savePanelConfig() {
    localStorage.setItem('tenx-panels', JSON.stringify(panelConfig));
}

const panelConfig = loadPanelConfig() || {
    columns:   { left: ['shortlist'], right: ['watchlist', 'marketcap'] },
    collapsed: {},
};

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const gridViewWrap = $('gridViewWrap');
const gridView     = $('gridView');
const compareView  = $('compareView');
const statusBanner = $('statusBanner');
const btnFetchAll  = $('btnFetchAll');
const btnGrid      = $('btnGrid');
const btnCompare   = $('btnCompare');

// ── Status banner ─────────────────────────────────────────────────────
function showStatus(msg, type = 'info', spin = false) {
    statusBanner.className = `status-banner ${type}`;
    statusBanner.innerHTML = '';
    if (spin) {
        const spinner = document.createElement('div');
        spinner.className = 'spinner-inline';
        statusBanner.appendChild(spinner);
    }
    const text = document.createElement('span');
    text.textContent = msg;
    statusBanner.appendChild(text);
}
function hideStatus() { statusBanner.classList.add('hidden'); }

// ── Format helpers ────────────────────────────────────────────────────
function fmt(n)   { return n == null ? '—' : '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function pct(n)   { if (n == null) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function cls(n)   { return n == null ? 'neutral' : n >= 0 ? 'positive' : 'negative'; }

// ── Compute 24M % change ──────────────────────────────────────────────
function calcChange(prices) {
    if (!prices || prices.length < 2) return null;
    const first = prices[0].close;
    const last  = prices[prices.length - 1].close;
    return ((last - first) / first) * 100;
}

// ── Update stats row ──────────────────────────────────────────────────
function updateStats() {
    const loaded = state.stocks.filter(s => state.prices[s.symbol]?.length > 0).length;
    $('statLoaded').textContent = `${loaded} / ${state.stocks.length}`;

    const changes = state.stocks
        .map(s => calcChange(state.prices[s.symbol]))
        .filter(c => c != null);

    if (changes.length > 0) {
        const best = Math.max(...changes);
        const avg  = changes.reduce((a,b)=>a+b,0) / changes.length;
        const bestEl = $('statBest');
        bestEl.textContent = pct(best);
        bestEl.className   = 'stat-val ' + cls(best);
        const avgEl = $('statAvg');
        avgEl.textContent  = pct(avg);
        avgEl.className    = 'stat-val ' + cls(avg);
    }

    const oldest = state.stocks
        .filter(s => state.prices[s.symbol]?.length > 0)
        .map(s => state.prices[s.symbol][0]?.date)
        .filter(Boolean)
        .sort()[0];

    if (oldest) {
        const d = new Date(oldest);
        $('statRange').textContent = d.toLocaleDateString('en-US', {month:'short', year:'numeric'}) + ' – now';
    }
}

// ── Build a chart card (no-data state) ───────────────────────────────
// ctx prefixes every element ID so the same symbol can appear in multiple
// sections without colliding — state.prices[symbol] remains a shared source.
function buildCard(stock, ctx = '') {
    const sid   = ctx + stock.symbol;          // scoped ID token
    const color = getGrowthColor(stock.estYearGrowth);
    const est1y = `Est. 1Y: <strong>${stock.estYearGrowth >= 0 ? '+' : ''}${stock.estYearGrowth}%</strong>`;
    const badgeClass = stock.shortPct    != null               ? 'badge-short'
                     : stock.gain12m    != null                ? 'badge-hot'
                     : stock.marketCapT != null                ? 'badge-marketcap'
                     : stock.isEtf                             ? 'badge-etf'
                     : stock.subIndustry.includes('Equipment') ? 'badge-equip'
                     : stock.subIndustry.includes('Storage')   ? 'badge-storage'
                     : 'badge-semi';
    const badgeLabel = stock.shortPct    != null               ? `${stock.shortPct}% Short`
                     : stock.gain12m    != null                ? `+${stock.gain12m}%`
                     : stock.marketCapT != null                ? `$${stock.marketCapT}T`
                     : stock.isEtf                             ? 'ETF'
                     : stock.subIndustry.includes('Equipment') ? 'Equip'
                     : stock.subIndustry.includes('Storage')   ? 'Storage'
                     : 'Semi';
    const subText = stock.shortPct    != null ? `&nbsp;Float &nbsp;·&nbsp; ${est1y}`
                  : stock.gain12m    != null  ? `&nbsp;12M &nbsp;·&nbsp; ${est1y}`
                  : stock.marketCapT != null  ? `&nbsp;Mkt Cap &nbsp;·&nbsp; ${est1y}`
                  :                            `&nbsp;${est1y}`;

    const freshnessColor = getFreshnessColor(stock);
    const staleNow       = isStaleFetch(stock);

    const card = document.createElement('div');
    card.className = 'chart-card';
    card.id = `card-${sid}`;
    card.style.borderTopColor = freshnessColor;
    card.style.borderTopWidth = '3px';

    card.innerHTML = `
        <div class="card-header">
            <div class="card-symbol-block">
                <span class="card-symbol" style="color:${color}">${stock.symbol}</span>
                <span class="card-name">${stock.name}</span>
                <span class="card-sub">
                    <span class="badge ${badgeClass}">${badgeLabel}</span>
                    ${subText}
                </span>
            </div>
            <div class="card-price-block">
                <div class="card-price" id="price-${sid}">—</div>
                <div class="card-change neutral" id="chg-${sid}">—</div>
                <div class="card-target neutral" id="target-${sid}"></div>
            </div>
        </div>
        <div id="body-${sid}">
            <div class="card-no-data">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><polyline points="7 16 11 12 14 15 20 9"/></svg>
                No data loaded
                <button class="fetch-btn" id="fetchBtn-${sid}">
                    Fetch ${stock.symbol}
                </button>
            </div>
        </div>
        <div id="vol-${sid}" class="vol-section hidden" data-symbol="${stock.symbol}" data-ctx="${ctx}"></div>
        <div id="stale-${sid}" class="card-stale-banner${staleNow ? '' : ' hidden'}">
            <span class="stale-age">${buildAgeText(stock)}</span>
            <button class="fetch-btn">
                ↻ Fetch ${stock.symbol}
            </button>
        </div>
        <div class="card-footer">
            <span id="range-${sid}">—</span>
            <span id="pts-${sid}"></span>
        </div>
        ${typeof buildAdvancedSection === 'function' ? buildAdvancedSection(stock, sid) : ''}
    `;

    card.querySelectorAll('.fetch-btn').forEach(btn =>
        btn.addEventListener('click', () => fetchOne(stock.symbol, ctx)));

    // Double-click anywhere on the card (but not on buttons/links) opens a floating copy
    card.addEventListener('dblclick', e => {
        if (e.target.closest('button, a, .adv-section, select, input')) return;
        if (typeof FloatingCards !== 'undefined') FloatingCards.open(stock, sid);
    });

    // Clicking the card body dismisses its notification dot
    card.addEventListener('click', e => {
        if (e.target.closest('button, a, input, select, .adv-section, .vol-section')) return;
        if (notifState.pendingDots.has(stock.symbol)) {
            notifState.pendingDots.delete(stock.symbol);
            updateCardNotifDots();
        }
    });

    const _existing = _cardsBySymbol.get(stock.symbol);
    _existing ? _existing.push(card) : _cardsBySymbol.set(stock.symbol, [card]);

    return card;
}

// ── Render chart inside a card ────────────────────────────────────────
function renderCardChart(symbol, ctx = '') {
    const allPrices = state.prices[symbol];
    if (!allPrices?.length) return;

    // Apply data-window setting (filter client-side from stored 24M)
    const windowMonths = (typeof settings !== 'undefined') ? settings.dataWindow : 24;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - windowMonths);
    const cutStr = cutoff.toISOString().split('T')[0];
    const prices = allPrices.filter(p => p.date >= cutStr);
    if (!prices.length) return;

    const sid   = ctx + symbol;
    const allStocks = [...state.stocks, ...Object.values(state.panels).flat()];
    const stock = allStocks.find(s => s.symbol === symbol);
    const color = getGrowthColor(stock?.estYearGrowth);
    const body  = $(`body-${sid}`);
    if (!body) return;

    if (state.charts[sid]) { state.charts[sid].destroy(); delete state.charts[sid]; }

    if (!_chartTypeCache.has(symbol))
        _chartTypeCache.set(symbol, localStorage.getItem(`chartType_${symbol}`) || 'mountain');
    const chartType = _chartTypeCache.get(symbol);
    const hasOhlc   = prices.some(p => p.open != null);

    // Chart-type selector injected into every canvas wrap
    const ctypeHtml = `<select class="card-chart-type" title="Chart type"
            onchange="changeChartType('${symbol}','${ctx}',this.value)">
        <option value="mountain"${chartType === 'mountain' ? ' selected' : ''}>Mountain</option>
        <option value="candle"${chartType === 'candle' ? ' selected' : ''}>Candle</option>
    </select>`;

    if (chartType === 'candle' && !hasOhlc) {
        // Candle selected but OHLC not yet fetched — prompt the user
        body.innerHTML = `<div class="card-canvas-wrap">
            ${ctypeHtml}
            <div class="card-no-data" style="height:var(--card-chart-height,180px)">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="7" y="6" width="3" height="9" rx="0.5"/><rect x="14" y="3" width="3" height="12" rx="0.5"/>
                    <line x1="8.5" y1="3" x2="8.5" y2="6"/><line x1="8.5" y1="15" x2="8.5" y2="19"/>
                    <line x1="15.5" y1="1" x2="15.5" y2="3"/><line x1="15.5" y1="15" x2="15.5" y2="18"/>
                </svg>
                No OHLC data — re-fetch to enable Candle view
                <button class="fetch-btn">Fetch ${symbol}</button>
            </div>
        </div>`;
        body.querySelector('.fetch-btn')?.addEventListener('click', () => fetchOne(symbol, ctx));
    } else {
        body.innerHTML = `<div class="card-canvas-wrap">${ctypeHtml}<canvas id="canvas-${sid}"></canvas></div>`;
        const canvas = $(`canvas-${sid}`);

        const sharedScales = {
            x: {
                type: 'time',
                time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
                grid:  { color: '#21262D' },
                ticks: { color: '#6E7681', maxTicksLimit: 8, maxRotation: 0 },
                border: { color: '#30363D' },
            },
            y: {
                grid:  { color: '#21262D' },
                ticks: { color: '#6E7681', callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)) },
                border: { color: '#30363D' },
            },
        };

        if (chartType === 'candle') {
            const candleData = prices
                .filter(p => p.open != null)
                .map(p => ({ x: new Date(p.date), o: p.open, h: p.high, l: p.low, c: p.close }));

            state.charts[sid] = new Chart(canvas, {
                type: 'candlestick',
                data: {
                    datasets: [{
                        data: candleData,
                        color:       { up: '#3FB950', down: '#F85149', unchanged: '#8B949E' },
                        borderColor: { up: '#3FB950', down: '#F85149', unchanged: '#8B949E' },
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#161B22',
                            borderColor: '#30363D',
                            borderWidth: 1,
                            titleColor: '#E6EDF3',
                            bodyColor: '#8B949E',
                            callbacks: {
                                title: items => new Date(items[0].parsed.x).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
                                label: item => {
                                    const p = item.raw;
                                    return p?.o != null
                                        ? [`O: $${p.o.toFixed(2)}`, `H: $${p.h.toFixed(2)}`, `L: $${p.l.toFixed(2)}`, `C: $${p.c.toFixed(2)}`]
                                        : [];
                                },
                            }
                        }
                    },
                    scales: sharedScales,
                }
            });
        } else {
            // Mountain (line + fill)
            const labels = prices.map(p => new Date(p.date));
            const values = prices.map(p => p.close);
            const doFill = (typeof settings !== 'undefined') ? settings.chartFill : true;

            state.charts[sid] = new Chart(canvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        borderColor: color,
                        backgroundColor: rgba(color, 0.1),
                        borderWidth: 1.5,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        fill: doFill,
                        tension: 0.1,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            backgroundColor: '#161B22',
                            borderColor: '#30363D',
                            borderWidth: 1,
                            titleColor: '#E6EDF3',
                            bodyColor: '#8B949E',
                            callbacks: {
                                title: items => new Date(items[0].parsed.x).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
                                label: item => `$${item.raw.toFixed(2)}`,
                            }
                        }
                    },
                    scales: sharedScales,
                }
            });
        }
    }

    // Update price / change labels (use close from last price row regardless of chart type)
    const last   = prices[prices.length - 1]?.close;
    const change = calcChange(prices);
    $(`price-${sid}`).textContent = fmt(last);
    const chgEl = $(`chg-${sid}`);
    chgEl.textContent = pct(change);
    chgEl.className   = 'card-change ' + cls(change);

    // 1-year target price
    if (stock?.estYearGrowth != null && last) {
        const targetPrice = last * (1 + stock.estYearGrowth / 100);
        const targetEl = $(`target-${sid}`);
        if (targetEl) {
            targetEl.textContent = `1Y: ${fmt(targetPrice)}`;
            targetEl.className   = 'card-target ' + cls(stock.estYearGrowth);
            targetEl.title       = `1-year target: ${fmt(targetPrice)} (${stock.estYearGrowth >= 0 ? '+' : ''}${stock.estYearGrowth}% estimate)`;
        }
    }

    // Footer
    const first   = prices[0].date;
    const end     = prices[prices.length - 1].date;
    const fmtDate = d => new Date(d).toLocaleDateString('en-US', {month:'short', year:'2-digit'});
    $(`range-${sid}`).textContent = `${fmtDate(first)} – ${fmtDate(end)}`;
    $(`pts-${sid}`).textContent   = `${prices.length} days`;

    // Volume chart section — shown for any stock that has volume data in state
    const hasVolData = (state.prices[symbol] || []).some(p => (p.volume || 0) > 0);
    if (hasVolData) {
        if (state.volCharts[sid]) { state.volCharts[sid].destroy(); delete state.volCharts[sid]; }
        const volSec = $(`vol-${sid}`);
        if (volSec) {
            volSec.innerHTML = `
                <div class="vol-section-hdr">
                    <button class="vol-toggle" onclick="toggleVolumeSection('${sid}')">
                        <span>Volume</span>
                        <svg class="vol-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                    <button class="vol-expand-btn" title="Open expanded volume chart" onclick="FloatingVolCards.open('${symbol}','${ctx}')">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                    </button>
                </div>
                <div class="vol-canvas-wrap hidden" id="vol-wrap-${sid}">
                    <canvas id="vol-canvas-${sid}"></canvas>
                </div>
                <div class="vol-model hidden" id="vol-model-${sid}"></div>`;
            volSec.classList.remove('hidden');
            delete volSec.dataset.rendered;
        }
    }

    updateCardFreshness(symbol, ctx);
}

function changeChartType(symbol, ctx, type) {
    localStorage.setItem(`chartType_${symbol}`, type);
    _chartTypeCache.set(symbol, type);
    renderCardChart(symbol, ctx);
}

// ── Volume chart ──────────────────────────────────────────────────────
function toggleVolumeSection(sid) {
    const volSec  = $(`vol-${sid}`);
    const wrap    = $(`vol-wrap-${sid}`);
    const modelEl = $(`vol-model-${sid}`);
    if (!wrap || !volSec) return;
    const opening = wrap.classList.contains('hidden');
    wrap.classList.toggle('hidden', !opening);
    if (modelEl) modelEl.classList.toggle('hidden', !opening);
    volSec.querySelector('.vol-chevron')?.classList.toggle('rotated', opening);
    if (opening) {
        if (!volSec.dataset.rendered) {
            volSec.dataset.rendered = '1';
            requestAnimationFrame(() =>
                doRenderVolumeChart(volSec.dataset.symbol, volSec.dataset.ctx || '')
            );
        } else {
            state.volCharts[sid]?.resize();
        }
    }
}

function doRenderVolumeChart(symbol, ctx) {
    _renderVolChart(symbol, ctx, state.prices[symbol], false);
}

function doRenderDailyVolChart(symbol, ctx) {
    _renderVolChart(symbol, ctx, state.dailyVol[symbol], true);
}

function _renderVolChart(symbol, ctx, allPrices, isDaily) {
    const sid    = (ctx || '') + symbol;
    const canvas = $(`vol-canvas-${sid}`);
    if (!canvas) return;
    if (!allPrices?.length) return;

    const windowMonths = typeof settings !== 'undefined' ? settings.dataWindow : 24;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - windowMonths);
    const cutStr = cutoff.toISOString().split('T')[0];
    const prices = allPrices.filter(p => p.date >= cutStr && (p.volume || 0) > 0);
    if (!prices.length) return;

    const allStocksArr = [...state.stocks, ...Object.values(state.panels).flat()];
    const stock   = allStocksArr.find(s => s.symbol === symbol);
    const upColor = rgba(getGrowthColor(stock?.estYearGrowth), 0.55);
    const dnColor = 'rgba(248,81,73,0.65)';

    const barColors = prices.map((p, i) =>
        i > 0 && p.close < prices[i - 1].close ? dnColor : upColor
    );

    const volData = prices.map(p => ({ x: new Date(p.date), y: p.volume / 1_000_000 }));
    const vols    = volData.map(p => p.y);

    // Median and population standard deviation
    const sorted  = [...vols].sort((a, b) => a - b);
    const mid     = Math.floor(sorted.length / 2);
    const medVol  = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const meanVol = vols.reduce((s, v) => s + v, 0) / vols.length;
    const stdVol  = Math.sqrt(vols.reduce((s, v) => s + (v - meanVol) ** 2, 0) / vols.length);
    const upperVol = medVol + stdVol;
    const lowerVol = Math.max(0, medVol - stdVol);

    const flat = y => prices.map(p => ({ x: new Date(p.date), y }));

    state.volCharts[sid]?.destroy();
    state.volCharts[sid] = new Chart(canvas, {
        type: 'bar',
        data: {
            datasets: [
                {
                    data: volData,
                    backgroundColor: barColors,
                    borderWidth: 0,
                    borderRadius: 0,
                    barPercentage: 1.0,
                    categoryPercentage: 1.0,
                    order: 3,
                },
                {
                    type: 'line',
                    data: flat(medVol),
                    borderColor: 'rgba(234,179,8,1)',
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 0,
                },
                {
                    type: 'line',
                    data: flat(upperVol),
                    borderColor: 'rgba(234,179,8,0.5)',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 1,
                },
                {
                    type: 'line',
                    data: flat(lowerVol),
                    borderColor: 'rgba(234,179,8,0.5)',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    order: 2,
                },
            ]
        },
        plugins: [{
            id: 'medGlow',
            beforeDatasetDraw(chart, args) {
                if (args.index !== 1) return;
                chart.ctx.save();
                chart.ctx.shadowColor = 'rgba(234,179,8,0.7)';
                chart.ctx.shadowBlur  = 10;
            },
            afterDatasetDraw(chart, args) {
                if (args.index !== 1) return;
                chart.ctx.restore();
            }
        }],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: '#161B22',
                    borderColor: '#30363D',
                    borderWidth: 1,
                    titleColor: '#E6EDF3',
                    bodyColor: '#8B949E',
                    callbacks: {
                        title: items => new Date(items[0].parsed.x).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
                        label: item => {
                            const v = item.raw.y.toFixed(1) + 'M';
                            if (item.datasetIndex === 0) return `Vol: ${v}`;
                            if (item.datasetIndex === 1) return `Med: ${v}`;
                            if (item.datasetIndex === 2) return `+1σ: ${v}`;
                            return `−1σ: ${v}`;
                        },
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: isDaily
                        ? { unit: 'week', displayFormats: { week: 'MMM d' } }
                        : { unit: 'month', displayFormats: { month: 'MMM yy' } },
                    grid:  { display: false },
                    ticks: {
                        display: isDaily,
                        color: '#6E7681',
                        maxTicksLimit: 8,
                        font: { size: 10 },
                    },
                    border: { color: '#30363D' },
                },
                y: {
                    position: 'right',
                    grid:   { color: '#21262D' },
                    ticks:  {
                        color: '#6E7681',
                        maxTicksLimit: 3,
                        callback: v => v >= 1 ? v.toFixed(0) + 'M' : (v * 1000).toFixed(0) + 'K',
                    },
                    border: { color: '#30363D' },
                }
            }
        }
    });

    renderVolumeModel(sid, prices, medVol, stdVol);
}

// ── Volume signal model ───────────────────────────────────────────────
function renderVolumeModel(sid, prices, medVol, stdVol) {
    const el = $(`vol-model-${sid}`);
    if (!el) return;

    const upperBand = medVol + stdVol;
    const lowerBand = Math.max(0, medVol - stdVol);
    const highSigs  = [];
    const lowSigs   = [];

    for (let i = 0; i < prices.length - 1; i++) {
        const vol = (prices[i].volume || 0) / 1_000_000;
        if (vol <= 0) continue;
        const isHigh = vol > upperBand;
        const isLow  = lowerBand > 0 && vol < lowerBand;
        if (!isHigh && !isLow) continue;
        const fwds = [1, 2, 4].map(nw => {
            const fi = Math.min(i + nw, prices.length - 1);
            return fi > i ? (prices[fi].close - prices[i].close) / prices[i].close : null;
        });
        if (isHigh) highSigs.push(fwds);
        if (isLow)  lowSigs.push(fwds);
    }

    function medOf(vals) {
        const c = vals.filter(v => v != null);
        if (!c.length) return null;
        const s = [...c].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function fmtPct(v) {
        if (v == null) return '—';
        return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
    }

    function buildRow(sigs, label) {
        if (!sigs.length) return `
            <div class="vol-model-row">
                <span class="vol-model-lbl">${label}</span>
                <span class="vol-model-empty">no signals in window</span>
            </div>`;
        const m = [0, 1, 2].map(i => medOf(sigs.map(s => s[i])));
        const cls = v => v == null ? '' : v >= 0 ? 'positive' : 'negative';
        return `
            <div class="vol-model-row">
                <span class="vol-model-lbl">${label}</span>
                <span class="vol-model-n">n=${sigs.length}</span>
                <span class="vol-model-fwds">
                    <span class="vol-model-fwd ${cls(m[0])}">+1w ${fmtPct(m[0])}</span>
                    <span class="vol-model-fwd ${cls(m[1])}">+2w ${fmtPct(m[1])}</span>
                    <span class="vol-model-fwd ${cls(m[2])}">+4w ${fmtPct(m[2])}</span>
                </span>
            </div>`;
    }

    el.innerHTML = `
        <div class="vol-model-hdr">
            <span>Vol Signal Model</span>
            <span class="vol-model-note">median fwd return · weekly</span>
        </div>
        ${buildRow(highSigs, 'High vol (&gt;+1σ)')}
        ${buildRow(lowSigs,  'Low vol (&lt;−1σ)')}`;
}

// ── Compare chart ─────────────────────────────────────────────────────
function renderCompareChart() {
    const canvas = $('compareCanvas');
    if (state.compareChart) { state.compareChart.destroy(); state.compareChart = null; }

    const loaded = state.stocks.filter(s => state.prices[s.symbol]?.length > 0);
    if (loaded.length === 0) {
        $('compareLegend').innerHTML = '<span style="color:var(--text3)">No data loaded yet — fetch stocks first.</span>';
        return;
    }

    const winMonths = (typeof settings !== 'undefined') ? settings.dataWindow : 24;
    const winCutoff = new Date();
    winCutoff.setMonth(winCutoff.getMonth() - winMonths);
    const winCutStr = winCutoff.toISOString().split('T')[0];

    const datasets = loaded.map(stock => {
        const prices = state.prices[stock.symbol].filter(p => p.date >= winCutStr);
        if (!prices.length) return null;
        const base   = prices[0].close;
        const data   = prices.map(p => ({ x: new Date(p.date), y: (p.close / base) * 100 }));
        const color  = getGrowthColor(stock.estYearGrowth);
        const isEtf  = stock.isEtf;
        return {
            label: stock.symbol,
            data,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: isEtf ? 2.5 : 1.5,
            borderDash: isEtf ? [8, 4] : undefined,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.1,
            order: isEtf ? 0 : 1,
        };
    }).filter(Boolean);

    state.compareChart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#161B22',
                    borderColor: '#30363D',
                    borderWidth: 1,
                    titleColor: '#E6EDF3',
                    bodyColor: '#8B949E',
                    callbacks: {
                        title: items => {
                            const d = new Date(items[0].parsed.x);
                            return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
                        },
                        label: item => `${item.dataset.label}: ${item.raw.y.toFixed(1)}  (${item.raw.y >= 100 ? '+' : ''}${(item.raw.y-100).toFixed(1)}%)`,
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
                    grid:  { color: '#21262D' },
                    ticks: { color: '#6E7681', maxTicksLimit: 10, maxRotation: 0 },
                    border: { color: '#30363D' },
                },
                y: {
                    grid:  { color: '#21262D' },
                    ticks: {
                        color: '#6E7681',
                        callback: v => v.toFixed(0)
                    },
                    border: { color: '#30363D' },
                    title: {
                        display: true,
                        text: 'Normalized (base 100)',
                        color: '#6E7681',
                        font: { size: 11 }
                    }
                }
            }
        }
    });

    // Legend
    $('compareLegend').innerHTML = loaded.map(stock => {
        const change = calcChange(state.prices[stock.symbol]);
        const color  = getGrowthColor(stock.estYearGrowth);
        const swatchStyle = stock.isEtf
            ? `background:transparent;border-bottom:2.5px dashed ${color};`
            : `background:${color};`;
        const etfBadge = stock.isEtf
            ? `<span class="badge badge-etf" style="font-size:9px;padding:1px 5px">ETF</span>`
            : '';
        return `
            <div class="legend-item">
                <div class="legend-swatch" style="${swatchStyle}"></div>
                <span style="color:${color};font-weight:600">${stock.symbol}</span>
                ${etfBadge}
                <span style="color:var(--text3)">${stock.name}</span>
                <span class="${cls(change)}">${pct(change)}</span>
            </div>`;
    }).join('');
}

// ── Fetch a single stock ──────────────────────────────────────────────
async function fetchOne(symbol, ctx = '') {
    const sid = ctx + symbol;
    const btn = $(`fetchBtn-${sid}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
    showStatus(`Fetching ${symbol} from Alpha Vantage…`, 'info', true);

    try {
        const res = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        updateStockFetchLog(symbol, data.count);
        await loadPrices(symbol);
        renderCardChart(symbol, ctx);
        updateStats();
        if (state.view === 'compare') renderCompareChart();
        showStatus(`${symbol} loaded — ${data.count} trading days`, 'success');
        setTimeout(hideStatus, 3000);
    } catch (err) {
        showStatus(`Failed to fetch ${symbol}: ${err.message}`, 'error');
        if (btn) { btn.disabled = false; btn.textContent = `Retry ${symbol}`; }
    }
}

// ── Fetch all stocks ──────────────────────────────────────────────────
async function fetchAll() {
    btnFetchAll.disabled = true;
    showStatus(`Queuing all ${state.stocks.length} stocks — ~${Math.ceil(state.stocks.length * 13 / 60)} min to complete (rate limit: 5 req/min)…`, 'info', true);

    try {
        const res  = await fetch('/api/fetch-all', { method: 'POST' });
        const data = await res.json();
        showStatus(data.message, 'info', true);
        startPolling();
    } catch (err) {
        showStatus('Failed to start fetch: ' + err.message, 'error');
        btnFetchAll.disabled = false;
    }
}

// ── Poll for newly available data ─────────────────────────────────────
function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
        await refreshStockStatus();
        const allLoaded = state.stocks.every(s => state.prices[s.symbol]?.length > 0);
        if (allLoaded) {
            stopPolling();
            showStatus(`All ${state.stocks.length} stocks loaded!`, 'success');
            setTimeout(hideStatus, 4000);
            btnFetchAll.disabled = false;
        }
    }, 8000);
}

function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function refreshStockStatus() {
    const res  = await fetch('/api/stocks');
    const data = await res.json();

    const toLoad = data.stocks.filter(s => s.hasData && !state.prices[s.symbol]?.length);
    await Promise.all(toLoad.map(async s => {
        await loadPrices(s.symbol);
        renderCardChart(s.symbol);
    }));
    updateStats();
    if (state.view === 'compare') renderCompareChart();
}

// ── Load prices for a symbol from API ────────────────────────────────
const _priceInflight = new Map();

async function loadPrices(symbol) {
    if (_priceInflight.has(symbol)) return _priceInflight.get(symbol);
    const req = fetch(`/api/prices?symbol=${symbol}`)
        .then(r => r.json())
        .then(data => { state.prices[symbol] = data.prices || []; })
        .finally(() => _priceInflight.delete(symbol));
    _priceInflight.set(symbol, req);
    return req;
}

// ── View toggle ───────────────────────────────────────────────────────
btnGrid.addEventListener('click', () => {
    state.view = 'grid';
    btnGrid.classList.add('active');
    btnCompare.classList.remove('active');
    if (typeof btnModels !== 'undefined') btnModels.classList.remove('active');
    gridViewWrap.classList.remove('hidden');
    compareView.classList.add('hidden');
    document.getElementById('modelsView').classList.add('hidden');
});

btnCompare.addEventListener('click', () => {
    state.view = 'compare';
    btnCompare.classList.add('active');
    btnGrid.classList.remove('active');
    btnModels.classList.remove('active');
    compareView.classList.remove('hidden');
    gridViewWrap.classList.add('hidden');
    document.getElementById('modelsView').classList.add('hidden');
    renderCompareChart();
});

const btnModels = $('btnModels');
btnModels.addEventListener('click', () => {
    state.view = 'models';
    btnModels.classList.add('active');
    btnGrid.classList.remove('active');
    btnCompare.classList.remove('active');
    document.getElementById('modelsView').classList.remove('hidden');
    gridViewWrap.classList.add('hidden');
    compareView.classList.add('hidden');
    ModelView.init();
});

btnFetchAll.addEventListener('click', fetchAll);

// ── Panel system: fetch / render / collapse / drag-drop ───────────────


async function loadPanelData(name) {
    const def = PANEL_DEFS[name];
    try {
        const res  = await fetch(def.apiUrl);
        const data = await res.json();
        state.panels[name] = data[name] || [];
        // Extend maxGrowth to cover panel stocks without a full rescan
        const panelMax = state.panels[name].reduce((mx, s) =>
            (s.estYearGrowth != null && s.estYearGrowth > mx) ? s.estYearGrowth : mx, state.maxGrowth || 1);
        state.maxGrowth = panelMax;
        await Promise.all(state.panels[name].filter(s => s.hasData).map(s => loadPrices(s.symbol)));
    } catch { state.panels[name] = []; }
}

function renderPanelCards(name) {
    const grid = $(`panel-grid-${name}`);
    if (!grid) return;
    const ctx = name + '_';           // e.g. 'marketcap_' — scopes all IDs for this panel

    // Remove this panel's old card elements from the lookup map before clearing DOM
    for (const stock of (state.panels[name] || [])) {
        const cards = _cardsBySymbol.get(stock.symbol);
        if (cards) {
            const remaining = cards.filter(c => !grid.contains(c));
            remaining.length ? _cardsBySymbol.set(stock.symbol, remaining) : _cardsBySymbol.delete(stock.symbol);
        }
    }
    grid.innerHTML = '';
    for (const stock of (state.panels[name] || [])) {
        grid.appendChild(buildCard(stock, ctx));
    }
    for (const stock of (state.panels[name] || [])) {
        if (state.prices[stock.symbol]?.length > 0) renderCardChart(stock.symbol, ctx);
    }
    updateCardNotifDots();
}

function buildPanelWidget(name) {
    const def       = PANEL_DEFS[name];
    const collapsed = !!panelConfig.collapsed[name];
    const widget    = document.createElement('div');
    widget.className   = 'panel-widget';
    widget.id          = `pw-${name}`;
    widget.dataset.panel = name;

    widget.innerHTML = `
        <div class="panel-widget-header" style="border-left-color:${def.accent}">
            <div class="panel-drag-handle" title="Drag to move panel">⠿</div>
            <div class="panel-widget-titleblock">
                <span class="panel-widget-title">${def.title}</span>
                <span class="panel-widget-sub">${def.sub}</span>
            </div>
            <button class="panel-collapse-btn" title="${collapsed ? 'Expand' : 'Collapse'}"
                    onclick="togglePanelCollapse('${name}')">${collapsed ? '▶' : '▾'}</button>
        </div>
        <div class="panel-widget-body${collapsed ? ' hidden' : ''}" id="pw-body-${name}">
            <div class="panel-card-grid" id="panel-grid-${name}"></div>
        </div>`;

    const body = widget.querySelector('.panel-widget-body');
    if (body) makeResizableY(body, { prop: 'maxHeight', min: 80, storageKey: `tenx-pw-${name}-h` });
    setupWidgetDrag(widget);
    return widget;
}

function renderPanels() {
    const leftCol  = $('leftCol');
    const rightCol = $('rightCol');
    if (!leftCol || !rightCol) return;
    leftCol.innerHTML  = '';
    rightCol.innerHTML = '';

    for (const name of (panelConfig.columns.left  || [])) leftCol.appendChild(buildPanelWidget(name));
    for (const name of (panelConfig.columns.right || [])) rightCol.appendChild(buildPanelWidget(name));

    updateEmptyColumns();
}

// Called once — attaches drop-zone listeners to the two fixed column containers.
// Must NOT be called inside renderPanels() or listeners accumulate on every drop.
function setupDropZones() {
    setupColumnDrop($('leftCol'),  'left');
    setupColumnDrop($('rightCol'), 'right');
}

function togglePanelCollapse(name) {
    panelConfig.collapsed[name] = !panelConfig.collapsed[name];
    savePanelConfig();
    const body = $(`pw-body-${name}`);
    const btn  = document.querySelector(`#pw-${name} .panel-collapse-btn`);
    if (body) body.classList.toggle('hidden', !!panelConfig.collapsed[name]);
    if (btn)  { btn.textContent = panelConfig.collapsed[name] ? '▶' : '▾';
                btn.title       = panelConfig.collapsed[name] ? 'Expand' : 'Collapse'; }
}

// ── Drag-and-drop ─────────────────────────────────────────────────────
let _draggingPanel = null;

function setupWidgetDrag(widget) {
    widget.draggable = true;
    // Track whether the drag started from the grip handle.
    // e.target in 'dragstart' is always the draggable element itself, not the
    // child that was clicked, so we capture intent via pointerdown instead.
    let _fromHandle = false;
    widget.addEventListener('pointerdown', e => {
        _fromHandle = !!e.target.closest('.panel-drag-handle');
    });
    widget.addEventListener('dragstart', e => {
        if (!_fromHandle) { e.preventDefault(); return; }
        _draggingPanel = widget.dataset.panel;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', _draggingPanel);
        setTimeout(() => widget.classList.add('dragging'), 0);
    });
    widget.addEventListener('dragend', () => {
        widget.classList.remove('dragging');
        _fromHandle   = false;
        _draggingPanel = null;
        document.querySelectorAll('.drop-line').forEach(el => el.remove());
        document.querySelectorAll('.panel-col').forEach(c => c.classList.remove('drag-over'));
    });
}

function setupColumnDrop(col, colName) {
    col.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
        document.querySelectorAll('.drop-line').forEach(el => el.remove());
        const afterEl = getDragTarget(col, e.clientY);
        const line    = document.createElement('div');
        line.className = 'drop-line';
        if (afterEl) col.insertBefore(line, afterEl);
        else         col.appendChild(line);
    });
    col.addEventListener('dragleave', e => {
        if (!col.contains(e.relatedTarget)) {
            col.classList.remove('drag-over');
            document.querySelectorAll('.drop-line').forEach(el => el.remove());
        }
    });
    col.addEventListener('drop', e => {
        e.preventDefault();
        col.classList.remove('drag-over');
        document.querySelectorAll('.drop-line').forEach(el => el.remove());
        if (!_draggingPanel) return;

        const name    = _draggingPanel;
        const other   = colName === 'left' ? 'right' : 'left';
        panelConfig.columns[other]   = (panelConfig.columns[other]   || []).filter(n => n !== name);
        panelConfig.columns[colName] = (panelConfig.columns[colName] || []).filter(n => n !== name);

        const afterEl   = getDragTarget(col, e.clientY);
        const afterName = afterEl?.dataset?.panel;
        if (afterName) {
            const idx = panelConfig.columns[colName].indexOf(afterName);
            panelConfig.columns[colName].splice(idx < 0 ? panelConfig.columns[colName].length : idx, 0, name);
        } else {
            panelConfig.columns[colName].push(name);
        }

        savePanelConfig();

        // Move the existing widget node into position — no rebuild, charts survive
        const widget = $(`pw-${name}`);
        if (widget) {
            if (afterEl) col.insertBefore(widget, afterEl);
            else         col.appendChild(widget);
        }
        updateEmptyColumns();
    });
}

function getDragTarget(col, y) {
    const widgets = [...col.querySelectorAll('.panel-widget:not(.dragging)')];
    let closest = null, closestDist = Infinity;
    for (const w of widgets) {
        const rect = w.getBoundingClientRect();
        const dist = y - (rect.top + rect.height / 2);
        if (dist < 0 && Math.abs(dist) < closestDist) { closestDist = Math.abs(dist); closest = w; }
    }
    return closest;
}

function updateEmptyColumns() {
    for (const id of ['leftCol', 'rightCol']) {
        const col = $(id);
        if (!col) continue;
        col.classList.toggle('col-empty', col.querySelectorAll('.panel-widget').length === 0);
    }
}

// ── Notifications ─────────────────────────────────────────────────────
const notifState = { data: [], pendingDots: new Set(), maxSeenId: 0 };
const _cardsBySymbol  = new Map(); // symbol → card[] for fast notification dot updates
const _chartTypeCache = new Map(); // symbol → 'mountain'|'candle' (persisted to localStorage)

async function loadNotifications() {
    try {
        const r = await fetch('/api/notifications');
        const d = await r.json();
        const incoming  = d.notifications || [];
        const firstLoad = notifState.maxSeenId === 0;
        for (const n of incoming) {
            const isNew = n.id > notifState.maxSeenId;
            if (firstLoad ? !n.read : isNew)
                for (const sym of (n.symbols || [])) notifState.pendingDots.add(sym);
        }
        if (incoming.length)
            notifState.maxSeenId = Math.max(notifState.maxSeenId, ...incoming.map(n => n.id));
        notifState.data = incoming;
        updateNotifBadge();
        updateNotifPanel();
        updateCardNotifDots();
    } catch { /* silently ignore */ }
}

function updateNotifBadge() {
    const badge = $('notifBadge');
    if (!badge) return;
    const unread = notifState.data.filter(n => !n.read).length;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
}

function updateNotifPanel() {
    const list = $('notifList');
    if (!list) return;
    if (!notifState.data.length) {
        list.innerHTML = '<div class="notif-empty">No Signal chats sent yet.</div>';
        return;
    }
    list.innerHTML = notifState.data.map(n => {
        const d       = new Date(n.created_at.includes('T') ? n.created_at : n.created_at.replace(' ','T') + 'Z');
        const timeStr = d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        const chips   = (n.symbols || []).map(s => `<span class="notif-sym-chip">${s}</span>`).join('');
        const msgHtml = n.message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<div class="notif-item${n.read ? '' : ' notif-unread'}">
            <div class="notif-item-hdr">
                <span class="notif-type notif-type-${n.type}">${n.type === 'bell' ? 'Market Open' : 'Market Close'}</span>
                <span class="notif-time">${timeStr}</span>
            </div>
            ${chips ? `<div class="notif-syms">${chips}</div>` : ''}
            <div class="notif-msg">${msgHtml}</div>
        </div>`;
    }).join('');
}

function updateCardNotifDots() {
    for (const [sym, cards] of _cardsBySymbol) {
        const pending = notifState.pendingDots.has(sym);
        for (const card of cards) {
            const symEl = card.querySelector('.card-symbol');
            if (!symEl) continue;

            symEl.querySelector('.card-notif-dot')?.remove();
            if (pending)
                symEl.insertAdjacentHTML('beforeend',
                    '<span class="card-notif-dot" title="Mentioned in recent Signal chat"></span>');

            card.querySelector('.adv-enable-btn-wrap')?.remove();
            if (pending && !(settings.advancedStocks || []).includes(sym)) {
                const wrap = document.createElement('div');
                wrap.className = 'adv-enable-btn-wrap';
                wrap.innerHTML = `<button class="adv-enable-btn">Enable Advanced Analysis for ${sym}</button>`;
                wrap.querySelector('button').addEventListener('click', e => {
                    e.stopPropagation();
                    if (typeof setAdvancedEnabled === 'function') setAdvancedEnabled(sym, true);
                    wrap.remove();
                    updateCardNotifDots();
                });
                const advSec = card.querySelector('.adv-section');
                advSec ? card.insertBefore(wrap, advSec) : card.appendChild(wrap);
            }

            if (typeof updateAdvSignalForCard === 'function') updateAdvSignalForCard(card, sym);
        }
    }
}

async function markNotificationsRead() {
    try {
        await fetch('/api/notifications/read', { method: 'POST' });
        notifState.data.forEach(n => { n.read = 1; });
        updateNotifBadge();
        updateNotifPanel();
        // Card dots persist until the card is clicked — intentionally not cleared here
    } catch { /* silently ignore */ }
}

function startNotifPolling() {
    loadNotifications();
    setInterval(loadNotifications, 30000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadNotifications();
    });
    const btn = $('btnNotif');
    if (btn) {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const panel   = $('notifPanel');
            const opening = panel.classList.contains('hidden');
            panel.classList.toggle('hidden', !opening);
            btn.classList.toggle('active', opening);
            if (opening) markNotificationsRead();
        });
    }
    $('notifMarkRead')?.addEventListener('click', markNotificationsRead);
    document.addEventListener('click', e => {
        if (!$('notifWrap')?.contains(e.target)) {
            $('notifPanel')?.classList.add('hidden');
            $('btnNotif')?.classList.remove('active');
        }
    });
}

// ── Resizable height containers ────────────────────────────────────────
// Right-click + drag the bottom edge of a container to resize its height.
// prop: CSS property to set ('maxHeight' or 'height')
// Sizes persist across page loads via localStorage when storageKey is given.
function makeResizableY(el, { prop = 'maxHeight', min = 100, storageKey = null } = {}) {
    if (!el || el.dataset.resizableY) return;
    el.dataset.resizableY = '1';

    if (storageKey) {
        const saved = localStorage.getItem(storageKey);
        if (saved) el.style[prop] = saved + 'px';
    }

    const ZONE = 10;

    el.addEventListener('mousemove', e => {
        if (document.body.classList.contains('is-resizing-y')) return;
        const r = el.getBoundingClientRect();
        el.style.cursor = e.clientY >= r.bottom - ZONE ? 'ns-resize' : '';
    });

    el.addEventListener('mouseleave', () => {
        if (!document.body.classList.contains('is-resizing-y')) el.style.cursor = '';
    });

    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        if (e.clientY < r.bottom - ZONE || r.height < 1) return;

        e.preventDefault();

        const startY = e.clientY, startVal = r.height;
        let moved = false;

        document.body.classList.add('is-resizing-y');

        const onMove = ev => {
            moved = true;
            el.style[prop] = Math.max(min, startVal + (ev.clientY - startY)) + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.classList.remove('is-resizing-y');
            el.style.cursor = '';
            if (moved) {
                requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
                if (storageKey) {
                    const v = parseInt(el.style[prop]);
                    if (!isNaN(v)) localStorage.setItem(storageKey, String(v));
                }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
    $('footerDate').textContent = new Date().toLocaleDateString('en-US', { dateStyle: 'medium' });
    showStatus('Loading stock list…', 'info', true);

    let data;
    try {
        const res = await fetch('/api/stocks');
        data = await res.json();
    } catch {
        showStatus('Cannot reach server. Is it running?', 'error');
        return;
    }

    state.stocks    = data.stocks;
    state.maxGrowth = null;   // invalidate cached max so colors recompute
    $('statTotal').textContent = state.stocks.length;

    _cardsBySymbol.clear();
    gridView.innerHTML = '';
    for (const stock of state.stocks) gridView.appendChild(buildCard(stock));

    const priceLoads = state.stocks.filter(s => s.hasData).map(s => loadPrices(s.symbol));
    await Promise.all(priceLoads);
    for (const stock of state.stocks) {
        if (state.prices[stock.symbol]?.length > 0) renderCardChart(stock.symbol);
    }

    updateStats();

    // Render panel column structure, then wire up drop zones once
    renderPanels();
    setupDropZones();
    makeResizableY($('leftCol'),  { prop: 'maxHeight', min: 120, storageKey: 'tenx-lc-h' });
    makeResizableY($('rightCol'), { prop: 'maxHeight', min: 120, storageKey: 'tenx-rc-h' });
    makeResizableY(document.querySelector('.compare-chart-wrap'), { prop: 'height', min: 200, storageKey: 'tenx-cmp-h' });
    const allPanels = [...(panelConfig.columns.left || []), ...(panelConfig.columns.right || [])];
    for (const name of allPanels) {
        loadPanelData(name).then(() => renderPanelCards(name));
    }

    const loaded = state.stocks.filter(s => state.prices[s.symbol]?.length > 0).length;
    if (loaded === state.stocks.length) {
        hideStatus();
    } else if (loaded === 0) {
        showStatus(`No data yet — click "Fetch All Data" to load all ${state.stocks.length} stocks from Alpha Vantage.`, 'info');
    } else {
        showStatus(`${loaded} of ${state.stocks.length} stocks loaded. Click "Fetch All Data" to get the rest.`, 'info');
    }

    startNotifPolling();
}

init();
