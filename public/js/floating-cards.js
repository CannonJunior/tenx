/* TenX — Floating card manager.
   Double-clicking any chart-card opens a detached, draggable copy.
   Each floating card has its own Chart.js instance via a unique ctx prefix
   so it never conflicts with grid/panel card IDs.                         */

const FloatingCards = (() => {
    const cards = {};   // id → { el, symbol, stock, ctx, pinned, expanded }
    let zTop     = 2000;
    let cascade  = 0;

    // ── SVG icon helpers ──────────────────────────────────────────────
    const icon = {
        expand:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
        contract: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`,
        pin: f =>  `<svg width="12" height="12" viewBox="0 0 24 24" fill="${f?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`,
        stack:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="8" width="20" height="12" rx="2"/><path d="M6 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>`,
        close:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    };

    // ── Open a new floating card ──────────────────────────────────────
    function open(stock, originSid) {
        const id    = 'fc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
        const ctx   = id + '_';
        const sid   = ctx + stock.symbol;
        const color = (typeof COLORS !== 'undefined' ? COLORS[stock.symbol] : null) || '#58A6FF';

        // Cascade position: offset each new card from previous
        const cx = Math.min(100 + cascade * 30, window.innerWidth  - 420);
        const cy = Math.min( 90 + cascade * 30, window.innerHeight - 380);
        cascade = (cascade + 1) % 9;

        const el = document.createElement('div');
        el.className = 'floating-card';
        el.id = id;
        el.style.cssText = `left:${cx}px; top:${cy}px; z-index:${++zTop};`;
        el.style.setProperty('--fc-accent', color);

        el.innerHTML = buildHTML(stock, id, ctx, sid);
        document.body.appendChild(el);

        cards[id] = { el, symbol: stock.symbol, stock, ctx, pinned: false, expanded: false };

        // Render chart using shared prices
        if (typeof state !== 'undefined' && state.prices[stock.symbol]?.length) {
            renderCardChart(stock.symbol, ctx);
        }

        makeDraggable(el, id);

        // Bring to front on any click inside
        el.addEventListener('mousedown', () => lift(el), true);
    }

    // ── Build inner HTML ──────────────────────────────────────────────
    function buildHTML(stock, id, ctx, sid) {
        const adv = (typeof buildAdvancedSection === 'function')
            ? buildAdvancedSection(stock, sid) : '';

        return `
        <div class="fc-titlebar" id="fc-tbar-${id}">
            <div class="fc-drag-handle">
                <span class="fc-symbol" style="color:var(--fc-accent)">${stock.symbol}</span>
                <span class="fc-name">${stock.name}</span>
            </div>
            <div class="fc-controls">
                <button class="fc-btn" id="fc-expand-${id}"
                        title="Expand" onclick="FloatingCards.toggleExpand('${id}')">
                    ${icon.expand}
                </button>
                <button class="fc-btn" id="fc-pin-${id}"
                        title="Pin — lock position" onclick="FloatingCards.togglePin('${id}')">
                    ${icon.pin(false)}
                </button>
                <button class="fc-btn" id="fc-stack-${id}"
                        title="Add to Card Stack"
                        onclick="CardStack.addBySymbol('${stock.symbol}'); FloatingCards.close('${id}')">
                    ${icon.stack}
                </button>
                <button class="fc-btn fc-btn-close"
                        title="Close" onclick="FloatingCards.close('${id}')">
                    ${icon.close}
                </button>
            </div>
        </div>

        <div class="fc-price-row">
            <span class="fc-price"  id="price-${sid}">—</span>
            <span class="fc-change neutral" id="chg-${sid}">—</span>
            <span class="fc-target neutral" id="target-${sid}"></span>
        </div>

        <div id="body-${sid}">
            <div class="card-no-data" style="height:var(--card-chart-height,180px)">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1.5">
                    <path d="M3 3v18h18"/><polyline points="7 16 11 12 14 15 20 9"/>
                </svg>
                No data
            </div>
        </div>

        <div class="card-footer fc-footer">
            <span id="range-${sid}">—</span>
            <span id="pts-${sid}"></span>
        </div>
        ${adv}`;
    }

    // ── Close ─────────────────────────────────────────────────────────
    function close(id) {
        const c = cards[id];
        if (!c) return;
        const key = c.ctx + c.symbol;
        if (typeof state !== 'undefined' && state.charts[key]) {
            state.charts[key].destroy();
            delete state.charts[key];
        }
        c.el.remove();
        delete cards[id];
    }

    // ── Expand / contract ─────────────────────────────────────────────
    function toggleExpand(id) {
        const c = cards[id];
        if (!c) return;
        c.expanded = !c.expanded;
        c.el.classList.toggle('fc-expanded', c.expanded);
        const btn = document.getElementById(`fc-expand-${id}`);
        if (btn) {
            btn.innerHTML = c.expanded ? icon.contract : icon.expand;
            btn.title     = c.expanded ? 'Contract' : 'Expand';
        }
        // Re-render chart to fill new width after CSS transition
        if (typeof state !== 'undefined' && state.prices[c.symbol]?.length) {
            setTimeout(() => renderCardChart(c.symbol, c.ctx), 220);
        }
    }

    // ── Pin / unpin ───────────────────────────────────────────────────
    function togglePin(id) {
        const c = cards[id];
        if (!c) return;
        c.pinned = !c.pinned;
        c.el.classList.toggle('fc-pinned', c.pinned);
        const btn = document.getElementById(`fc-pin-${id}`);
        if (btn) {
            btn.innerHTML = icon.pin(c.pinned);
            btn.title     = c.pinned ? 'Unpin — allow dragging' : 'Pin — lock position';
            btn.classList.toggle('fc-btn-active', c.pinned);
        }
        // Visual cue on drag handle
        const tbar = document.getElementById(`fc-tbar-${id}`);
        if (tbar) tbar.style.cursor = c.pinned ? 'default' : '';
    }

    // ── Lift to front ─────────────────────────────────────────────────
    function lift(el) {
        el.style.zIndex = ++zTop;
    }

    // ── Mouse-drag ────────────────────────────────────────────────────
    function makeDraggable(el, id) {
        const handle = el.querySelector('.fc-titlebar');
        if (!handle) return;
        let ox, oy, ol, ot;

        handle.addEventListener('mousedown', e => {
            if (e.target.closest('.fc-controls')) return;  // don't drag when clicking buttons
            if (cards[id]?.pinned) return;
            lift(el);
            const r = el.getBoundingClientRect();
            ox = e.clientX; oy = e.clientY;
            ol = r.left;    ot = r.top;
            el.classList.add('fc-dragging');

            const move = e => {
                el.style.left = Math.max(0, ol + e.clientX - ox) + 'px';
                el.style.top  = Math.max(0, ot + e.clientY - oy) + 'px';
            };
            const up = () => {
                el.classList.remove('fc-dragging');
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

    return { open, close, toggleExpand, togglePin };
})();
