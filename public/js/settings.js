/* TenX Settings — loads before app.js so `settings` is available during init.
   Persists to localStorage['tenx_settings'].  All changes auto-save; no save/cancel flow. */

const SETTINGS_DEFAULTS = {
    chartFill:         true,
    cardHeight:        'normal',
    dataWindow:        24,
    breakoutThreshold: 70,
    showTranscripts:   true,
    showDataGaps:      true,
    advancedStocks:    ['NVDA'],
    freshnessT1Hours:  24,   freshnessT1Color: '#3B82F6',
    freshnessT2Hours:  48,   freshnessT2Color: '#22C55E',
    freshnessT3Hours:  120,  freshnessT3Color: '#EAB308',
    freshnessStaleColor: '#EF4444',
};

const settings = (() => {
    try {
        return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('tenx_settings') || '{}') };
    } catch {
        return { ...SETTINGS_DEFAULTS };
    }
})();

function saveSettings() {
    localStorage.setItem('tenx_settings', JSON.stringify(settings));
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Apply card-chart-height CSS variable immediately (before DOMContentLoaded)
function applyCardHeight() {
    const h = { compact: '130px', normal: '180px', tall: '260px' }[settings.cardHeight] || '180px';
    document.documentElement.style.setProperty('--card-chart-height', h);
}
applyCardHeight();

// Re-render every chart card that currently has price data loaded.
// Renders one card per event-loop tick so the browser stays responsive.
// A pending chain is cancelled if settings change again before it finishes.
let _reRenderTimer = null;

function reRenderAllCharts() {
    if (typeof state === 'undefined') return;
    if (_reRenderTimer !== null) { clearTimeout(_reRenderTimer); _reRenderTimer = null; }

    const tasks = [];
    for (const stock of state.stocks) {
        if (state.prices[stock.symbol]?.length)
            tasks.push(() => renderCardChart(stock.symbol));
    }
    for (const [name, items] of Object.entries(state.panels)) {
        for (const stock of items) {
            if (state.prices[stock.symbol]?.length)
                tasks.push(() => renderCardChart(stock.symbol, name + '_'));
        }
    }
    if (typeof renderCompareChart === 'function' && state.view === 'compare')
        tasks.push(() => renderCompareChart());

    let i = 0;
    function runNext() {
        if (i >= tasks.length) { _reRenderTimer = null; return; }
        tasks[i++]();
        _reRenderTimer = setTimeout(runNext, 0);
    }
    runNext();
}

// ── Panel open/close & section collapsing ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const wrap  = document.getElementById('settingsWrap');
    const btn   = document.getElementById('btnSettings');
    const panel = document.getElementById('settingsPanel');
    if (!wrap || !btn || !panel) return;

    btn.addEventListener('click', e => {
        e.stopPropagation();
        const open = panel.classList.toggle('open');
        btn.classList.toggle('active', open);
    });

    document.addEventListener('click', e => {
        if (!wrap.contains(e.target)) {
            panel.classList.remove('open');
            btn.classList.remove('active');
        }
    });

    // Collapsible section headers
    panel.querySelectorAll('.sp-section-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const body = hdr.nextElementSibling;
            const open = body.classList.toggle('open');
            hdr.querySelector('.sp-chevron')?.classList.toggle('rotated', open);
            if (open && hdr.dataset.section === 'data')     loadDataSection();
            if (open && hdr.dataset.section === 'advanced') {
                renderAdvancedChips();
                populateAddStockDropdown();
            }
        });
    });

    // Wire add-stock button
    document.getElementById('adv-add-btn')?.addEventListener('click', () => {
        const sel = document.getElementById('adv-add-select');
        if (sel?.value && typeof setAdvancedEnabled === 'function') {
            setAdvancedEnabled(sel.value, true);
            sel.value = '';
        }
    });

    // ── Chart fill ───────────────────────────────────────────────────
    const fillEl = document.getElementById('setting-chart-fill');
    if (fillEl) {
        fillEl.checked = settings.chartFill;
        fillEl.addEventListener('change', () => {
            settings.chartFill = fillEl.checked;
            saveSettings();
            reRenderAllCharts();
        });
    }

    // ── Card height ──────────────────────────────────────────────────
    const heightEl = document.getElementById('setting-card-height');
    if (heightEl) {
        heightEl.value = settings.cardHeight;
        heightEl.addEventListener('change', () => {
            settings.cardHeight = heightEl.value;
            saveSettings();
            applyCardHeight();
            reRenderAllCharts();
        });
    }

    // ── Data window ──────────────────────────────────────────────────
    const windowEl = document.getElementById('setting-data-window');
    if (windowEl) {
        windowEl.value = String(settings.dataWindow);
        windowEl.addEventListener('change', () => {
            settings.dataWindow = parseInt(windowEl.value);
            saveSettings();
            reRenderAllCharts();
        });
    }

    // ── Breakout threshold ───────────────────────────────────────────
    const threshEl = document.getElementById('setting-breakout-threshold');
    if (threshEl) {
        threshEl.value = String(settings.breakoutThreshold);
        threshEl.addEventListener('change', () => {
            settings.breakoutThreshold = parseInt(threshEl.value);
            saveSettings();
            updateThresholdLabel();
            if (typeof ModelView !== 'undefined' && ModelView.activeSymbol) {
                ModelView.loadDetail(ModelView.activeSymbol);
            }
        });
    }

    // ── Show NLP transcript signals ──────────────────────────────────
    const transcriptEl = document.getElementById('setting-show-transcripts');
    if (transcriptEl) {
        transcriptEl.checked = settings.showTranscripts;
        transcriptEl.addEventListener('change', () => {
            settings.showTranscripts = transcriptEl.checked;
            saveSettings();
            if (typeof ModelView !== 'undefined' && ModelView.activeSymbol) {
                ModelView.loadDetail(ModelView.activeSymbol);
            }
        });
    }

    // ── Show data gaps ───────────────────────────────────────────────
    const dataGapsEl = document.getElementById('setting-show-data-gaps');
    if (dataGapsEl) {
        dataGapsEl.checked = settings.showDataGaps;
        dataGapsEl.addEventListener('change', () => {
            settings.showDataGaps = dataGapsEl.checked;
            saveSettings();
            if (typeof ModelView !== 'undefined' && ModelView.data?.hasModels) {
                ModelView.render();
            }
        });
    }

    // ── Data Freshness ───────────────────────────────────────────────
    const freshnessFields = [
        { colorId: 'setting-fresh-t1-color', hoursId: 'setting-fresh-t1-hours', colorKey: 'freshnessT1Color', hoursKey: 'freshnessT1Hours' },
        { colorId: 'setting-fresh-t2-color', hoursId: 'setting-fresh-t2-hours', colorKey: 'freshnessT2Color', hoursKey: 'freshnessT2Hours' },
        { colorId: 'setting-fresh-t3-color', hoursId: 'setting-fresh-t3-hours', colorKey: 'freshnessT3Color', hoursKey: 'freshnessT3Hours' },
        { colorId: 'setting-fresh-stale-color', hoursId: null, colorKey: 'freshnessStaleColor', hoursKey: null },
    ];
    const debouncedFreshnessUpdate = debounce(() => {
        saveSettings();
        if (typeof refreshAllFreshnessBorders === 'function') refreshAllFreshnessBorders();
    }, 200);

    for (const f of freshnessFields) {
        const colorEl = document.getElementById(f.colorId);
        const hoursEl = f.hoursId ? document.getElementById(f.hoursId) : null;
        if (colorEl) {
            colorEl.value = settings[f.colorKey] ?? SETTINGS_DEFAULTS[f.colorKey];
            colorEl.addEventListener('input', () => {
                settings[f.colorKey] = colorEl.value;
                debouncedFreshnessUpdate();
            });
        }
        if (hoursEl) {
            hoursEl.value = settings[f.hoursKey] ?? SETTINGS_DEFAULTS[f.hoursKey];
            hoursEl.addEventListener('change', () => {
                const v = parseInt(hoursEl.value);
                if (!isNaN(v) && v > 0) {
                    settings[f.hoursKey] = v;
                    saveSettings();
                    if (typeof refreshAllFreshnessBorders === 'function') refreshAllFreshnessBorders();
                }
            });
        }
    }

    // ── Reset panel layout ───────────────────────────────────────────
    const resetBtn = document.getElementById('setting-reset-panels');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            panelConfig.columns   = { left: ['shortlist'], right: ['watchlist', 'marketcap'] };
            panelConfig.collapsed = {};
            savePanelConfig();
            renderPanels();
            for (const name of ['shortlist', 'watchlist', 'marketcap']) renderPanelCards(name);
            resetBtn.textContent = '✓ Reset';
            resetBtn.disabled = true;
            setTimeout(() => { resetBtn.textContent = 'Reset to Default'; resetBtn.disabled = false; }, 1800);
        });
    }
});

