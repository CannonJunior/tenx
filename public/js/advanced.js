/* TenX Advanced Analysis — loaded after app.js.
   Provides buildAdvancedSection(), the four action handlers,
   and helpers used by settings to enable/disable per stock. */

// ── Build the advanced section HTML for a card ────────────────────────
// Called from buildCard() in app.js. sid = scoped ID (ctx + symbol).
function buildAdvancedSection(stock, sid) {
    const sym     = stock.symbol;
    const enabled = typeof settings !== 'undefined' && (settings.advancedStocks || []).includes(sym);
    return `
    <div class="adv-section${enabled ? '' : ' hidden'}" id="adv-${sid}" data-symbol="${sym}" data-sid="${sid}" data-loaded="false">
        <button class="adv-toggle-btn" onclick="toggleAdvanced('${sid}','${sym}')">
            <span>Advanced Analysis</span>
            <svg class="adv-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="adv-body hidden" id="adv-body-${sid}">
            <div class="adv-btn-grid">
                <button class="adv-btn" id="adv-media-${sid}" onclick="advMedia('${sym}','${sid}')">
                    <span class="adv-btn-icon">📰</span>
                    <span class="adv-btn-label">Media Reports</span>
                    <span class="adv-btn-count" id="adv-media-count-${sid}"></span>
                </button>
                <button class="adv-btn" id="adv-fetch-${sid}" onclick="advFetch('${sym}','${sid}')">
                    <span class="adv-btn-icon">📈</span>
                    <span class="adv-btn-label">Fetch Data</span>
                    <span class="adv-btn-count" id="adv-fetch-count-${sid}"></span>
                </button>
                <button class="adv-btn" id="adv-edgar-${sid}" onclick="advEdgar('${sym}','${sid}')">
                    <span class="adv-btn-icon">📋</span>
                    <span class="adv-btn-label">EDGAR</span>
                    <span class="adv-btn-count" id="adv-edgar-count-${sid}"></span>
                </button>
                <button class="adv-btn" id="adv-infer-${sid}" onclick="advInfer('${sym}','${sid}')">
                    <span class="adv-btn-icon">🔍</span>
                    <span class="adv-btn-label">Inference</span>
                    <span class="adv-btn-count" id="adv-infer-count-${sid}"></span>
                </button>
            </div>
            <div class="adv-results" id="adv-results-${sid}"></div>
        </div>
    </div>`;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Toggle open/close ─────────────────────────────────────────────────
function toggleAdvanced(sid, symbol) {
    const body = document.getElementById(`adv-body-${sid}`);
    const wrap = document.getElementById(`adv-${sid}`);
    if (!body) return;
    const open = body.classList.toggle('hidden');  // toggle returns new state
    wrap?.querySelector('.adv-chevron')?.classList.toggle('rotated', !open);
    // Load status on first open
    if (!open && wrap?.dataset.loaded === 'false') {
        wrap.dataset.loaded = 'true';
        loadAdvancedStatus(symbol, sid);
    }
}

// ── Load button states + any cached inference result ─────────────────
async function loadAdvancedStatus(symbol, sid) {
    try {
        const [s, cached] = await Promise.all([
            fetch(`/api/advanced-status/${symbol}`).then(r => r.json()),
            fetch(`/api/inference/${symbol}`).then(r => r.json()),
        ]);
        applyBtnState(`adv-media-${sid}`, `adv-media-count-${sid}`, s.media.count,  s.media.lastFetch ? `${s.media.count} articles` : null);
        applyBtnState(`adv-fetch-${sid}`, `adv-fetch-count-${sid}`, s.prices.count, s.prices.hasFetch ? formatDate(s.prices.hasFetch) : null);
        applyBtnState(`adv-edgar-${sid}`, `adv-edgar-count-${sid}`, s.edgar.count,  s.edgar.count > 0  ? `${s.edgar.count} docs` : null);
        const hasAny = s.prices.count > 0 || s.edgar.count > 0 || s.media.count > 0;
        applyBtnState(`adv-infer-${sid}`, `adv-infer-count-${sid}`, hasAny ? 1 : 0, null);
        if (cached?.result) displayCachedInference(symbol, sid, cached);
    } catch { /* best-effort */ }
}

// Render a saved inference result below the buttons
function displayCachedInference(symbol, sid, cached) {
    const resultsDiv = document.getElementById(`adv-results-${sid}`);
    if (!resultsDiv) return;
    const ts = cached.created_at
        ? new Date(cached.created_at).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })
        : '';
    resultsDiv.innerHTML = `
        <div class="adv-inference-cached">
            <div class="adv-inference-hdr">
                <span class="adv-inference-ts">Analysis from ${ts}</span>
                <button class="adv-rerun-btn" onclick="advInfer('${symbol}','${sid}')">↺ Re-run</button>
            </div>
            <div class="adv-inference-output">${advRenderMd(cached.result)}</div>
        </div>`;
    applyBtnState(`adv-infer-${sid}`, `adv-infer-count-${sid}`, 1, formatDate(cached.created_at));
}

