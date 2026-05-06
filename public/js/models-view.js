/* TenX — Models View: Breakout Scanner + Indicator Detail + Backtest */

const SIGNAL_LABELS = {
    breakout:        { label: 'Breakout ≥70',    color: '#3FB950' },
    strong_breakout: { label: 'Strong ≥80',       color: '#58A6FF' },
    surge:           { label: 'Score Surge',      color: '#D29922' },
    rsi_momentum:    { label: 'RSI Cross 50',     color: '#96CEB4' },
    macd_cross:      { label: 'MACD Cross',       color: '#4ECDC4' },
    peer_reversal:   { label: 'Peer Reversal',    color: '#DDA0DD' },
    volume_breakout: { label: 'Vol Breakout',     color: '#F0B27A' },
    obv_divergence:  { label: 'OBV Divergence',   color: '#FF6B6B' },
    ma_200w_cross:   { label: '200w Cross',       color: '#85C1E9' },
    golden_cross:    { label: 'Golden Cross',     color: '#FFD700' },
};

const REGIME_META = {
    high:   { label: 'High  (health ≥ 65)', color: '#3FB950', bg: 'rgba(63,185,80,0.08)'  },
    medium: { label: 'Medium (45–65)',       color: '#D29922', bg: 'rgba(210,153,34,0.08)' },
    low:    { label: 'Low  (health < 45)',   color: '#F85149', bg: 'rgba(248,81,73,0.08)'  },
};

const SIGNAL_ORDER = [
    'breakout','strong_breakout','surge','peer_reversal',
    'macd_cross','rsi_momentum','volume_breakout',
    'obv_divergence','ma_200w_cross','golden_cross',
];

