/* TenX — Floating volume card manager & volume card stack.
   FloatingVolCards: opens a 5x-larger draggable volume popup per symbol.
   VolStack: panel that holds multiple expanded volume charts.              */

// ── FloatingVolCards ─────────────────────────────────────────────────────
const FloatingVolCards = (() => {
    const cards = {};
    let zTop    = 2500;
    let cascade = 0;

    const icon = {
        pin: f => `<svg width="12" height="12" viewBox="0 0 24 24" fill="${f?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`,
        stack: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="8" width="20" height="12" rx="2"/><path d="M6 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>`,
        close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    };

    function open(symbol, origCtx) {
        // Bring existing card to front instead of duplicating
        const dup = Object.keys(cards).find(id =>
            cards[id].symbol === symbol && cards[id].origCtx === (origCtx || '')
        );
        if (dup) { lift(cards[dup].el); return; }

        const id     = 'fvc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
        const fvcCtx = id + '_';
        const color  = (typeof COLORS !== 'undefined' ? COLORS[symbol] : null) || '#58A6FF';

        const cx = Math.min(80  + cascade * 28, window.innerWidth  - 620);
        const cy = Math.min(100 + cascade * 28, window.innerHeight - 460);
        cascade = (cascade + 1) % 8;

        const el = document.createElement('div');
        el.className = 'floating-vol-card';
        el.id = id;
        el.style.cssText = `left:${Math.max(8, cx)}px; top:${Math.max(8, cy)}px; z-index:${++zTop};`;
        el.style.setProperty('--fvc-color', color);

        el.innerHTML = `
        <div class="fvc-titlebar" id="fvc-tbar-${id}">
            <div class="fvc-drag-handle">
                <span style="color:${color};font-size:18px;font-weight:700;line-height:1">${symbol}</span>
                <span style="font-size:11px;color:var(--text3)">Daily Volume</span>
            </div>
            <div class="fvc-controls">
                <button class="fvc-btn" id="fvc-pin-${id}"
                        title="Pin — lock position"
                        onclick="FloatingVolCards.togglePin('${id}')">
                    ${icon.pin(false)}
                </button>
                <button class="fvc-btn" title="Add to Volume Stack"
                        onclick="VolStack.addVolume('${symbol}',''); FloatingVolCards.close('${id}')">
                    ${icon.stack}
                </button>
                <button class="fvc-btn fvc-btn-close" title="Close"
                        onclick="FloatingVolCards.close('${id}')">
                    ${icon.close}
                </button>
            </div>
        </div>
        <div class="fvc-canvas-wrap" id="fvc-wrap-${id}">
            <div class="fvc-loading" id="fvc-loading-${id}">
                <div class="spinner-inline"></div>
                <span>Loading daily data…</span>
            </div>
            <canvas id="vol-canvas-${fvcCtx}${symbol}" style="display:none"></canvas>
        </div>
        <div class="vol-model hidden" id="vol-model-${fvcCtx}${symbol}"></div>`;

        document.body.appendChild(el);
        cards[id] = { el, symbol, origCtx: origCtx || '', fvcCtx, pinned: false };

        // Fetch daily vol data, then render
        fetch(`/api/daily-vol?symbol=${encodeURIComponent(symbol)}`)
            .then(r => r.json())
            .then(data => {
                if (!cards[id]) return;  // card was closed while loading
                const loading = document.getElementById(`fvc-loading-${id}`);
                const canvas  = document.getElementById(`vol-canvas-${fvcCtx}${symbol}`);

                if (!data.prices?.length) {
                    if (loading) {
                        loading.innerHTML = '<span style="color:var(--text3);font-size:11px;text-align:center;padding:0 16px">Daily data unavailable<br><span style="font-size:10px;opacity:.7">API limit reached — try again tomorrow</span></span>';
                    }
                    return;
                }

                if (loading) loading.style.display = 'none';
                if (canvas)  canvas.style.display  = '';

                if (typeof state !== 'undefined') state.dailyVol[symbol] = data.prices;
                if (typeof doRenderDailyVolChart === 'function') {
                    requestAnimationFrame(() => doRenderDailyVolChart(symbol, fvcCtx));
                }
            })
            .catch(err => {
                if (!cards[id]) return;
                const loading = document.getElementById(`fvc-loading-${id}`);
                if (loading) loading.textContent = 'Failed to load daily data.';
                console.error('[FloatingVolCards] daily-vol fetch error:', err);
            });

        makeDraggable(el, id);
        el.addEventListener('mousedown', () => lift(el), true);
    }

    function close(id) {
        const c = cards[id];
        if (!c) return;
        const key = c.fvcCtx + c.symbol;
        if (typeof state !== 'undefined' && state.volCharts[key]) {
            state.volCharts[key].destroy();
            delete state.volCharts[key];
        }
        c.el.remove();
        delete cards[id];
    }

    function togglePin(id) {
        const c = cards[id];
        if (!c) return;
        c.pinned = !c.pinned;
        c.el.classList.toggle('fvc-pinned', c.pinned);
        const btn = document.getElementById(`fvc-pin-${id}`);
        if (btn) {
            btn.innerHTML = icon.pin(c.pinned);
            btn.title     = c.pinned ? 'Unpin — allow dragging' : 'Pin — lock position';
            btn.classList.toggle('fvc-btn-active', c.pinned);
        }
        const tbar = document.getElementById(`fvc-tbar-${id}`);
        if (tbar) tbar.style.cursor = c.pinned ? 'default' : '';
    }

    function lift(el) { el.style.zIndex = ++zTop; }

    function makeDraggable(el, id) {
        const handle = el.querySelector('.fvc-titlebar');
        if (!handle) return;
        let ox, oy, ol, ot;

        handle.addEventListener('mousedown', e => {
            if (e.target.closest('.fvc-controls')) return;
            if (cards[id]?.pinned) return;
            lift(el);
            const r = el.getBoundingClientRect();
            ox = e.clientX; oy = e.clientY; ol = r.left; ot = r.top;
            el.classList.add('fvc-dragging');

            const move = e => {
                el.style.left = Math.max(0, ol + e.clientX - ox) + 'px';
                el.style.top  = Math.max(0, ot + e.clientY - oy) + 'px';
            };
            const up = () => {
                el.classList.remove('fvc-dragging');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup',   up);
                document.removeEventListener('visibilitychange', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup',   up);
            document.addEventListener('visibilitychange', up);
            e.preventDefault();
        });
    }

    return { open, close, togglePin };
})();

// ── VolStack ─────────────────────────────────────────────────────────────
const VolStack = (() => {
    let volumes      = [];   // [{ symbol, origCtx }]
    let active       = 0;
    let mode         = 'list';
    let el           = null;
    let vsBody       = null;
    let _listRendered  = new Set();  // symbols currently rendered in list mode
    let _lastRenderMode = null;
    let zTop    = 3500;

    const CTX = sym => `vs_${sym}_`;

    const ICON_STACK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="8" width="20" height="12" rx="2"/><path d="M6 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>`;
    const ICON_LIST  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="3" cy="18" r="1" fill="currentColor"/></svg>`;

    function ensureInit() {
        if (el) return;

        el = document.createElement('div');
        el.id = 'volStack';
        el.className = 'vol-stack';
        el.style.cssText = `left:${Math.max(20, window.innerWidth - 660)}px; top:80px; z-index:${zTop};`;

        el.innerHTML = `
            <div class="vs-titlebar" id="vs-titlebar">
                <div class="vs-drag-handle">
                    <span class="vs-title">Volume Stack</span>
                    <span class="vs-count" id="vs-count"></span>
                </div>
                <div class="vs-controls">
                    <button class="vs-btn" id="vs-mode-btn"
                            title="Switch to stack view">${ICON_STACK}</button>
                    <button class="vs-btn vs-btn-close" title="Close"
                            onclick="VolStack.hide()">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2.5">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="vs-body" id="vs-body"></div>`;

        document.body.appendChild(el);
        vsBody = document.getElementById('vs-body');

        document.getElementById('vs-mode-btn').addEventListener('click', toggleMode);

        // Drag
        const tbar = document.getElementById('vs-titlebar');
        let ox, oy, ol, ot;
        tbar.addEventListener('mousedown', e => {
            if (e.target.closest('.vs-controls')) return;
            const r = el.getBoundingClientRect();
            ox = e.clientX; oy = e.clientY; ol = r.left; ot = r.top;
            el.classList.add('vs-dragging');
            const move = ev => {
                el.style.left = Math.max(0, ol + ev.clientX - ox) + 'px';
                el.style.top  = Math.max(0, ot + ev.clientY - oy) + 'px';
            };
            const up = () => {
                el.classList.remove('vs-dragging');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup',   up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup',   up);
            e.preventDefault();
        });

        // Wheel scroll cycles in stack mode
        vsBody.addEventListener('wheel', e => {
            if (mode !== 'stack' || volumes.length < 2) return;
            e.preventDefault();
            active = (active + (e.deltaY > 0 ? 1 : -1) + volumes.length) % volumes.length;
            renderBody();
        }, { passive: false });

        el.addEventListener('mousedown', () => { el.style.zIndex = ++zTop; }, true);
    }

    // ── Public: add a volume view ──────────────────────────────────────
    function addVolume(symbol, origCtx) {
        const existing = volumes.findIndex(v => v.symbol === symbol);
        if (existing >= 0) {
            active = existing;
            show(); renderBody(); return;
        }
        volumes.push({ symbol, origCtx: origCtx || '' });
        active = volumes.length - 1;
        show();
        renderBody();
    }

    // ── Public: remove ─────────────────────────────────────────────────
    function remove(symbol) {
        destroyCharts([symbol]);
        const idx = volumes.findIndex(v => v.symbol === symbol);
        if (idx < 0) return;
        volumes.splice(idx, 1);
        active = Math.min(active, Math.max(0, volumes.length - 1));
        if (!volumes.length) { hide(); return; }
        renderBody();
    }

    // ── Public: show / hide ────────────────────────────────────────────
    function show() {
        ensureInit();
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
    }

    function hide() { if (el) el.style.display = 'none'; }

    // ── Public: toggle list ↔ stack mode ──────────────────────────────
    function toggleMode() {
        mode = (mode === 'list') ? 'stack' : 'list';
        const btn = document.getElementById('vs-mode-btn');
        if (btn) {
            btn.innerHTML = (mode === 'stack') ? ICON_LIST : ICON_STACK;
            btn.title     = (mode === 'stack') ? 'Switch to list view' : 'Switch to stack view';
        }
        renderBody();
    }

    function destroyCharts(symbols) {
        if (typeof state === 'undefined') return;
        const syms = symbols || volumes.map(v => v.symbol);
        for (const sym of syms) {
            const key = CTX(sym) + sym;
            if (state.volCharts[key]) { state.volCharts[key].destroy(); delete state.volCharts[key]; }
        }
    }

    function renderBody() {
        if (!vsBody) return;

        const cnt = document.getElementById('vs-count');
        if (cnt) cnt.textContent = volumes.length ? `(${volumes.length})` : '';

        if (!volumes.length) {
            destroyCharts();
            vsBody.innerHTML = `<div class="vs-empty">
                No volume charts yet.<br>
                Click <span style="opacity:.7">⊞</span> on a floating volume card to add.
            </div>`;
            _listRendered.clear();
            _lastRenderMode = null;
            return;
        }

        mode === 'list' ? renderListMode() : renderStackMode();
    }

    function buildVolEntry(symbol) {
        const color = (typeof COLORS !== 'undefined' ? COLORS[symbol] : null) || '#58A6FF';
        const wrap = document.createElement('div');
        wrap.className = 'vs-vol-wrap';

        const hdr = document.createElement('div');
        hdr.className = 'vs-vol-hdr';
        hdr.innerHTML = `
            <span style="color:${color};font-size:13px;font-weight:700">${symbol}</span>
            <span style="font-size:11px;color:var(--text3)">Volume</span>
            <button class="vs-remove-btn" title="Remove ${symbol}"
                    onclick="VolStack.remove('${symbol}')">×</button>`;
        wrap.appendChild(hdr);

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'vs-canvas-wrap';
        const canvas = document.createElement('canvas');
        canvas.id = `vol-canvas-${CTX(symbol)}${symbol}`;
        canvasWrap.appendChild(canvas);
        wrap.appendChild(canvasWrap);

        return wrap;
    }

    function renderListMode() {
        // Full rebuild needed when switching from stack mode
        if (_lastRenderMode !== 'list') {
            destroyCharts();
            vsBody.innerHTML = '';
            _listRendered.clear();
        }
        _lastRenderMode = 'list';
        vsBody.style.overflowY = 'auto';

        const currentSyms = new Set(volumes.map(v => v.symbol));

        // Remove symbols no longer in volumes
        for (const sym of [..._listRendered]) {
            if (!currentSyms.has(sym)) {
                destroyCharts([sym]);
                document.getElementById(`vol-canvas-${CTX(sym)}${sym}`)
                    ?.closest('.vs-vol-wrap')?.remove();
                _listRendered.delete(sym);
            }
        }

        // Append new symbols
        for (const { symbol } of volumes) {
            if (!_listRendered.has(symbol)) {
                const wrap = buildVolEntry(symbol);
                vsBody.appendChild(wrap);
                if (typeof doRenderVolumeChart === 'function' &&
                    typeof state !== 'undefined' && state.prices[symbol]?.length) {
                    requestAnimationFrame(() => doRenderVolumeChart(symbol, CTX(symbol)));
                }
                _listRendered.add(symbol);
            }
        }
    }

    function renderStackMode() {
        destroyCharts();
        vsBody.innerHTML = '';
        _listRendered.clear();
        _lastRenderMode = 'stack';
        vsBody.style.overflowY = 'hidden';

        // Active card
        const { symbol } = volumes[active];
        const wrap = buildVolEntry(symbol);
        vsBody.appendChild(wrap);
        if (typeof doRenderVolumeChart === 'function' &&
            typeof state !== 'undefined' && state.prices[symbol]?.length) {
            requestAnimationFrame(() => doRenderVolumeChart(symbol, CTX(symbol)));
        }

        // Stub rows for remaining entries
        for (let i = 0; i < volumes.length; i++) {
            if (i === active) continue;
            const { symbol: s } = volumes[i];
            const color = (typeof COLORS !== 'undefined' ? COLORS[s] : null) || '#58A6FF';
            const captI = i;

            const stub = document.createElement('div');
            stub.className = 'vs-stub';
            stub.title = `Click or scroll to bring ${s} to front`;
            stub.innerHTML = `
                <span style="color:${color};font-size:13px;font-weight:700;flex-shrink:0;min-width:50px">${s}</span>
                <span style="font-size:11px;color:var(--text3);flex:1">Volume</span>
                <button class="vs-stub-remove" title="Remove"
                        onclick="VolStack.remove('${s}')">×</button>`;
            stub.addEventListener('click', e => {
                if (e.target.classList.contains('vs-stub-remove')) return;
                active = captI;
                renderBody();
            });
            vsBody.appendChild(stub);
        }

        if (volumes.length > 1) {
            const hint = document.createElement('div');
            hint.className = 'vs-hint';
            hint.textContent = `${active + 1} / ${volumes.length}  ·  scroll to cycle`;
            vsBody.appendChild(hint);
        }
    }

    return { addVolume, remove, show, hide, toggleMode };
})();
