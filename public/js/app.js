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
    SMH:  '#FFDD57',
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

// hex → rgba helper
function rgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
}

const state = {
    stocks:  [],
    panels:  { shortlist: [], watchlist: [], marketcap: [] },
    prices:  {},
    charts:  {},
    compareChart: null,
    view:    'grid',
    pollTimer: null,
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
    statusBanner.innerHTML = spin
        ? `<div class="spinner-inline"></div><span>${msg}</span>`
        : msg;
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
function buildCard(stock) {
    const color = COLORS[stock.symbol] || '#58A6FF';
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

    const card = document.createElement('div');
    card.className = 'chart-card';
    card.id = `card-${stock.symbol}`;
    card.style.borderTopColor = color;
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
                <div class="card-price" id="price-${stock.symbol}">—</div>
                <div class="card-change neutral" id="chg-${stock.symbol}">—</div>
                <div class="card-target neutral" id="target-${stock.symbol}"></div>
            </div>
        </div>
        <div id="body-${stock.symbol}">
            <div class="card-no-data">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><polyline points="7 16 11 12 14 15 20 9"/></svg>
                No data loaded
                <button class="fetch-btn" id="fetchBtn-${stock.symbol}" onclick="fetchOne('${stock.symbol}')">
                    Fetch ${stock.symbol}
                </button>
            </div>
        </div>
        <div class="card-footer">
            <span id="range-${stock.symbol}">—</span>
            <span id="pts-${stock.symbol}"></span>
        </div>
    `;
    return card;
}

// ── Render chart inside a card ────────────────────────────────────────
function renderCardChart(symbol) {
    const prices = state.prices[symbol];
    if (!prices?.length) return;

    const color = COLORS[symbol] || '#58A6FF';
    const body  = $(`body-${symbol}`);

    // Replace no-data content with canvas
    body.innerHTML = `<div class="card-canvas-wrap"><canvas id="canvas-${symbol}"></canvas></div>`;
    const canvas = $(`canvas-${symbol}`);

    // Destroy old chart if exists
    if (state.charts[symbol]) { state.charts[symbol].destroy(); }

    const labels = prices.map(p => new Date(p.date));
    const values = prices.map(p => p.close);

    state.charts[symbol] = new Chart(canvas, {
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
                fill: true,
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
                        title: items => {
                            const d = new Date(items[0].label);
                            return d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
                        },
                        label: item => `$${item.raw.toFixed(2)}`,
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', displayFormats: { month: 'MMM yy' } },
                    grid:  { color: '#21262D' },
                    ticks: { color: '#6E7681', maxTicksLimit: 8, maxRotation: 0 },
                    border: { color: '#30363D' },
                },
                y: {
                    grid:  { color: '#21262D' },
                    ticks: {
                        color: '#6E7681',
                        callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0))
                    },
                    border: { color: '#30363D' },
                }
            }
        }
    });

    // Update price / change labels
    const last   = values[values.length - 1];
    const change = calcChange(prices);
    $(`price-${symbol}`).textContent = fmt(last);
    const chgEl = $(`chg-${symbol}`);
    chgEl.textContent = pct(change);
    chgEl.className   = 'card-change ' + cls(change);

    // 1-year target price
    const stock = state.stocks.find(s => s.symbol === symbol);
    if (stock?.estYearGrowth != null && last) {
        const targetPrice = last * (1 + stock.estYearGrowth / 100);
        const targetEl = $(`target-${symbol}`);
        if (targetEl) {
            targetEl.textContent = `1Y: ${fmt(targetPrice)}`;
            targetEl.className = 'card-target ' + cls(stock.estYearGrowth);
            targetEl.title = `1-year target: ${fmt(targetPrice)} (${stock.estYearGrowth >= 0 ? '+' : ''}${stock.estYearGrowth}% estimate)`;
        }
    }

    // Footer
    const first = prices[0].date;
    const end   = prices[prices.length-1].date;
    const fmtDate = d => new Date(d).toLocaleDateString('en-US',{month:'short',year:'2-digit'});
    $(`range-${symbol}`).textContent = `${fmtDate(first)} – ${fmtDate(end)}`;
    $(`pts-${symbol}`).textContent   = `${prices.length} days`;
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

    const datasets = loaded.map(stock => {
        const prices = state.prices[stock.symbol];
        const base   = prices[0].close;
        const data   = prices.map(p => ({ x: new Date(p.date), y: (p.close / base) * 100 }));
        const color  = COLORS[stock.symbol] || '#58A6FF';
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
    });

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
                            const d = new Date(items[0].label);
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
        const color  = COLORS[stock.symbol] || '#58A6FF';
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
async function fetchOne(symbol) {
    const btn = $(`fetchBtn-${symbol}`);
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

        await loadPrices(symbol);
        renderCardChart(symbol);
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

    for (const stock of data.stocks) {
        if (stock.hasData && !state.prices[stock.symbol]?.length) {
            await loadPrices(stock.symbol);
            renderCardChart(stock.symbol);
        }
    }
    updateStats();
    if (state.view === 'compare') renderCompareChart();
}

// ── Load prices for a symbol from API ────────────────────────────────
async function loadPrices(symbol) {
    const res  = await fetch(`/api/prices?symbol=${symbol}`);
    const data = await res.json();
    state.prices[symbol] = data.prices || [];
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

async function fetchPanelOne(symbol) {
    const btn = $(`fetchBtn-${symbol}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
    showStatus(`Fetching ${symbol}…`, 'info', true);
    try {
        const res = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        await loadPrices(symbol);
        renderCardChart(symbol);
        showStatus(`${symbol} loaded — ${data.count} data points`, 'success');
        setTimeout(hideStatus, 3000);
    } catch (err) {
        showStatus(`Failed to fetch ${symbol}: ${err.message}`, 'error');
        if (btn) { btn.disabled = false; btn.textContent = `Retry ${symbol}`; }
    }
}

async function loadPanelData(name) {
    const def = PANEL_DEFS[name];
    try {
        const res  = await fetch(def.apiUrl);
        const data = await res.json();
        state.panels[name] = data[name] || [];
        await Promise.all(state.panels[name].filter(s => s.hasData).map(s => loadPrices(s.symbol)));
    } catch { state.panels[name] = []; }
}

function renderPanelCards(name) {
    const grid = $(`panel-grid-${name}`);
    if (!grid) return;
    grid.innerHTML = '';
    for (const stock of (state.panels[name] || [])) {
        const card = buildCard(stock);
        const btn  = card.querySelector('.fetch-btn');
        if (btn) btn.setAttribute('onclick', `fetchPanelOne('${stock.symbol}')`);
        grid.appendChild(card);
    }
    for (const stock of (state.panels[name] || [])) {
        if (state.prices[stock.symbol]?.length > 0) renderCardChart(stock.symbol);
    }
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
        renderPanels();
        for (const n of [...(panelConfig.columns.left || []), ...(panelConfig.columns.right || [])]) {
            renderPanelCards(n);
        }
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

    state.stocks = data.stocks;
    $('statTotal').textContent = state.stocks.length;

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
}

init();
