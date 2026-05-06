/* TenX — Card Stack
   A draggable panel that holds chart-cards added from floating cards.
   Two display modes:
     list  — cards stacked vertically, scrollable (mirrors leftCol)
     stack — one card fully shown; others visible as slim stub rows;
             mouse-scroll cycles which card is on top                  */

const CardStack = (() => {
    let stocks = [];    // [{ symbol, stock }]  ordered; stack top = stocks[active]
    let active = 0;
    let mode   = 'list';
    let el     = null;
    let csBody = null;
    let zTop   = 3000;

    const CTX = sym => `cs_${sym}_`;  // unique ctx prefix for this panel

    // ── Icons ─────────────────────────────────────────────────────────
    const ICON_STACK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="8" width="20" height="12" rx="2"/><path d="M6 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>`;
    const ICON_LIST  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="3" cy="18" r="1" fill="currentColor"/></svg>`;

    // ── Lazy init — creates DOM on first use ──────────────────────────
    function ensureInit() {
        if (el) return;

        el = document.createElement('div');
        el.id = 'cardStack';
        el.className = 'card-stack';
        el.style.cssText = `left:${Math.max(20, window.innerWidth - 420)}px; top:80px; z-index:${zTop};`;

        el.innerHTML = `
            <div class="cs-titlebar" id="cs-titlebar">
                <div class="cs-drag-handle">
                    <span class="cs-title">Card Stack</span>
                    <span class="cs-count" id="cs-count"></span>
                </div>
                <div class="cs-controls">
                    <button class="cs-btn" id="cs-mode-btn"
                            title="Switch to stack view">${ICON_STACK}</button>
                    <button class="cs-btn cs-btn-close" title="Close"
                            onclick="CardStack.hide()">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2.5">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="cs-body" id="cs-body"></div>`;

        document.body.appendChild(el);
        csBody = document.getElementById('cs-body');

        // Mode toggle
        document.getElementById('cs-mode-btn').addEventListener('click', toggleMode);

        // Drag
        const tbar = document.getElementById('cs-titlebar');
        let ox, oy, ol, ot;
        tbar.addEventListener('mousedown', e => {
            if (e.target.closest('.cs-controls')) return;
            const r = el.getBoundingClientRect();
            ox = e.clientX; oy = e.clientY; ol = r.left; ot = r.top;
            el.classList.add('cs-dragging');
            const move = ev => {
                el.style.left = Math.max(0, ol + ev.clientX - ox) + 'px';
                el.style.top  = Math.max(0, ot + ev.clientY - oy) + 'px';
            };
            const up = () => {
                el.classList.remove('cs-dragging');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup',   up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup',   up);
            e.preventDefault();
        });

        // Mouse-scroll to cycle cards in stack mode
        csBody.addEventListener('wheel', e => {
            if (mode !== 'stack' || stocks.length < 2) return;
            e.preventDefault();
            active = (active + (e.deltaY > 0 ? 1 : -1) + stocks.length) % stocks.length;
            renderBody();
        }, { passive: false });

        // Z-index lift on click
        el.addEventListener('mousedown', () => { el.style.zIndex = ++zTop; }, true);
    }

    // ── Public: add a stock ───────────────────────────────────────────
    function addBySymbol(symbol) {
        // Find stock metadata across all sources
        const all   = typeof state !== 'undefined'
            ? [...state.stocks, ...Object.values(state.panels).flat()] : [];
        const seen  = new Map();
        all.forEach(s => seen.set(s.symbol, s));
        const stock = seen.get(symbol);
        if (!stock) return;

        const existing = stocks.findIndex(s => s.symbol === symbol);
        if (existing >= 0) {
            // Already present — just surface it
            active = existing;
            show(); renderBody(); return;
        }

        stocks.push({ symbol, stock });
        active = stocks.length - 1;   // new card goes to top in stack mode
        show();
        renderBody();
    }

    // ── Public: remove a stock ────────────────────────────────────────
    function remove(symbol) {
        destroyCharts([symbol]);
        const idx = stocks.findIndex(s => s.symbol === symbol);
        if (idx < 0) return;
        stocks.splice(idx, 1);
        active = Math.min(active, Math.max(0, stocks.length - 1));
        if (!stocks.length) { hide(); return; }
        renderBody();
    }

    // ── Public: show / hide ───────────────────────────────────────────
    function show() {
        ensureInit();
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
    }

    function hide() {
        if (el) el.style.display = 'none';
    }

    // ── Public: toggle list ↔ stack mode ─────────────────────────────
    function toggleMode() {
        mode = (mode === 'list') ? 'stack' : 'list';
        const btn = document.getElementById('cs-mode-btn');
        if (btn) {
            btn.innerHTML = (mode === 'stack') ? ICON_LIST : ICON_STACK;
            btn.title     = (mode === 'stack') ? 'Switch to list view' : 'Switch to stack view';
        }
        renderBody();
    }

    // ── Internal: destroy chart instances ────────────────────────────
    function destroyCharts(symbols) {
        const syms = symbols || stocks.map(s => s.symbol);
        if (typeof state === 'undefined') return;
        for (const sym of syms) {
            const key = CTX(sym) + sym;
            if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
        }
    }

    // ── Internal: render dispatch ─────────────────────────────────────
    function renderBody() {
        if (!csBody) return;
        destroyCharts();
        csBody.innerHTML = '';

        const cnt = document.getElementById('cs-count');
        if (cnt) cnt.textContent = stocks.length ? `(${stocks.length})` : '';

        if (!stocks.length) {
            csBody.innerHTML = `<div class="cs-empty">
                No cards yet.<br>Click <span style="opacity:.7">⊞</span> on a floating card to add.
            </div>`;
            return;
        }

        mode === 'list' ? renderListMode() : renderStackMode();
    }

    // ── List mode — mirrors leftCol panel layout ──────────────────────
    function renderListMode() {
        csBody.style.overflowY = 'auto';

        for (const { symbol, stock } of stocks) {
            const ctx = CTX(symbol);

            const wrap = document.createElement('div');
            wrap.className = 'cs-card-wrap';

            const rm = document.createElement('button');
            rm.className = 'cs-remove-btn';
            rm.title = `Remove ${symbol} from stack`;
            rm.textContent = '×';
            rm.onclick = () => remove(symbol);
            wrap.appendChild(rm);

            const card = (typeof buildCard === 'function')
                ? buildCard(stock, ctx) : document.createElement('div');
            wrap.appendChild(card);
            csBody.appendChild(wrap);

            if (typeof renderCardChart === 'function' &&
                typeof state !== 'undefined' && state.prices[symbol]?.length) {
                requestAnimationFrame(() => renderCardChart(symbol, ctx));
            }
        }
    }

    // ── Stack mode — top card full, others as stub rows ───────────────
    function renderStackMode() {
        csBody.style.overflowY = 'hidden';

        // ── Active (top) card ─────────────────────────────────────────
        const { symbol, stock } = stocks[active];
        const ctx = CTX(symbol);

        const activeWrap = document.createElement('div');
        activeWrap.className = 'cs-stack-active';

        const rm = document.createElement('button');
        rm.className = 'cs-remove-btn cs-remove-top';
        rm.title = `Remove ${symbol} from stack`;
        rm.textContent = '×';
        rm.onclick = () => remove(symbol);
        activeWrap.appendChild(rm);

        const card = (typeof buildCard === 'function')
            ? buildCard(stock, ctx) : document.createElement('div');
        activeWrap.appendChild(card);
        csBody.appendChild(activeWrap);

        if (typeof renderCardChart === 'function' &&
            typeof state !== 'undefined' && state.prices[symbol]?.length) {
            requestAnimationFrame(() => renderCardChart(symbol, ctx));
        }

        // ── Stub rows for every other card ────────────────────────────
        for (let i = 0; i < stocks.length; i++) {
            if (i === active) continue;
            const { symbol: s, stock: st } = stocks[i];
            const prices = (typeof state !== 'undefined') ? state.prices[s] : null;
            const last   = prices?.length ? prices[prices.length - 1].close : null;
            const chg    = (typeof calcChange === 'function') ? calcChange(prices) : null;
            const color  = (typeof COLORS !== 'undefined' ? COLORS[s] : null) || '#58A6FF';
            const captI  = i;   // close over loop var

            const stub = document.createElement('div');
            stub.className = 'cs-stub';
            stub.title = `Click or scroll to bring ${s} to front`;
            stub.innerHTML = `
                <span class="cs-stub-sym" style="color:${color}">${s}</span>
                <span class="cs-stub-name">${st.name}</span>
                <span class="cs-stub-price">${last != null ? '$' + last.toFixed(2) : '—'}</span>
                <span class="cs-stub-chg ${chg == null ? '' : chg >= 0 ? 'positive' : 'negative'}">
                    ${chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%' : ''}</span>
                <button class="cs-stub-remove" title="Remove" onclick="CardStack.remove('${s}')">×</button>`;
            stub.addEventListener('click', e => {
                if (e.target.classList.contains('cs-stub-remove')) return;
                active = captI;
                renderBody();
            });
            csBody.appendChild(stub);
        }

        // Position counter + scroll hint
        if (stocks.length > 1) {
            const hint = document.createElement('div');
            hint.className = 'cs-hint';
            hint.textContent = `${active + 1} / ${stocks.length}  ·  scroll to cycle`;
            csBody.appendChild(hint);
        }
    }

    return { addBySymbol, remove, show, hide, toggleMode };
})();