// Update the score-chart label in model detail to reflect current threshold
function updateThresholdLabel() {
    document.querySelectorAll('.threshold-label').forEach(el => {
        el.textContent = `Breakout Score  (threshold: ${settings.breakoutThreshold})`;
    });
}

// ── Advanced Analysis settings helpers ───────────────────────────────
function renderAdvancedChips() {
    const container = document.getElementById('adv-chips');
    if (!container) return;
    const list = settings.advancedStocks || [];
    container.innerHTML = list.length
        ? list.map(sym => `<span class="adv-chip">${sym}<button class="adv-chip-remove" onclick="setAdvancedEnabled('${sym}',false)">×</button></span>`).join('')
        : '<span class="sp-row-desc" style="padding:0 0 4px">No stocks enabled</span>';
}

function populateAddStockDropdown() {
    const sel = document.getElementById('adv-add-select');
    if (!sel || typeof state === 'undefined') return;
    const all = [
        ...state.stocks.map(s => ({ symbol: s.symbol, name: s.name })),
        ...Object.values(state.panels).flat().map(s => ({ symbol: s.symbol, name: s.name })),
    ];
    const seen = new Set(), unique = [];
    for (const s of all) { if (!seen.has(s.symbol)) { seen.add(s.symbol); unique.push(s); } }
    const available = unique.filter(s => !(settings.advancedStocks || []).includes(s.symbol));
    sel.innerHTML = '<option value="">Add a stock…</option>' +
        available.map(s => `<option value="${s.symbol}">${s.symbol} — ${s.name}</option>`).join('');
}

