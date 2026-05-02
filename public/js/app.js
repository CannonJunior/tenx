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
};

// hex → rgba helper
function rgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
}

const state = {
    stocks: [],
    prices: {},      // { symbol: [{date, close}] }
    charts: {},      // Chart.js instances
    compareChart: null,
    view: 'grid',    // 'grid' | 'compare'
    pollTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const gridView    = $('gridView');
const compareView = $('compareView');
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
    const badgeClass = stock.subIndustry.includes('Equipment') ? 'badge-equip'
                     : stock.subIndustry.includes('Storage')   ? 'badge-storage'
                     : 'badge-semi';
    const badgeLabel = stock.subIndustry.includes('Equipment') ? 'Equip'
                     : stock.subIndustry.includes('Storage')   ? 'Storage'
                     : 'Semi';

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
                    &nbsp;Est. 1Y: <strong>${stock.estYearGrowth >= 0 ? '+' : ''}${stock.estYearGrowth}%</strong>
                </span>
            </div>
            <div class="card-price-block">
                <div class="card-price" id="price-${stock.symbol}">—</div>
                <div class="card-change neutral" id="chg-${stock.symbol}">—</div>
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
        return {
            label: stock.symbol,
            data,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.1,
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
        return `
            <div class="legend-item">
                <div class="legend-swatch" style="background:${color}"></div>
                <span style="color:${color};font-weight:600">${stock.symbol}</span>
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
    gridView.classList.remove('hidden');
    compareView.classList.add('hidden');
    document.getElementById('modelsView').classList.add('hidden');
});

btnCompare.addEventListener('click', () => {
    state.view = 'compare';
    btnCompare.classList.add('active');
    btnGrid.classList.remove('active');
    btnModels.classList.remove('active');
    compareView.classList.remove('hidden');
    gridView.classList.add('hidden');
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
    gridView.classList.add('hidden');
    compareView.classList.add('hidden');
    ModelView.init();
});

btnFetchAll.addEventListener('click', fetchAll);

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
    $('footerDate').textContent = new Date().toLocaleDateString('en-US',{dateStyle:'medium'});

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

    // Render grid cards
    gridView.innerHTML = '';
    for (const stock of state.stocks) {
        const card = buildCard(stock);
        gridView.appendChild(card);
    }

    // Load existing prices
    const priceLoads = state.stocks
        .filter(s => s.hasData)
        .map(s => loadPrices(s.symbol));
    await Promise.all(priceLoads);

    // Render charts for loaded stocks
    for (const stock of state.stocks) {
        if (state.prices[stock.symbol]?.length > 0) {
            renderCardChart(stock.symbol);
        }
    }

    updateStats();

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
