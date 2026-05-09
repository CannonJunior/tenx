const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'stock-data.db'));
db.pragma('journal_mode = WAL');

// ── Core tables ───────────────────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS inference_cache (
        symbol     TEXT PRIMARY KEY,
        result     TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS media (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol          TEXT NOT NULL,
        published_at    TEXT NOT NULL,
        title           TEXT,
        url             TEXT,
        source          TEXT,
        summary         TEXT,
        sentiment_score REAL,
        relevance_score REAL,
        fetched_at      TEXT DEFAULT (datetime('now')),
        UNIQUE(symbol, url)
    );

    CREATE TABLE IF NOT EXISTS media_fetch_log (
        symbol        TEXT PRIMARY KEY,
        last_fetched  TEXT NOT NULL,
        article_count INTEGER DEFAULT 0
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS daily_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL,
        volume INTEGER,
        UNIQUE(symbol, date)
    );

    CREATE TABLE IF NOT EXISTS fetch_log (
        symbol TEXT PRIMARY KEY,
        last_fetched TEXT NOT NULL,
        status TEXT DEFAULT 'success',
        row_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS earnings (
        symbol       TEXT NOT NULL,
        fiscal_date  TEXT NOT NULL,
        reported_date TEXT NOT NULL,
        reported_eps  REAL,
        estimated_eps REAL,
        surprise_pct  REAL,
        PRIMARY KEY (symbol, fiscal_date)
    );

    CREATE TABLE IF NOT EXISTS indicators (
        symbol       TEXT NOT NULL,
        date         TEXT NOT NULL,
        close        REAL,
        rsi          REAL,
        macd_line    REAL,
        macd_signal  REAL,
        macd_hist    REAL,
        bb_upper     REAL,
        bb_mid       REAL,
        bb_lower     REAL,
        bb_pct       REAL,
        vol_ratio    REAL,
        roc_4w       REAL,
        roc_12w      REAL,
        hi_52w       REAL,
        peer_rank    REAL,
        score        REAL,
        score_rsi    REAL,
        score_macd   REAL,
        score_bb     REAL,
        score_vol    REAL,
        score_peer   REAL,
        score_eps    REAL,
        PRIMARY KEY (symbol, date)
    );

    CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol      TEXT NOT NULL,
        date        TEXT NOT NULL,
        type        TEXT NOT NULL,
        score       REAL,
        description TEXT,
        fwd_4w      REAL,
        fwd_8w      REAL,
        fwd_12w     REAL,
        UNIQUE(symbol, date, type)
    );

    CREATE TABLE IF NOT EXISTS sector_health (
        date  TEXT PRIMARY KEY,
        score REAL
    );

    CREATE TABLE IF NOT EXISTS model_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcripts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol         TEXT NOT NULL,
        filed_date     TEXT NOT NULL,
        fiscal_year    INTEGER,
        fiscal_quarter INTEGER,
        title          TEXT,
        text           TEXT,
        word_count     INTEGER,
        has_qa         INTEGER DEFAULT 0,
        source_type    TEXT DEFAULT 'unknown',
        filing_url     TEXT,
        accession      TEXT,
        UNIQUE(symbol, accession, source_type)
    );

    CREATE TABLE IF NOT EXISTS transcript_signals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        transcript_id   INTEGER NOT NULL,
        symbol          TEXT NOT NULL,
        filed_date      TEXT NOT NULL,
        fiscal_year     INTEGER,
        fiscal_quarter  INTEGER,
        word_count      INTEGER,
        has_qa          INTEGER DEFAULT 0,
        prepared_words  INTEGER,
        qa_words        INTEGER,
        sentiment_score REAL,
        ai_dc_mentions  INTEGER,
        demand_pos      INTEGER,
        demand_neg      INTEGER,
        pricing_pos     INTEGER,
        pricing_neg     INTEGER,
        memory_mentions INTEGER,
        equip_mentions  INTEGER,
        guidance_up     INTEGER,
        guidance_down   INTEGER,
        positive_words  INTEGER,
        negative_words  INTEGER,
        UNIQUE(transcript_id)
    );

    CREATE TABLE IF NOT EXISTS scheduler_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id       TEXT NOT NULL,
        triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
        status       TEXT NOT NULL,
        message      TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        type       TEXT NOT NULL,
        message    TEXT NOT NULL,
        symbols    TEXT NOT NULL DEFAULT '[]',
        read       INTEGER NOT NULL DEFAULT 0
    );