function applyBtnState(btnId, countId, count, label) {
    const btn   = document.getElementById(btnId);
    const cntEl = document.getElementById(countId);
    if (!btn) return;
    btn.classList.toggle('adv-btn--empty', count === 0);
    if (cntEl) cntEl.textContent = label || '';
}

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Shared result helpers ─────────────────────────────────────────────
function advShowResult(sid, html) {
    const el = document.getElementById(`adv-results-${sid}`);
    if (el) el.innerHTML = html;
}

function advSetBusy(btnId, busy, originalText) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = busy;
    if (busy) {
        btn.dataset.orig = btn.querySelector('.adv-btn-label')?.textContent || '';
        const lbl = btn.querySelector('.adv-btn-label');
        if (lbl) lbl.textContent = 'Working…';
    } else {
        const lbl = btn.querySelector('.adv-btn-label');
        if (lbl) lbl.textContent = btn.dataset.orig || originalText;
    }
}

// ── Button: Media Reports ─────────────────────────────────────────────
async function advMedia(symbol, sid) {
    advSetBusy(`adv-media-${sid}`, true);

    // Determine from-date: last media fetch, or start of price data
    let fromDate = null;
    try {
        const status = await fetch(`/api/advanced-status/${symbol}`).then(r => r.json());
        if (status.media.lastFetch) {
            fromDate = status.media.lastFetch.split('T')[0];
        } else if (state.prices[symbol]?.length) {
            fromDate = state.prices[symbol][0].date;
        }
    } catch { /* proceed without from-date */ }

    try {
        const res  = await fetch('/api/media/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, fromDate }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Reload and display articles
        const { articles } = await fetch(`/api/media/${symbol}`).then(r => r.json());
        const html = articles.length === 0
            ? '<div class="adv-empty">No articles found. Alpha Vantage NEWS_SENTIMENT may require a premium key for some symbols.</div>'
            : `<div class="adv-media-list">${articles.slice(0, 10).map(a => {
                const safeUrl = /^https?:\/\//i.test(a.url) ? escHtml(a.url) : null;
                const title   = escHtml(a.title || '—');
                const source  = escHtml(a.source || '—');
                const sent    = (a.sentiment_score||0);
                const sentCls = sent > 0 ? 'positive' : sent < 0 ? 'negative' : '';
                const sentTxt = a.sentiment_score != null ? (a.sentiment_score > 0 ? '+' : '') + a.sentiment_score.toFixed(2) : '';
                const titleEl = safeUrl
                    ? `<a class="adv-media-title" href="${safeUrl}" target="_blank" rel="noopener">${title}</a>`
                    : `<span class="adv-media-title">${title}</span>`;
                return `
                <div class="adv-media-item">
                    <div class="adv-media-meta">
                        <span class="adv-media-source">${source}</span>
                        <span class="adv-media-date">${a.published_at?.slice(0,10) || ''}</span>
                        <span class="adv-media-sent ${sentCls}">${sentTxt}</span>
                    </div>
                    ${titleEl}
                </div>`;
            }).join('')}
              </div>`;
        advShowResult(sid, html);
        applyBtnState(`adv-media-${sid}`, `adv-media-count-${sid}`, articles.length, `${articles.length} articles`);
    } catch(err) {
        advShowResult(sid, `<div class="adv-error">Media fetch failed: ${err.message}</div>`);
    }
    advSetBusy(`adv-media-${sid}`, false, 'Media Reports');
}

// ── Button: Fetch Data ────────────────────────────────────────────────
async function advFetch(symbol, sid) {
    advSetBusy(`adv-fetch-${sid}`, true);
    advShowResult(sid, '<div class="adv-info">Fetching price data…</div>');
    try {
        const res  = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        await loadPrices(symbol);
        renderCardChart(symbol);       // main grid card
        // Also re-render panel cards for this symbol
        for (const [name] of Object.entries(state.panels)) {
            if ((state.panels[name] || []).some(s => s.symbol === symbol)) {
                renderCardChart(symbol, name + '_');
            }
        }
        // Trigger model recompute in background
        fetch('/api/compute-models', { method: 'POST' }).catch(() => {});
        applyBtnState(`adv-fetch-${sid}`, `adv-fetch-count-${sid}`, 1, formatDate(new Date().toISOString()));
        advShowResult(sid, `<div class="adv-success">✓ Loaded ${data.count} weeks of price data. Models recomputing…</div>`);
    } catch(err) {
        advShowResult(sid, `<div class="adv-error">Fetch failed: ${err.message}</div>`);
    }
    advSetBusy(`adv-fetch-${sid}`, false, 'Fetch Data');
}

// Tracks active EDGAR polls so re-entry cancels the previous one (keyed by sid)
const _edgarPolls = new Map();

// ── Button: EDGAR ─────────────────────────────────────────────────────
async function advEdgar(symbol, sid) {
    // Cancel any poll already running for this button
    if (_edgarPolls.has(sid)) {
        clearInterval(_edgarPolls.get(sid));
        _edgarPolls.delete(sid);
    }

    advSetBusy(`adv-edgar-${sid}`, true);
    advShowResult(sid, '<div class="adv-info">Fetching SEC EDGAR filings… (may take 1–3 min)</div>');
    try {
        const startCount = (await fetch(`/api/advanced-status/${symbol}`).then(r => r.json())).edgar.count;
        const cutoff = state.prices[symbol]?.[0]?.date || '2021-01-01';
        const res  = await fetch('/api/fetch-transcripts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbols: [symbol], cutoff }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        advShowResult(sid, `<div class="adv-info">⏳ ${data.message} Polling for results…</div>`);

        // Poll until filing count increases beyond what was already stored
        const pollStart = Date.now();
        const poll = setInterval(async () => {
            if (Date.now() - pollStart > 300000) {
                clearInterval(poll);
                _edgarPolls.delete(sid);
                advSetBusy(`adv-edgar-${sid}`, false, 'EDGAR');
                return;
            }
            const status = await fetch(`/api/advanced-status/${symbol}`).then(r => r.json());
            if (status.edgar.count > startCount) {
                clearInterval(poll);
                _edgarPolls.delete(sid);
                applyBtnState(`adv-edgar-${sid}`, `adv-edgar-count-${sid}`, status.edgar.count, `${status.edgar.count} docs`);
                advShowResult(sid, `<div class="adv-success">✓ ${status.edgar.count} EDGAR documents stored (latest: ${status.edgar.lastDate?.slice(0,10) || '?'})</div>`);
                advSetBusy(`adv-edgar-${sid}`, false, 'EDGAR');
            }
        }, 8000);
        _edgarPolls.set(sid, poll);
    } catch(err) {
        advShowResult(sid, `<div class="adv-error">EDGAR fetch failed: ${err.message}</div>`);
        advSetBusy(`adv-edgar-${sid}`, false, 'EDGAR');
    }
}

// ── Button: Inference ─────────────────────────────────────────────────
async function advInfer(symbol, sid) {
    advSetBusy(`adv-infer-${sid}`, true);
    const resultsDiv = document.getElementById(`adv-results-${sid}`);
    if (!resultsDiv) return;

    // Streaming wrapper — output area for live text
    resultsDiv.innerHTML =
        `<div class="adv-inference-cached adv-inference-live">` +
            `<div class="adv-inference-hdr">` +
                `<span class="adv-inference-ts">Analyzing…</span>` +
            `</div>` +
            `<div class="adv-inference-output" id="adv-inf-out-${sid}"></div>` +
        `</div>`;
    const outputEl = document.getElementById(`adv-inf-out-${sid}`);

    let fullText = '';
    try {
        const response = await fetch(`/api/infer/${symbol}`, { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let renderScheduled = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') break;
                try {
                    const evt = JSON.parse(raw);
                    if (evt.text) {
                        fullText += evt.text;
                        if (outputEl && !renderScheduled) {
                            renderScheduled = true;
                            setTimeout(() => {
                                if (outputEl) outputEl.innerHTML = advRenderMd(fullText);
                                renderScheduled = false;
                            }, 150);
                        }
                    }
                } catch { /* skip */ }
            }
        }
        if (outputEl) outputEl.innerHTML = advRenderMd(fullText);
    } catch(err) {
        if (outputEl) outputEl.innerHTML = `<span class="adv-error">Inference error: ${err.message}</span>`;
    }

    // Replace the live header with the saved-result view
    if (fullText) {
        try {
            const cached = await fetch(`/api/inference/${symbol}`).then(r => r.json());
            if (cached?.result) displayCachedInference(symbol, sid, cached);
        } catch { /* leave the live output in place if fetch fails */ }
    }

    advSetBusy(`adv-infer-${sid}`, false, 'Inference');
}

// Minimal markdown renderer (headers, bold, lists, code, paragraphs)
function advRenderMd(md) {
    return md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^#{3} (.+)$/gm, '<h4>$1</h4>')
        .replace(/^#{2} (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h3>$1</h3>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/\n\n+/g, '</p><p>')
        .replace(/^(?!<[hul]|<\/[hul])(.+)$/gm, '$1')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
}

// ── Settings integration ──────────────────────────────────────────────
// Called by settings.js when user enables/disables a stock
function setAdvancedEnabled(symbol, enabled) {
    if (!settings.advancedStocks) settings.advancedStocks = [];
    if (enabled && !settings.advancedStocks.includes(symbol)) {
        settings.advancedStocks.push(symbol);
    } else if (!enabled) {
        settings.advancedStocks = settings.advancedStocks.filter(s => s !== symbol);
    }
    saveSettings();
    // Show/hide all adv-sections for this symbol across all cards
    document.querySelectorAll(`.adv-section[data-symbol="${symbol}"]`).forEach(el => {
        el.classList.toggle('hidden', !enabled);
    });
    if (typeof renderAdvancedChips === 'function') renderAdvancedChips();
    if (typeof populateAddStockDropdown === 'function') populateAddStockDropdown();
}