const ModelView = {
    data:              null,
    regimeData:        null,
    detail:            null,
    transcriptSignals: {},
    detailCharts:      [],
    activeSymbol:      null,
    transcriptPoll:    null,
    _metaMap:          null,
    sort:              { col: 'score', dir: 'desc' },   // default sort

    async init() {
        await Promise.all([this.load(), this.loadRegime()]);
        this.render();
    },

    async load() {
        try { this.data = await fetch('/api/models').then(r => r.json()); }
        catch { this.data = { hasModels: false }; }
        this._metaMap = null; // invalidate cache after any data reload
    },

    async loadRegime() {
        try { this.regimeData = await fetch('/api/backtest-regime').then(r => r.json()); }
        catch { this.regimeData = {}; }
    },

    // ── metaMap: symbol → stock object, built once per load ──────────
    getMetaMap() {
        if (!this._metaMap) {
            const all = typeof state !== 'undefined'
                ? [...state.stocks, ...Object.values(state.panels).flat()] : [];
            this._metaMap = new Map(all.map(s => [s.symbol, s]));
        }
        return this._metaMap;
    },

    // ── Sort helpers ──────────────────────────────────────────────────
    setSort(col) {
        if (this.sort.col === col) {
            this.sort.dir = this.sort.dir === 'desc' ? 'asc' : 'desc';
        } else {
            this.sort.col = col;
            // Numeric columns default desc (higher = more interesting).
            // Symbol sorts asc first (alphabetical).
            this.sort.dir = col === 'symbol' ? 'asc' : 'desc';
        }
        this.refreshScanner();
    },

    _sortVal(row, col) {
        const meta = this.getMetaMap().get(row.symbol);
        const NULL = col === 'symbol' ? 'zzz' : -Infinity;
        switch (col) {
            case 'symbol':    return row.symbol ?? NULL;
            case 'score':     return row.score       ?? NULL;
            case 'conf':      return row.confluence  ?? NULL;
            case 'rsi':       return row.rsi         ?? NULL;
            case 'macd':      return row.macd_hist   ?? NULL;
            case 'volume':    return row.vol_ratio   ?? NULL;
            case 'peer_rank': return row.peer_rank   ?? NULL;
            case 'obv':       return row.obv_roc4    ?? NULL;
            case 'ma200':     return row.dist_200w   ?? NULL;
            case 'price':     return row.close       ?? NULL;
            case 'target':    return meta?.estYearGrowth ?? NULL;
            default:          return NULL;
        }
    },

    getSortedRows() {
        const rows  = (this.data?.indicators || []).slice();
        const { col, dir } = this.sort;
        rows.sort((a, b) => {
            const av = this._sortVal(a, col);
            const bv = this._sortVal(b, col);
            if (av === bv) return 0;
            if (col === 'symbol') {
                return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
            }
            return dir === 'desc' ? bv - av : av - bv;
        });
        return rows;
    },

    // Rebuild only the <thead> sort indicators and <tbody> rows in-place.
    refreshScanner() {
        // Update header chevrons
        document.querySelectorAll('.scanner-table th[data-col]').forEach(th => {
            const active = th.dataset.col === this.sort.col;
            th.classList.toggle('sort-active', active);
            const ind = th.querySelector('.sort-ind');
            if (ind) ind.textContent = active ? (this.sort.dir === 'asc' ? '▲' : '▼') : '';
        });
        // Rebuild tbody
        const tbody = document.querySelector('.scanner-table tbody');
        if (!tbody) return;
        tbody.innerHTML = this.renderScannerRows(this.getSortedRows());
        tbody.querySelectorAll('.scanner-row[data-sym]').forEach(row =>
            row.addEventListener('click', () => this.loadDetail(row.dataset.sym)));
    },

    // ── Master render ─────────────────────────────────────────────────
    render() {
        const view = document.getElementById('modelsView');
        if (!view) return;

        if (!this.data?.hasModels) {
            view.innerHTML = `
                <div class="model-empty">
                    <div style="font-size:32px;margin-bottom:12px">📊</div>
                    <div style="font-size:15px;font-weight:600;margin-bottom:8px">No model data yet</div>
                    <div style="color:var(--text2);font-size:13px;margin-bottom:16px">
                        Price data is loaded. Click below to compute indicators.
                    </div>
                    <button class="btn-primary" onclick="ModelView.triggerCompute()">Compute Models</button>
                </div>`;
            return;
        }

        const health = this.data.sectorHealth;
        const healthColor = health == null ? 'var(--text2)'
            : health >= 65 ? 'var(--green)' : health >= 45 ? 'var(--yellow)' : 'var(--red)';

        view.innerHTML = `
            <div class="model-top-bar">
                <div class="model-top-left">
                    <span class="model-title">Breakout Scanner</span>
                    <span class="model-subtitle">10 signals · OBV divergence · MA trend · Regime-conditioned · No lookahead</span>
                </div>
                <div class="model-top-right">
                    <div class="health-badge">
                        <span>Sector Health</span>
                        <span class="health-val" style="color:${healthColor}">
                            ${health != null ? health.toFixed(0)+'/100' : '—'}
                        </span>
                    </div>
                    <button class="btn-sm" onclick="ModelView.triggerCompute()">↺ Recompute</button>
                    <button class="btn-sm" onclick="ModelView.triggerEarnings()">⬇ Fetch EPS</button>
                </div>
            </div>

            ${this.renderScanner()}
            <div id="modelDetail" class="model-detail-wrap"></div>
            ${this.renderBacktest()}
            ${this.renderRegimeBacktest()}
            ${this.renderDataGaps()}
        `;

        document.querySelectorAll('.scanner-row[data-sym]').forEach(row =>
            row.addEventListener('click', () => this.loadDetail(row.dataset.sym)));

        // Sortable column headers
        document.querySelectorAll('.scanner-table th[data-col]').forEach(th =>
            th.addEventListener('click', () => this.setSort(th.dataset.col)));

        if (this.activeSymbol) {
            this.loadDetail(this.activeSymbol);
        } else if (this.data.indicators?.length) {
            const top = this.getSortedRows()[0];
            if (top) this.loadDetail(top.symbol);
        }
    },

    // ── Scanner table ─────────────────────────────────────────────────
    renderScanner() {
        if (!(this.data?.indicators?.length)) return '<div class="model-empty">No indicator data</div>';

        // Column definitions: [key, label, title]
        const COLS = [
            ['symbol',    'Symbol',         'Sort alphabetically'],
            ['score',     'Score',          'Breakout score 0–100'],
            ['conf',      'Conf.',          'Signal confluence (distinct types in 4w window)'],
            ['rsi',       'RSI',            'RSI(14)'],
            ['macd',      'MACD',           'MACD histogram direction'],
            ['volume',    'Volume',         'Volume ratio vs 10-week average'],
            ['peer_rank', 'Peer Rank',      'Relative 8-week return rank among peers'],
            ['obv',       'OBV(4w)',        'On-balance volume rate-of-change, 4 weeks'],
            ['ma200',     'vs 200w',        'Price distance from 200-week SMA'],
            ['price',     'Price',          'Latest closing price'],
            ['target',    'Est. 1Y Target', 'Target price from analyst 1-year estimate'],
        ];

        const th = ([key, label, title]) => {
            const active = this.sort.col === key;
            const ind    = active ? (this.sort.dir === 'asc' ? '▲' : '▼') : '';
            return `<th data-col="${key}" class="sortable-th${active ? ' sort-active' : ''}" title="${title}">
                ${label}<span class="sort-ind">${ind}</span>
            </th>`;
        };

        return `
        <div class="scanner-wrap">
            <table class="scanner-table">
                <thead><tr>${COLS.map(th).join('')}</tr></thead>
                <tbody>${this.renderScannerRows(this.getSortedRows())}</tbody>
            </table>
        </div>`;
    },

    // Extracted row renderer — called by both renderScanner() and refreshScanner()
    renderScannerRows(rows) {
        const scoreBar = s => {
            if (s == null) return '—';
            const color = s >= 70 ? 'var(--green)' : s >= 50 ? 'var(--yellow)' : 'var(--red)';
            return `<div class="score-bar-wrap" title="${s.toFixed(1)}">
                <div class="score-bar-fill" style="width:${Math.min(100,s)}%;background:${color}"></div>
                <span class="score-bar-label">${s.toFixed(0)}</span>
            </div>`;
        };
        const fmtRSI  = v => v == null ? '—' : `<span class="${v>=60?'positive':v<=40?'negative':''}">${v.toFixed(0)}</span>`;
        const fmtMACD = v => v == null ? '—' : `<span class="${v>0?'positive':'negative'}">${v>0?'▲':'▼'}</span>`;
        const fmtVol  = v => v == null ? '—' : `<span class="${v>=1.2?'positive':v<=0.8?'negative':''}">${v.toFixed(2)}×</span>`;
        const fmtRank = v => v == null ? '—' : `<span class="${v>=0.6?'positive':v<=0.3?'negative':''}">#${10-Math.round(v*9)}</span>`;
        const fmtOBV  = v => v == null ? '—' : `<span class="${v>2?'positive':v<-2?'negative':''}">${v>0?'+':''}${v.toFixed(1)}%</span>`;
        const fmtMA   = v => v == null ? '—' : `<span class="${v>0?'positive':v<-10?'negative':''}">${v>0?'+':''}${v.toFixed(1)}%</span>`;
        const fmtConf = v => {
            if (!v) return '<span class="text3">—</span>';
            const color = v >= 4 ? 'var(--green)' : v >= 2 ? 'var(--yellow)' : 'var(--text2)';
            return `<span style="color:${color};font-weight:700">${'⚡'.repeat(Math.min(v,4))} ${v}</span>`;
        };

        const metaMap = this.getMetaMap();

        return rows.map(r => {
            const meta = metaMap.get(r.symbol);
            const eg   = meta?.estYearGrowth;
            const targetPrice = r.close != null && eg != null ? r.close * (1 + eg / 100) : null;
            const fmtTarget = targetPrice != null
                ? `<span class="${eg >= 0 ? 'positive' : 'negative'}">$${targetPrice.toFixed(2)}</span>
                   <small class="text3"> ${eg >= 0 ? '+' : ''}${eg}%</small>`
                : '—';
            const symLabel = meta?.isEtf
                ? `<span class="scan-sym" style="color:${getGrowthColor(eg)}">${r.symbol}</span>
                   <span class="badge badge-etf" style="font-size:9px;padding:1px 5px;margin-left:4px">ETF</span>`
                : `<span class="scan-sym" style="color:${getGrowthColor(eg)}">${r.symbol}</span>`;
            return `
            <tr class="scanner-row ${r.symbol===this.activeSymbol?'active':''}" data-sym="${r.symbol}">
                <td>${symLabel}</td>
                <td>${scoreBar(r.score)}</td>
                <td>${fmtConf(r.confluence)}</td>
                <td>${fmtRSI(r.rsi)}</td>
                <td>${fmtMACD(r.macd_hist)}</td>
                <td>${fmtVol(r.vol_ratio)}</td>
                <td>${fmtRank(r.peer_rank)}</td>
                <td>${fmtOBV(r.obv_roc4)}</td>
                <td>${fmtMA(r.dist_200w)}</td>
                <td>$${r.close?.toFixed(2)??'—'}</td>
                <td>${fmtTarget}</td>
            </tr>`;
        }).join('');
    },

    // ── Per-stock detail ──────────────────────────────────────────────
    async loadDetail(symbol) {
        this.activeSymbol = symbol;
        document.querySelectorAll('.scanner-row').forEach(r =>
            r.classList.toggle('active', r.dataset.sym === symbol));

        const wrap = document.getElementById('modelDetail');
        if (!wrap) return;
        wrap.innerHTML = `<div class="model-loading">Loading ${symbol}…</div>`;

        try {
            [this.detail, this.transcriptSignals[symbol]] = await Promise.all([
                fetch(`/api/model/${symbol}`).then(r => r.json()),
                fetch(`/api/transcript-signals/${symbol}`).then(r => r.json()).then(d => d.signals || []),
            ]);
        } catch {
            wrap.innerHTML = `<div class="model-loading">Failed to load ${symbol}</div>`;
            return;
        }
        this.detailCharts.forEach(c => c.destroy());
        this.detailCharts = [];
        wrap.innerHTML = this.buildDetailHTML(symbol);
        this.renderDetailCharts(symbol);
    },

    buildDetailHTML(symbol) {
        const { indicators, signals } = this.detail;
        if (!indicators?.length) return `<div class="model-loading">No indicator data for ${symbol}</div>`;

        const allStocksD = typeof state !== 'undefined' ? [...state.stocks, ...Object.values(state.panels).flat()] : [];
        const stockD     = allStocksD.find(s => s.symbol === symbol);
        const color  = getGrowthColor(stockD?.estYearGrowth);
        const sigs   = (signals || []).slice().sort((a, b) => b.date.localeCompare(a.date));
        const latest = indicators[indicators.length - 1] || {};
        const gc     = latest.golden_cross === 1;

        return `
        <div class="detail-card">
            <div class="detail-header">
                <span class="detail-sym" style="color:${color}">${symbol}</span>
                <div class="detail-meta">
                    <span>Score: <strong style="color:${scoreColor(latest.score)}">${latest.score?.toFixed(0)??'—'}</strong></span>
                    <span>Confluence: <strong>${latest.confluence ?? 0}</strong></span>
                    <span>RSI: <strong>${latest.rsi?.toFixed(1)??'—'}</strong></span>
                    <span>OBV: <strong class="${(latest.obv_roc4||0)>0?'positive':'negative'}">${latest.obv_roc4!=null?(latest.obv_roc4>0?'+':'')+latest.obv_roc4.toFixed(1)+'%':'—'}</strong></span>
                    <span>vs 200w: <strong class="${(latest.dist_200w||0)>0?'positive':'negative'}">${latest.dist_200w!=null?(latest.dist_200w>0?'+':'')+latest.dist_200w.toFixed(1)+'%':'—'}</strong></span>
                    <span>${gc ? '<span style="color:#FFD700">✦ Golden Cross</span>' : ''}</span>
                </div>
            </div>

            <div class="detail-charts">
                <div class="detail-chart-row main-row">
                    <div class="chart-label">Price · 52W High · SMA 200w</div>
                    <div class="detail-canvas-wrap" style="height:200px"><canvas id="dc-price-${symbol}"></canvas></div>
                    <div class="chart-label threshold-label" style="margin-top:8px">Breakout Score  (threshold: ${(typeof settings !== 'undefined' ? settings.breakoutThreshold : 70)})</div>
                    <div class="detail-canvas-wrap" style="height:72px"><canvas id="dc-score-${symbol}"></canvas></div>
                </div>
                <div class="detail-chart-row sub-row">
                    <div><div class="chart-label">RSI(14)</div>
                         <div class="detail-canvas-wrap" style="height:100px"><canvas id="dc-rsi-${symbol}"></canvas></div></div>
                    <div><div class="chart-label">MACD Histogram</div>
                         <div class="detail-canvas-wrap" style="height:100px"><canvas id="dc-macd-${symbol}"></canvas></div></div>
                    <div><div class="chart-label">Volume Ratio</div>
                         <div class="detail-canvas-wrap" style="height:100px"><canvas id="dc-vol-${symbol}"></canvas></div></div>
                    <div><div class="chart-label">Peer Rank</div>
                         <div class="detail-canvas-wrap" style="height:100px"><canvas id="dc-rank-${symbol}"></canvas></div></div>
                    <div><div class="chart-label">OBV Rate-of-Change (4w)</div>
                         <div class="detail-canvas-wrap" style="height:100px"><canvas id="dc-obv-${symbol}"></canvas></div></div>
                </div>
            </div>

            ${(typeof settings === 'undefined' || settings.showTranscripts) ? this.buildTranscriptSection(symbol) : ''}

            <div class="signal-section">
                <div class="signal-title">Signal History — ${symbol} &nbsp;(${sigs.length} total)</div>
                ${sigs.length === 0 ? '<div class="text3" style="padding:12px">No signals in data window.</div>' : `
                <div class="signal-scroll">
                    <table class="signal-table">
                        <thead><tr>
                            <th>Date</th><th>Signal</th><th>Score</th>
                            <th>Sector Health</th><th>+4w</th><th>+8w</th><th>+12w</th><th>Description</th>
                        </tr></thead>
                        <tbody>
                        ${sigs.map(s => {
                            const m = SIGNAL_LABELS[s.type] || { label: s.type, color: '#58A6FF' };
                            const h = s.sector_health;
                            const hColor = h==null?'var(--text3)':h>=65?'var(--green)':h>=45?'var(--yellow)':'var(--red)';
                            return `<tr>
                                <td>${s.date}</td>
                                <td><span class="sig-badge" style="background:${m.color}22;color:${m.color};border-color:${m.color}44">${m.label}</span></td>
                                <td>${s.score?.toFixed(0)??'—'}</td>
                                <td><span style="color:${hColor}">${h!=null?h.toFixed(0):' —'}</span></td>
                                <td class="${fwdClass(s.fwd_4w)}">${fwdFmt(s.fwd_4w)}</td>
                                <td class="${fwdClass(s.fwd_8w)}">${fwdFmt(s.fwd_8w)}</td>
                                <td class="${fwdClass(s.fwd_12w)}">${fwdFmt(s.fwd_12w)}</td>
                                <td class="text3">${s.description??''}</td>
                            </tr>`;
                        }).join('')}
                        </tbody>
                    </table>
                </div>`}
            </div>
        </div>`;
    },

    renderDetailCharts(symbol) {
        const { indicators, signals } = this.detail;
        if (!indicators?.length) return;

        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 24);
        const cutStr = cutoff.toISOString().split('T')[0];
        const rows = indicators.filter(r => r.date >= cutStr);
        if (!rows.length) return;

        const allStocksR = typeof state !== 'undefined' ? [...state.stocks, ...Object.values(state.panels).flat()] : [];
        const stockR     = allStocksR.find(s => s.symbol === symbol);
        const color    = getGrowthColor(stockR?.estYearGrowth);
        const labels   = rows.map(r => new Date(r.date));
        const sigDates = new Set((signals || []).map(s => s.date));

        const base = (min, max) => ({
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index', intersect: false,
                    backgroundColor:'#161B22', borderColor:'#30363D', borderWidth:1,
                    titleColor:'#E6EDF3', bodyColor:'#8B949E',
                    callbacks: { title: items => new Date(items[0].label).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) }
                }
            },
            scales: {
                x: { type:'time', time:{unit:'month',displayFormats:{month:'MMM yy'}},
                     grid:{color:'#21262D'}, ticks:{color:'#6E7681',maxTicksLimit:8,maxRotation:0}, border:{color:'#30363D'} },
                y: { min, max, grid:{color:'#21262D'}, ticks:{color:'#6E7681'}, border:{color:'#30363D'} }
            }
        });
        const push = c => this.detailCharts.push(c);

        // Price + 52w High + SMA200
        const pc = document.getElementById(`dc-price-${symbol}`);
        if (pc) push(new Chart(pc, { type:'line', data:{ labels, datasets:[
            { data:rows.map(r=>r.close), borderColor:color, backgroundColor:rgba(color,0.1), borderWidth:2, pointRadius:0, fill:true, tension:0.1 },
            { data:rows.map(r=>r.hi_52w), borderColor:'#6E7681', borderDash:[4,4], borderWidth:1, pointRadius:0, fill:false },
            { data:rows.map(r=>r.bb_mid /* using as proxy for SMA200 via dist_200w context */), type:'line',
              label:'SMA200', borderColor:'#D29922', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
            { type:'scatter', data:rows.filter(r=>sigDates.has(r.date)).map(r=>({x:new Date(r.date),y:r.close})),
              pointStyle:'triangle', pointRadius:7, backgroundColor:'#D29922', borderColor:'#D29922' },
        ]}, options:base() }));

        // Breakout score
        const _thresh = (typeof settings !== 'undefined') ? settings.breakoutThreshold : 70;
        const sc = document.getElementById(`dc-score-${symbol}`);
        if (sc) push(new Chart(sc, { type:'line', data:{ labels, datasets:[
            { data:rows.map(r=>r.score), borderColor:'#D29922', backgroundColor:rgba('#D29922',0.15), borderWidth:1.5, pointRadius:0, fill:true },
            { data:rows.map(()=>_thresh), borderColor:'#3FB950', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
        ]}, options:{...base(0,100), scales:{...base(0,100).scales, y:{...base(0,100).scales.y, ticks:{color:'#6E7681',callback:v=>v.toFixed(0)}}}} }));

        // RSI
        const rc = document.getElementById(`dc-rsi-${symbol}`);
        if (rc) push(new Chart(rc, { type:'line', data:{ labels, datasets:[
            { data:rows.map(r=>r.rsi), borderColor:'#45B7D1', borderWidth:1.5, pointRadius:0, fill:false },
            { data:rows.map(()=>70), borderColor:'#F85149', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
            { data:rows.map(()=>30), borderColor:'#3FB950', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
            { data:rows.map(()=>50), borderColor:'#6E7681', borderDash:[2,4], borderWidth:1, pointRadius:0, fill:false },
        ]}, options:base(0,100) }));

        // MACD histogram
        const mc = document.getElementById(`dc-macd-${symbol}`);
        if (mc) {
            const hd = rows.map(r=>r.macd_hist);
            push(new Chart(mc, { type:'bar', data:{ labels, datasets:[
                { data:hd, backgroundColor:hd.map(v=>v==null?'transparent':v>=0?rgba('#3FB950',0.7):rgba('#F85149',0.7)), borderWidth:0 }
            ]}, options:base() }));
        }

        // Volume ratio
        const vc = document.getElementById(`dc-vol-${symbol}`);
        if (vc) {
            const vd = rows.map(r=>r.vol_ratio);
            push(new Chart(vc, { type:'bar', data:{ labels, datasets:[
                { data:vd, backgroundColor:vd.map(v=>v==null?'transparent':v>=1.5?rgba('#3FB950',0.7):rgba('#58A6FF',0.4)), borderWidth:0 },
                { data:rows.map(()=>1.0), type:'line', borderColor:'#6E7681', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
            ]}, options:base(0) }));
        }

        // Peer rank
        const rkc = document.getElementById(`dc-rank-${symbol}`);
        if (rkc) push(new Chart(rkc, { type:'line', data:{ labels, datasets:[
            { data:rows.map(r=>r.peer_rank!=null?r.peer_rank*100:null), borderColor:'#DDA0DD', backgroundColor:rgba('#DDA0DD',0.15), borderWidth:1.5, pointRadius:0, fill:true },
            { data:rows.map(()=>50), borderColor:'#6E7681', borderDash:[3,3], borderWidth:1, pointRadius:0, fill:false },
        ]}, options:{...base(0,100), scales:{...base(0,100).scales, y:{...base(0,100).scales.y, ticks:{color:'#6E7681',callback:v=>v===100?'#1':v===0?'#10':''}}}} }));

        // OBV ROC
        const oc = document.getElementById(`dc-obv-${symbol}`);
        if (oc) {
            const od = rows.map(r=>r.obv_roc4);
            push(new Chart(oc, { type:'bar', data:{ labels, datasets:[
                { data:od, backgroundColor:od.map(v=>v==null?'transparent':v>=0?rgba('#FF6B6B',0.7):rgba('#6E7681',0.4)), borderWidth:0 },
                { data:rows.map(()=>0), type:'line', borderColor:'#6E7681', borderDash:[2,4], borderWidth:1, pointRadius:0, fill:false },
            ]}, options:base() }));
        }

        // Transcript signals chart
        this.renderTranscriptChart(symbol);
    },

    // ── Transcript section (built into detail card) ───────────────────
    buildTranscriptSection(symbol) {
        const sigs = this.transcriptSignals[symbol] || [];
        if (!sigs.length) {
            return `
            <div class="transcript-section">
                <div class="transcript-title">Earnings Call Transcripts — NLP Signals</div>
                <div class="transcript-empty">
                    No transcripts loaded yet.
                    <button class="btn-sm" onclick="ModelView.triggerTranscripts('${symbol}')">
                        ⬇ Fetch from SEC EDGAR
                    </button>
                </div>
            </div>`;
        }

        const latest = sigs[sigs.length - 1];
        const prev   = sigs[sigs.length - 2];
        const sentDelta = prev ? (latest.sentiment_score - prev.sentiment_score) : null;
        const aiDelta   = prev ? (latest.ai_dc_mentions  - prev.ai_dc_mentions)  : null;

        const metaCard = (label, val, delta, suffix = '', invert = false) => {
            const dClass = delta == null ? '' : (delta > 0) !== invert ? 'positive' : 'negative';
            const dText  = delta == null ? '' : `<span class="${dClass}" style="font-size:10px">${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(suffix === '%' ? 3 : 0)}${suffix}</span>`;
            return `<div class="tc-meta-card">
                <div class="tc-meta-val">${val}</div>
                <div class="tc-meta-lbl">${label} ${dText}</div>
            </div>`;
        };

        return `
        <div class="transcript-section">
            <div class="transcript-title">
                Earnings Call Transcripts — NLP Signals
                <span class="transcript-count">${sigs.length} transcript${sigs.length !== 1 ? 's' : ''}</span>
                <button class="btn-sm" onclick="ModelView.triggerTranscripts('${symbol}')" style="margin-left:8px">↺ Refresh</button>
            </div>

            <div class="tc-meta-row">
                ${metaCard('Sentiment (latest)', (latest.sentiment_score >= 0 ? '+' : '') + latest.sentiment_score.toFixed(3), sentDelta, '')}
                ${metaCard('AI/DC Mentions', latest.ai_dc_mentions, aiDelta, '')}
                ${metaCard('Demand+', latest.demand_pos, prev ? latest.demand_pos - prev.demand_pos : null, '')}
                ${metaCard('Demand−', latest.demand_neg, prev ? latest.demand_neg - prev.demand_neg : null, '', true)}
                ${metaCard('Guidance↑', latest.guidance_up, null)}
                ${metaCard('Guidance↓', latest.guidance_down, null, '', true)}
                ${metaCard('Words', latest.word_count?.toLocaleString() ?? '—', null)}
            </div>

            <div class="tc-chart-label">Sentiment score · AI/DC mentions · Demand balance (per earnings call)</div>
            <div class="detail-canvas-wrap" style="height:130px"><canvas id="tc-chart-${symbol}"></canvas></div>

            <div class="tc-table-wrap">
                <table class="signal-table">
                    <thead><tr>
                        <th>Filed</th><th>Quarter</th><th>Sentiment</th>
                        <th>AI/DC</th><th>Demand+</th><th>Demand−</th>
                        <th>Guidance↑</th><th>Guidance↓</th><th>Words</th>
                    </tr></thead>
                    <tbody>
                    ${sigs.slice().reverse().map(s => {
                        const qLabel = (s.fiscal_quarter && s.fiscal_year)
                            ? `Q${s.fiscal_quarter} FY${s.fiscal_year}` : s.filed_date;
                        return `<tr>
                            <td>${s.filed_date}</td>
                            <td>${qLabel}</td>
                            <td class="${s.sentiment_score >= 0 ? 'positive' : 'negative'}">${(s.sentiment_score >= 0 ? '+' : '') + s.sentiment_score.toFixed(3)}</td>
                            <td>${s.ai_dc_mentions}</td>
                            <td class="positive">${s.demand_pos}</td>
                            <td class="negative">${s.demand_neg}</td>
                            <td class="positive">${s.guidance_up}</td>
                            <td class="negative">${s.guidance_down}</td>
                            <td class="text3">${s.word_count?.toLocaleString() ?? '—'}</td>
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    },

    renderTranscriptChart(symbol) {
        const sigs = this.transcriptSignals[symbol] || [];
        const canvas = document.getElementById(`tc-chart-${symbol}`);
        if (!canvas || !sigs.length) return;

        const labels    = sigs.map(s => new Date(s.filed_date));
        const sentiment = sigs.map(s => s.sentiment_score != null ? s.sentiment_score * 100 : null);
        const aiMentions = sigs.map(s => s.ai_dc_mentions);
        const demandNet  = sigs.map(s => (s.demand_pos || 0) - (s.demand_neg || 0));

        const c = new Chart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        type: 'line',
                        label: 'Sentiment ×100',
                        data: sentiment,
                        borderColor: '#3FB950',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        tension: 0.2,
                        yAxisID: 'ySent',
                        order: 1,
                    },
                    {
                        label: 'AI/DC Mentions',
                        data: aiMentions,
                        backgroundColor: rgba('#58A6FF', 0.7),
                        borderWidth: 0,
                        yAxisID: 'yCount',
                        order: 2,
                    },
                    {
                        label: 'Net Demand',
                        data: demandNet,
                        backgroundColor: demandNet.map(v => v >= 0 ? rgba('#3FB950', 0.5) : rgba('#F85149', 0.5)),
                        borderWidth: 0,
                        yAxisID: 'yCount',
                        order: 3,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, labels: { color: '#8B949E', boxWidth: 12, font: { size: 10 } } },
                    tooltip: {
                        backgroundColor: '#161B22', borderColor: '#30363D', borderWidth: 1,
                        titleColor: '#E6EDF3', bodyColor: '#8B949E',
                        callbacks: {
                            title: items => new Date(items[0].label)
                                .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'quarter', displayFormats: { quarter: 'QQQ yy' } },
                        grid: { color: '#21262D' }, ticks: { color: '#6E7681', maxRotation: 0 },
                        border: { color: '#30363D' },
                    },
                    ySent: {
                        position: 'left',
                        grid: { color: '#21262D' },
                        ticks: { color: '#3FB950', callback: v => v.toFixed(0) },
                        border: { color: '#30363D' },
                        title: { display: true, text: 'Sent×100', color: '#3FB950', font: { size: 9 } },
                    },
                    yCount: {
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#58A6FF', callback: v => v.toFixed(0) },
                        border: { color: '#30363D' },
                        title: { display: true, text: 'Mentions', color: '#58A6FF', font: { size: 9 } },
                    },
                },
            }
        });
        this.detailCharts.push(c);
    },

    // ── Overall backtest ──────────────────────────────────────────────
    renderBacktest() {
        const stats = this.data?.backtestStats;
        if (!stats || !Object.keys(stats).length) return '';
        const rows = SIGNAL_ORDER.filter(t => stats[t]).map(t => {
            const s = stats[t], m = SIGNAL_LABELS[t] || { label:t, color:'#58A6FF' };
            return `<tr>
                <td><span class="sig-badge" style="background:${m.color}22;color:${m.color};border-color:${m.color}44">${m.label}</span></td>
                <td>${s.n}</td>
                <td class="${pctClass(s.pctPositive)}">${s.pctPositive!=null?s.pctPositive+'%':'—'}</td>
                <td class="${fwdClass(s.avgFwd4w?parseFloat(s.avgFwd4w):null)}">${fmtAvg(s.avgFwd4w)}</td>
                <td class="${fwdClass(s.avgFwd8w?parseFloat(s.avgFwd8w):null)}">${fmtAvg(s.avgFwd8w)}</td>
                <td class="${fwdClass(s.avgFwd12w?parseFloat(s.avgFwd12w):null)}">${fmtAvg(s.avgFwd12w)}</td>
            </tr>`;
        });
        if (!rows.length) return '';
        return `
        <div class="backtest-wrap">
            <div class="backtest-title">Overall Backtest — 26-year history
                <span class="backtest-note">forward returns are strictly out-of-sample from each signal date</span>
            </div>
            <table class="signal-table"><thead><tr>
                <th>Signal</th><th>N</th><th>Win% (4w)</th><th>Avg +4w</th><th>Avg +8w</th><th>Avg +12w</th>
            </tr></thead><tbody>${rows.join('')}</tbody></table>
        </div>`;
    },

    // ── Regime-conditioned backtest ───────────────────────────────────
    renderRegimeBacktest() {
        const rd = this.regimeData;
        if (!rd || !Object.keys(rd).length) return '';

        const allTypes = SIGNAL_ORDER.filter(t =>
            Object.values(rd).some(r => r[t]));

        const regimes = ['high','medium','low'];

        const cell = (s) => {
            if (!s) return '<td colspan="2" class="text3">—</td>';
            const pct = s.pctPositive != null ? `<span class="${pctClass(s.pctPositive)}">${s.pctPositive}%</span>` : '—';
            const avg = s.avgFwd4w  != null ? `<span class="${fwdClass(parseFloat(s.avgFwd4w))}">${fmtAvg(s.avgFwd4w)}</span>` : '—';
            return `<td>${pct}<br><small class="text3">n=${s.n}</small></td><td>${avg}</td>`;
        };

        return `
        <div class="regime-wrap">
            <div class="backtest-title">Regime-Conditioned Backtest
                <span class="backtest-note">same signals split by sector health at time of fire</span>
            </div>
            <div class="regime-legend">
                ${regimes.map(r => `<span class="regime-chip" style="border-color:${REGIME_META[r].color};color:${REGIME_META[r].color}">${REGIME_META[r].label}</span>`).join('')}
            </div>
            <div class="regime-scroll">
            <table class="signal-table regime-table">
                <thead>
                    <tr>
                        <th rowspan="2">Signal</th>
                        ${regimes.map(r => `<th colspan="2" style="color:${REGIME_META[r].color}">
                            ${r.charAt(0).toUpperCase()+r.slice(1)} regime<br>
                            <small style="font-weight:400;color:var(--text3)">Win% (4w) &nbsp;·&nbsp; Avg +4w</small>
                        </th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${allTypes.map(t => {
                        const m = SIGNAL_LABELS[t] || { label:t, color:'#58A6FF' };
                        return `<tr>
                            <td><span class="sig-badge" style="background:${m.color}22;color:${m.color};border-color:${m.color}44">${m.label}</span></td>
                            ${regimes.map(r => cell(rd[r]?.[t])).join('')}
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            </div>
            <div class="regime-insight">
                <strong>Key insight:</strong> High-regime signals (sector health ≥ 65) should show meaningfully higher
                win rates and returns than low-regime signals. If a signal type shows <em>better</em> performance
                in low regimes, it may be capturing counter-trend reversals rather than trend continuations.
            </div>
        </div>`;
    },

    // ── Data gap inventory ─────────────────────────────────────────────
    renderDataGaps() {
        if (typeof settings !== 'undefined' && !settings.showDataGaps) return '';
        return `
        <div class="model-data-gaps">
            <div class="data-gaps-title">Additional data that would improve the model</div>
            <div class="data-gaps-grid">
                ${[
                    ['EPS beat streak',       '✓ MU loaded',  true,  'Consecutive quarterly beats vs consensus (Alpha Vantage free — 9 remaining stocks need quota reset)'],
                    ['OBV divergence',         '✓ active',     true,  'Price/volume divergence — computed from existing DB data'],
                    ['200w MA trend',           '✓ active',     true,  'Long-term trend support filter — computed from existing DB data'],
                    ['Revenue acceleration',   '— pending',   false, 'QoQ revenue growth rate; guidance raises require call transcript NLP (Refinitiv/Sentieo)'],
                    ['Short interest',          '— pending',   false, 'Float % short — squeeze potential for stocks like MU (Nasdaq weekly data file, free)'],
                    ['Insider Form-4',          '— pending',   false, 'CEO/CFO open-market buys (SEC EDGAR bulk — free, requires parsing)'],
                    ['News sentiment',          '— pending',   false, '"AI"/"data center" mention frequency in headlines (Alpha Vantage News — premium tier)'],
                    ['Book-to-bill ratio',      '— pending',   false, 'Equipment order health for AMAT/LRCX/KLAC (SEMI.org monthly)'],
                    ['DRAM/NAND spot pricing',  '— pending',   false, 'Leading indicator for MU breakouts (DRAMeXchange / TrendForce — subscription)'],
                ].map(([name, status, ok, desc]) => `
                    <div class="data-gap-item ${ok?'loaded':''}">
                        <span class="gap-status">${ok?'✓':'○'}</span>
                        <span class="gap-name">${name}</span>
                        <span class="gap-status-txt">${status}</span>
                        <span class="gap-desc">${desc}</span>
                    </div>`).join('')}
            </div>
        </div>`;
    },

    // ── Trigger server actions ────────────────────────────────────────
    async triggerCompute() {
        showStatus('Recomputing models…', 'info', true);
        await fetch('/api/compute-models', { method:'POST' });
        setTimeout(async () => { await this.load(); await this.loadRegime(); this.render(); hideStatus(); }, 5000);
    },

    async triggerEarnings() {
        showStatus('Fetching EPS then recomputing (~4 min)…', 'info', true);
        const startRunAt = this.data?.modelRunAt ?? null;
        await fetch('/api/fetch-earnings', { method: 'POST' });

        const poll = setInterval(async () => {
            try {
                const res = await fetch('/api/models').then(r => r.json());
                if (res.modelRunAt && res.modelRunAt !== startRunAt) {
                    clearInterval(poll);
                    this.data = res;
                    await this.loadRegime();
                    this.render();
                    showStatus('EPS loaded and models recomputed!', 'success');
                    setTimeout(hideStatus, 3000);
                }
            } catch { /* keep polling */ }
        }, 8000);
        setTimeout(() => clearInterval(poll), 600000); // 10 min max
    },

    async triggerTranscripts(symbol) {
        // Cancel any previous poll before starting a new one
        if (this.transcriptPoll !== null) {
            clearInterval(this.transcriptPoll);
            this.transcriptPoll = null;
        }

        const msg = symbol
            ? `Fetching ${symbol} transcripts from SEC EDGAR…`
            : 'Fetching all transcripts from SEC EDGAR (~3 min per stock)…';
        showStatus(msg, 'info', true);
        await fetch('/api/fetch-transcripts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cutoff: '2021-01-01', symbols: symbol ? [symbol] : null }),
        });
        // Poll until the transcript count for this symbol increases
        const startCount = symbol ? (this.transcriptSignals[symbol] || []).length : 0;
        this.transcriptPoll = setInterval(async () => {
            const res = await fetch(`/api/transcript-signals/${symbol || 'NVDA'}`).then(r => r.json());
            if ((res.signals || []).length > startCount) {
                clearInterval(this.transcriptPoll);
                this.transcriptPoll = null;
                if (symbol) {
                    this.transcriptSignals[symbol] = res.signals;
                    await this.loadDetail(symbol);
                } else {
                    await this.load();
                    this.render();
                }
                showStatus('Transcripts loaded!', 'success');
                setTimeout(hideStatus, 3000);
            }
        }, 5000);
        setTimeout(() => {
            if (this.transcriptPoll !== null) {
                clearInterval(this.transcriptPoll);
                this.transcriptPoll = null;
            }
        }, 600000); // 10 min max
    },
};

// ── Helpers ───────────────────────────────────────────────────────────
function scoreColor(s) {
    return s==null?'var(--text2)':s>=70?'var(--green)':s>=50?'var(--yellow)':'var(--red)';
}
function fwdFmt(v)  { return v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%'; }
function fmtAvg(v)  { return v==null?'—':(parseFloat(v)>=0?'+':'')+v+'%'; }
function fwdClass(v){ return v==null?'':v>0?'positive':v<0?'negative':''; }
function pctClass(v){ return v==null?'':parseFloat(v)>=60?'positive':parseFloat(v)<50?'negative':''; }