`);

// ── Schema migrations (idempotent) ────────────────────────────────────
(function migrate() {
    const indCols  = new Set(db.prepare('PRAGMA table_info(indicators)').all().map(c => c.name));
    const sigCols  = new Set(db.prepare('PRAGMA table_info(signals)').all().map(c => c.name));

    const addInd = (col, type) => {
        if (!indCols.has(col)) db.exec(`ALTER TABLE indicators ADD COLUMN ${col} ${type}`);
    };
    const addSig = (col, type) => {
        if (!sigCols.has(col)) db.exec(`ALTER TABLE signals ADD COLUMN ${col} ${type}`);
    };

    // New transcript column
    const trCols = new Set(db.prepare('PRAGMA table_info(transcripts)').all().map(c => c.name));
    if (!trCols.has('source_type')) db.exec("ALTER TABLE transcripts ADD COLUMN source_type TEXT DEFAULT 'unknown'");

    // New indicator columns
    addInd('obv_roc4',     'REAL');
    addInd('dist_200w',    'REAL');
    addInd('dist_50w',     'REAL');
    addInd('golden_cross', 'INTEGER');
    addInd('confluence',   'INTEGER');
    addInd('score_obv',    'REAL');
    addInd('score_ma',     'REAL');

    // Sector health on signals (for regime conditioning)
    addSig('sector_health', 'REAL');
})();

// ── Indexes (idempotent) ──────────────────────────────────────────────
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prices_sym_date  ON daily_prices(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_indicators_sym   ON indicators(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_signals_sym      ON signals(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_media_sym_pub    ON media(symbol, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcripts_sym  ON transcripts(symbol, filed_date DESC);
    CREATE INDEX IF NOT EXISTS idx_ts_sym           ON transcript_signals(symbol, filed_date ASC);
    CREATE INDEX IF NOT EXISTS idx_scheduler_log    ON scheduler_log(job_id, triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications    ON notifications(created_at DESC);
`);