// Patch section-open handler to populate Advanced Analysis on first expand
const _origSectionClick = Symbol('_origSectionClick');

// ── Data section lazy loader ─────────────────────────────────────────
let _dataLoaded = false;
async function loadDataSection() {
    if (_dataLoaded) return;
    _dataLoaded = true;
    const body = document.getElementById('sp-data-body');
    if (!body) return;

    body.innerHTML = '<div class="sp-loading">Loading…</div>';

    try {
        const [cfgRes, edgarRes] = await Promise.all([
            fetch('/api/config').then(r => r.json()),
            fetch('/api/edgar-summary').then(r => r.json()),
        ]);

        const keyStatus = cfgRes.apiKey === 'loaded'
            ? '<span class="sp-status-ok">✓ loaded</span>'
            : '<span class="sp-status-err">✗ missing</span>';

        const edgarTotal = edgarRes.range?.total ?? 0;
        const edgarFirst = edgarRes.range?.first ?? '—';
        const edgarLast  = edgarRes.range?.last  ?? '—';
        const byType = (edgarRes.byType || []).map(r =>
            `<span>${r.source_type}: ${r.cnt}</span>`).join('  ·  ');
        const symbols = (edgarRes.bySymbol || []).map(r => r.symbol).join(', ');

        body.innerHTML = `
            <div class="sp-info-block">
                <div class="sp-info-label">Alpha Vantage API key</div>
                <div class="sp-info-value">${keyStatus}</div>
            </div>
            <div class="sp-info-block">
                <div class="sp-info-label">SEC EDGAR filings stored</div>
                <div class="sp-info-value sp-info-big">${edgarTotal} documents</div>
                <div class="sp-info-sub">${byType || '—'}</div>
                <div class="sp-info-sub">Filed ${edgarFirst} – ${edgarLast}</div>
                <div class="sp-info-sub" style="margin-top:4px;color:var(--text2)">${symbols || 'none'}</div>
            </div>`;
    } catch {
        body.innerHTML = '<div class="sp-loading" style="color:var(--red)">Failed to load</div>';
    }
}