// ── Pre-compiled statements ───────────────────────────────────────────
const _savePrice             = db.prepare('INSERT OR REPLACE INTO daily_prices (symbol,date,close,volume) VALUES (?,?,?,?)');
const _saveFetchLog          = db.prepare('INSERT OR REPLACE INTO fetch_log (symbol,last_fetched,status,row_count) VALUES (?,?,?,?)');
const _getPrices             = db.prepare('SELECT date,close,volume FROM daily_prices WHERE symbol=? AND date>=? ORDER BY date ASC');
const _getPricesAll          = db.prepare('SELECT date,close,volume FROM daily_prices WHERE symbol=? ORDER BY date ASC');
const _hasPrices             = db.prepare('SELECT COUNT(*) as n FROM daily_prices WHERE symbol=?');
const _hasVolumeData         = db.prepare('SELECT COUNT(*) as n FROM daily_prices WHERE symbol=? AND volume > 0');
const _getLastPriceDate      = db.prepare('SELECT MAX(date) as d FROM daily_prices WHERE symbol=?');
const _touchFetchLog         = db.prepare(
    'INSERT INTO fetch_log (symbol,last_fetched,status,row_count) VALUES (?,?,?,0) ' +
    'ON CONFLICT(symbol) DO UPDATE SET last_fetched=excluded.last_fetched, status=excluded.status'
);
const _getFetchLog           = db.prepare('SELECT * FROM fetch_log WHERE symbol=?');
const _clearPricesData       = db.prepare('DELETE FROM daily_prices WHERE symbol=?');
const _clearFetchLog         = db.prepare('DELETE FROM fetch_log WHERE symbol=?');
const _saveEarnings          = db.prepare('INSERT OR REPLACE INTO earnings (symbol,fiscal_date,reported_date,reported_eps,estimated_eps,surprise_pct) VALUES (?,?,?,?,?,?)');
const _getEarnings           = db.prepare('SELECT * FROM earnings WHERE symbol=? ORDER BY reported_date ASC');
const _saveSectorHealth      = db.prepare('INSERT OR REPLACE INTO sector_health (date,score) VALUES (?,?)');
const _getSectorHealth       = db.prepare('SELECT * FROM sector_health ORDER BY date ASC');
const _saveIndicators        = db.prepare(`INSERT OR REPLACE INTO indicators
    (symbol,date,close,rsi,macd_line,macd_signal,macd_hist,
     bb_upper,bb_mid,bb_lower,bb_pct,vol_ratio,roc_4w,roc_12w,hi_52w,peer_rank,
     score,score_rsi,score_macd,score_bb,score_vol,score_peer,score_eps,
     obv_roc4,dist_200w,dist_50w,golden_cross,confluence,score_obv,score_ma)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const _getLatestIndicators   = db.prepare(`SELECT i.* FROM indicators i
    INNER JOIN (SELECT symbol, MAX(date) max_date FROM indicators GROUP BY symbol) m
    ON i.symbol=m.symbol AND i.date=m.max_date`);
const _getIndicators         = db.prepare('SELECT * FROM indicators WHERE symbol=? ORDER BY date ASC');
const _saveSignals           = db.prepare(`INSERT OR REPLACE INTO signals
    (symbol,date,type,score,description,fwd_4w,fwd_8w,fwd_12w,sector_health)
    VALUES (?,?,?,?,?,?,?,?,?)`);
const _getSignals            = db.prepare('SELECT * FROM signals WHERE symbol=? ORDER BY date ASC');
const _getAllSignals          = db.prepare('SELECT * FROM signals ORDER BY date ASC');
const _setMeta               = db.prepare('INSERT OR REPLACE INTO model_meta (key,value) VALUES (?,?)');
const _getMeta               = db.prepare('SELECT value FROM model_meta WHERE key=?');
const _hasIndicators         = db.prepare('SELECT COUNT(*) as n FROM indicators');
const _saveTranscript        = db.prepare(`INSERT OR REPLACE INTO transcripts
    (symbol, filed_date, fiscal_year, fiscal_quarter, title, text,
     word_count, has_qa, source_type, filing_url, accession)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const _saveTranscriptSig     = db.prepare(`INSERT OR REPLACE INTO transcript_signals
    (transcript_id, symbol, filed_date, fiscal_year, fiscal_quarter,
     word_count, has_qa, prepared_words, qa_words, sentiment_score,
     ai_dc_mentions, demand_pos, demand_neg, pricing_pos, pricing_neg,
     memory_mentions, equip_mentions, guidance_up, guidance_down,
     positive_words, negative_words)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const _getTranscripts        = db.prepare(`SELECT id, symbol, filed_date, fiscal_year, fiscal_quarter,
    title, word_count, has_qa, source_type, filing_url, accession
    FROM transcripts WHERE symbol=? ORDER BY filed_date DESC`);
const _getTranscriptText     = db.prepare('SELECT * FROM transcripts WHERE id=?');
const _getTranscriptSignals  = db.prepare(`SELECT ts.*, t.title FROM transcript_signals ts
    JOIN transcripts t ON t.id = ts.transcript_id
    WHERE ts.symbol=? ORDER BY ts.filed_date ASC`);
const _getAllTranscriptSigs  = db.prepare(`SELECT ts.*, t.title FROM transcript_signals ts
    JOIN transcripts t ON t.id = ts.transcript_id
    ORDER BY ts.symbol, ts.filed_date ASC`);
const _getTranscriptAccess   = db.prepare('SELECT accession, source_type FROM transcripts WHERE symbol=?');
const _hasTranscripts        = db.prepare('SELECT COUNT(*) as n FROM transcripts');
const _saveMedia             = db.prepare(`INSERT OR IGNORE INTO media
    (symbol,published_at,title,url,source,summary,sentiment_score,relevance_score)
    VALUES (?,?,?,?,?,?,?,?)`);
const _getMediaCount         = db.prepare('SELECT COUNT(*) as n FROM media WHERE symbol=?');
const _saveMediaFetchLog     = db.prepare('INSERT OR REPLACE INTO media_fetch_log VALUES (?,?,?)');
const _getMedia              = db.prepare('SELECT * FROM media WHERE symbol=? ORDER BY published_at DESC LIMIT ?');
const _getMediaFetchLog      = db.prepare('SELECT * FROM media_fetch_log WHERE symbol=?');
const _hasMedia              = db.prepare('SELECT COUNT(*) as n FROM media WHERE symbol=?');
const _advPrices             = db.prepare('SELECT COUNT(*) as n, MAX(date) as last FROM daily_prices WHERE symbol=?');
const _advEdgar              = db.prepare('SELECT COUNT(*) as n, MAX(filed_date) as last FROM transcripts WHERE symbol=?');
const _saveInference         = db.prepare(`INSERT OR REPLACE INTO inference_cache (symbol, result, created_at) VALUES (?, ?, datetime('now'))`);
const _getInference          = db.prepare('SELECT * FROM inference_cache WHERE symbol=?');
const _edgarByType           = db.prepare('SELECT source_type, COUNT(*) as cnt FROM transcripts GROUP BY source_type ORDER BY cnt DESC');
const _edgarBySymbol         = db.prepare('SELECT symbol, COUNT(*) as cnt FROM transcripts GROUP BY symbol ORDER BY symbol');
const _edgarRange            = db.prepare('SELECT MIN(filed_date) as first, MAX(filed_date) as last, COUNT(*) as total FROM transcripts');
const _saveSchedulerRun      = db.prepare('INSERT INTO scheduler_log (job_id, status, message) VALUES (?, ?, ?)');
const _getLastSchedulerRun   = db.prepare('SELECT * FROM scheduler_log WHERE job_id=? ORDER BY triggered_at DESC LIMIT 1');
const _getSchedulerLog       = db.prepare('SELECT * FROM scheduler_log ORDER BY triggered_at DESC LIMIT ?');
const _saveNotification      = db.prepare('INSERT INTO notifications (type, message, symbols) VALUES (?, ?, ?)');
const _getNotifications      = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?');
const _markAllNotifsRead     = db.prepare('UPDATE notifications SET read = 1 WHERE read = 0');
const _unreadNotifCount      = db.prepare('SELECT COUNT(*) as n FROM notifications WHERE read = 0');

module.exports = {
    savePrices(symbol, prices) {
        db.transaction(() => {
            for (const r of prices) _savePrice.run(symbol, r.date, r.close, r.volume || 0);
        })();
        _saveFetchLog.run(symbol, new Date().toISOString(), 'success', prices.length);
    },

    getPrices(symbol, months = 24) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - months);
        return _getPrices.all(symbol, cutoff.toISOString().split('T')[0]);
    },

    getPricesAll(symbol) {
        return _getPricesAll.all(symbol);
    },

    hasPrices(symbol) {
        return _hasPrices.get(symbol).n > 0;
    },

    hasVolumeData(symbol) {
        return _hasVolumeData.get(symbol).n > 0;
    },

    getLastPriceDate(symbol) {
        return _getLastPriceDate.get(symbol)?.d ?? null;
    },

    // Update last_fetched timestamp without changing row_count (used when fetch is skipped)
    touchFetchLog(symbol) {
        _touchFetchLog.run(symbol, new Date().toISOString(), 'current');
    },

    getFetchLog(symbol) {
        return _getFetchLog.get(symbol) || null;
    },

    getPriceStatus(symbols) {
        if (!symbols.length) return {};
        const ph = symbols.map(() => '?').join(',');
        const rows = db.prepare(`SELECT DISTINCT symbol FROM daily_prices WHERE symbol IN (${ph})`).all(symbols);
        const has = new Set(rows.map(r => r.symbol));
        return Object.fromEntries(symbols.map(s => [s, has.has(s)]));
    },

    getFetchLogs(symbols) {
        if (!symbols.length) return {};
        const ph = symbols.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM fetch_log WHERE symbol IN (${ph})`).all(symbols);
        const map = new Map(rows.map(r => [r.symbol, r]));
        return Object.fromEntries(symbols.map(s => [s, map.get(s) || null]));
    },

    clearPrices(symbol) {
        _clearPricesData.run(symbol);
        _clearFetchLog.run(symbol);
    },

    // ── Earnings ──────────────────────────────────────────────────────
    saveEarnings(symbol, rows) {
        db.transaction(() => {
            for (const r of rows)
                _saveEarnings.run(symbol, r.fiscal_date, r.reported_date, r.reported_eps, r.estimated_eps, r.surprise_pct);
        })();
    },

    getEarnings(symbol) {
        return _getEarnings.all(symbol);
    },

    // ── Sector health time series ─────────────────────────────────────
    saveSectorHealth(dates, scores) {
        db.transaction(() => {
            for (let i = 0; i < dates.length; i++) {
                if (scores[i] != null) _saveSectorHealth.run(dates[i], scores[i]);
            }
        })();
    },

    getSectorHealth() {
        return _getSectorHealth.all();
    },

    // ── Indicators ────────────────────────────────────────────────────
    saveIndicators(symbol, dates, closes, indicators, scores, components) {
        db.transaction(() => {
            for (let i = 0; i < dates.length; i++) {
                if (scores[i] == null) continue;
                const ind = indicators, cmp = components[i] || {};
                _saveIndicators.run(
                    symbol, dates[i], closes[i],
                    ind.rsi[i], ind.macdLine[i], ind.macdSig[i], ind.macdHist[i],
                    ind.bbUpper[i], ind.bbMid[i], ind.bbLower[i], ind.bbPct[i],
                    ind.volRatio[i], ind.roc4[i], ind.roc12[i], ind.hi52[i], ind.peerRank[i],
                    scores[i],
                    cmp.rsi, cmp.macd, cmp.bb, cmp.volume, cmp.peer, cmp.eps,
                    ind.obvRoc4[i], ind.dist200w[i], ind.dist50w[i], ind.gc[i],
                    ind.confluence[i],
                    cmp.obv, cmp.ma
                );
            }
        })();
    },

    getLatestIndicators() {
        return _getLatestIndicators.all();
    },

    getIndicators(symbol) {
        return _getIndicators.all(symbol);
    },

    // ── Signals ───────────────────────────────────────────────────────
    saveSignals(signals) {
        db.transaction(() => {
            for (const s of signals)
                _saveSignals.run(s.symbol, s.date, s.type, s.score, s.description,
                        s.fwd4w ?? null, s.fwd8w ?? null, s.fwd12w ?? null,
                        s.sector_health ?? null);
        })();
    },

    getSignals(symbol) {
        return _getSignals.all(symbol);
    },

    getAllSignals() {
        return _getAllSignals.all();
    },

    // ── Model metadata ────────────────────────────────────────────────
    setMeta(key, value) {
        _setMeta.run(key, String(value));
    },

    getMeta(key) {
        return _getMeta.get(key)?.value ?? null;
    },

    hasIndicators() {
        return _hasIndicators.get().n > 0;
    },

    // ── Transcripts ───────────────────────────────────────────────────
    saveTranscript(symbol, { filed_date, fiscal_year, fiscal_quarter, title, text,
                             word_count, has_qa, source_type, filing_url, accession, signals }) {
        const r = _saveTranscript.run(symbol, filed_date, fiscal_year ?? null, fiscal_quarter ?? null,
                          title ?? null, text, word_count ?? 0, has_qa ?? 0,
                          source_type ?? 'unknown', filing_url ?? null, accession);
        const id = r.lastInsertRowid;
        if (signals && id) {
            _saveTranscriptSig.run(id, symbol, filed_date, fiscal_year ?? null, fiscal_quarter ?? null,
                  signals.word_count, signals.has_qa, signals.prepared_words, signals.qa_words,
                  signals.sentiment_score, signals.ai_dc_mentions,
                  signals.demand_pos, signals.demand_neg, signals.pricing_pos, signals.pricing_neg,
                  signals.memory_mentions, signals.equip_mentions,
                  signals.guidance_up, signals.guidance_down,
                  signals.positive_words, signals.negative_words);
        }
        return id;
    },

    getTranscripts(symbol) {
        return _getTranscripts.all(symbol);
    },

    getTranscriptText(id) {
        return _getTranscriptText.get(id);
    },

    getTranscriptSignals(symbol) {
        return _getTranscriptSignals.all(symbol);
    },

    getAllTranscriptSignals() {
        return _getAllTranscriptSigs.all();
    },

    // Compound keys already stored: "accession::source_type" (to skip re-downloading)
    getTranscriptAccessions(symbol) {
        return _getTranscriptAccess.all(symbol).map(r => `${r.accession}::${r.source_type}`);
    },

    hasTranscripts() {
        return _hasTranscripts.get().n > 0;
    },

    // ── Media ─────────────────────────────────────────────────────────
    saveMedia(symbol, articles) {
        db.transaction(() => {
            for (const a of articles)
                _saveMedia.run(symbol, a.published_at, a.title, a.url, a.source,
                        a.summary, a.sentiment_score ?? null, a.relevance_score ?? null);
        })();
        const cnt = _getMediaCount.get(symbol).n;
        _saveMediaFetchLog.run(symbol, new Date().toISOString(), cnt);
    },

    getMedia(symbol, limit = 30) {
        return _getMedia.all(symbol, limit);
    },

    getMediaFetchLog(symbol) {
        return _getMediaFetchLog.get(symbol) || null;
    },

    hasMedia(symbol) {
        return _hasMedia.get(symbol).n > 0;
    },

    getAdvancedStatus(symbol) {
        const prices  = _advPrices.get(symbol);
        const edgar   = _advEdgar.get(symbol);
        const mediaR  = _hasMedia.get(symbol);
        const mlog    = _getMediaFetchLog.get(symbol) || null;
        const flog    = _getFetchLog.get(symbol) || null;
        return {
            prices:  { count: prices.n,  lastDate: prices.last,  hasFetch: flog?.last_fetched ?? null },
            edgar:   { count: edgar.n,   lastDate: edgar.last                                          },
            media:   { count: mediaR.n,  lastFetch: mlog?.last_fetched ?? null                         },
        };
    },

    // ── Inference cache ───────────────────────────────────────────────
    saveInferenceResult(symbol, result) {
        _saveInference.run(symbol, result);
    },

    getInferenceResult(symbol) {
        return _getInference.get(symbol) || null;
    },

    getEdgarSummary() {
        return {
            byType:   _edgarByType.all(),
            bySymbol: _edgarBySymbol.all(),
            range:    _edgarRange.get(),
        };
    },

    saveSchedulerRun(jobId, status, message) {
        _saveSchedulerRun.run(jobId, status, message ?? null);
    },

    getLastSchedulerRun(jobId) {
        return _getLastSchedulerRun.get(jobId) || null;
    },

    getSchedulerLog(limit = 50) {
        return _getSchedulerLog.all(limit);
    },

    saveNotification(type, message, symbols) {
        _saveNotification.run(type, message, JSON.stringify(symbols ?? []));
    },

    getNotifications(limit = 100) {
        return _getNotifications.all(limit).map(n => ({
            ...n,
            symbols: JSON.parse(n.symbols || '[]'),
        }));
    },

    markAllNotificationsRead() {
        _markAllNotifsRead.run();
    },

    getUnreadNotificationCount() {
        return _unreadNotifCount.get().n;
    },
};
