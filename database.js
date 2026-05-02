const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'stock-data.db'));
db.pragma('journal_mode = WAL');

// ── Core tables ───────────────────────────────────────────────────────
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

// ── Prices ────────────────────────────────────────────────────────────
const _savePrice    = db.prepare('INSERT OR REPLACE INTO daily_prices (symbol,date,close,volume) VALUES (?,?,?,?)');
const _saveFetchLog = db.prepare('INSERT OR REPLACE INTO fetch_log (symbol,last_fetched,status,row_count) VALUES (?,?,?,?)');

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
        return db.prepare(
            'SELECT date,close,volume FROM daily_prices WHERE symbol=? AND date>=? ORDER BY date ASC'
        ).all(symbol, cutoff.toISOString().split('T')[0]);
    },

    getPricesAll(symbol) {
        return db.prepare(
            'SELECT date,close,volume FROM daily_prices WHERE symbol=? ORDER BY date ASC'
        ).all(symbol);
    },

    hasPrices(symbol) {
        return db.prepare('SELECT COUNT(*) as n FROM daily_prices WHERE symbol=?').get(symbol).n > 0;
    },

    getFetchLog(symbol) {
        return db.prepare('SELECT * FROM fetch_log WHERE symbol=?').get(symbol) || null;
    },

    clearPrices(symbol) {
        db.prepare('DELETE FROM daily_prices WHERE symbol=?').run(symbol);
        db.prepare('DELETE FROM fetch_log WHERE symbol=?').run(symbol);
    },

    // ── Earnings ──────────────────────────────────────────────────────
    saveEarnings(symbol, rows) {
        const ins = db.prepare(`INSERT OR REPLACE INTO earnings
            (symbol,fiscal_date,reported_date,reported_eps,estimated_eps,surprise_pct)
            VALUES (?,?,?,?,?,?)`);
        db.transaction(() => {
            for (const r of rows)
                ins.run(symbol, r.fiscal_date, r.reported_date, r.reported_eps, r.estimated_eps, r.surprise_pct);
        })();
    },

    getEarnings(symbol) {
        return db.prepare('SELECT * FROM earnings WHERE symbol=? ORDER BY reported_date ASC').all(symbol);
    },

    // ── Sector health time series ─────────────────────────────────────
    saveSectorHealth(dates, scores) {
        const ins = db.prepare('INSERT OR REPLACE INTO sector_health (date,score) VALUES (?,?)');
        db.transaction(() => {
            for (let i = 0; i < dates.length; i++) {
                if (scores[i] != null) ins.run(dates[i], scores[i]);
            }
        })();
    },

    getSectorHealth() {
        return db.prepare('SELECT * FROM sector_health ORDER BY date ASC').all();
    },

    // ── Indicators ────────────────────────────────────────────────────
    saveIndicators(symbol, dates, closes, indicators, scores, components) {
        const ins = db.prepare(`
            INSERT OR REPLACE INTO indicators
              (symbol,date,close,rsi,macd_line,macd_signal,macd_hist,
               bb_upper,bb_mid,bb_lower,bb_pct,vol_ratio,roc_4w,roc_12w,hi_52w,peer_rank,
               score,score_rsi,score_macd,score_bb,score_vol,score_peer,score_eps,
               obv_roc4,dist_200w,dist_50w,golden_cross,confluence,score_obv,score_ma)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        db.transaction(() => {
            for (let i = 0; i < dates.length; i++) {
                if (scores[i] == null) continue;
                const ind = indicators, cmp = components[i] || {};
                ins.run(
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
        return db.prepare(`
            SELECT i.* FROM indicators i
            INNER JOIN (SELECT symbol, MAX(date) max_date FROM indicators GROUP BY symbol) m
            ON i.symbol=m.symbol AND i.date=m.max_date
        `).all();
    },

    getIndicators(symbol) {
        return db.prepare('SELECT * FROM indicators WHERE symbol=? ORDER BY date ASC').all(symbol);
    },

    // ── Signals ───────────────────────────────────────────────────────
    saveSignals(signals) {
        const ins = db.prepare(`INSERT OR REPLACE INTO signals
            (symbol,date,type,score,description,fwd_4w,fwd_8w,fwd_12w,sector_health)
            VALUES (?,?,?,?,?,?,?,?,?)`);
        db.transaction(() => {
            for (const s of signals)
                ins.run(s.symbol, s.date, s.type, s.score, s.description,
                        s.fwd4w ?? null, s.fwd8w ?? null, s.fwd12w ?? null,
                        s.sector_health ?? null);
        })();
    },

    getSignals(symbol) {
        return db.prepare('SELECT * FROM signals WHERE symbol=? ORDER BY date ASC').all(symbol);
    },

    getAllSignals() {
        return db.prepare('SELECT * FROM signals ORDER BY date ASC').all();
    },

    // ── Model metadata ────────────────────────────────────────────────
    setMeta(key, value) {
        db.prepare('INSERT OR REPLACE INTO model_meta (key,value) VALUES (?,?)').run(key, String(value));
    },

    getMeta(key) {
        return db.prepare('SELECT value FROM model_meta WHERE key=?').get(key)?.value ?? null;
    },

    hasIndicators() {
        return db.prepare('SELECT COUNT(*) as n FROM indicators').get().n > 0;
    },

    // ── Transcripts ───────────────────────────────────────────────────
    saveTranscript(symbol, { filed_date, fiscal_year, fiscal_quarter, title, text,
                             word_count, has_qa, source_type, filing_url, accession, signals }) {
        const ins = db.prepare(`
            INSERT OR REPLACE INTO transcripts
              (symbol, filed_date, fiscal_year, fiscal_quarter, title, text,
               word_count, has_qa, source_type, filing_url, accession)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        const r = ins.run(symbol, filed_date, fiscal_year ?? null, fiscal_quarter ?? null,
                          title ?? null, text, word_count ?? 0, has_qa ?? 0,
                          source_type ?? 'unknown', filing_url ?? null, accession);
        const id = r.lastInsertRowid;
        if (signals && id) {
            db.prepare(`
                INSERT OR REPLACE INTO transcript_signals
                  (transcript_id, symbol, filed_date, fiscal_year, fiscal_quarter,
                   word_count, has_qa, prepared_words, qa_words, sentiment_score,
                   ai_dc_mentions, demand_pos, demand_neg, pricing_pos, pricing_neg,
                   memory_mentions, equip_mentions, guidance_up, guidance_down,
                   positive_words, negative_words)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(id, symbol, filed_date, fiscal_year ?? null, fiscal_quarter ?? null,
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
        return db.prepare(`
            SELECT id, symbol, filed_date, fiscal_year, fiscal_quarter,
                   title, word_count, has_qa, source_type, filing_url, accession
            FROM transcripts WHERE symbol=? ORDER BY filed_date DESC
        `).all(symbol);
    },

    getTranscriptText(id) {
        return db.prepare('SELECT * FROM transcripts WHERE id=?').get(id);
    },

    getTranscriptSignals(symbol) {
        return db.prepare(`
            SELECT ts.*, t.title FROM transcript_signals ts
            JOIN transcripts t ON t.id = ts.transcript_id
            WHERE ts.symbol=? ORDER BY ts.filed_date ASC
        `).all(symbol);
    },

    getAllTranscriptSignals() {
        return db.prepare(`
            SELECT ts.*, t.title FROM transcript_signals ts
            JOIN transcripts t ON t.id = ts.transcript_id
            ORDER BY ts.symbol, ts.filed_date ASC
        `).all();
    },

    // Compound keys already stored: "accession::source_type" (to skip re-downloading)
    getTranscriptAccessions(symbol) {
        return db.prepare('SELECT accession, source_type FROM transcripts WHERE symbol=?')
            .all(symbol).map(r => `${r.accession}::${r.source_type}`);
    },

    hasTranscripts() {
        return db.prepare('SELECT COUNT(*) as n FROM transcripts').get().n > 0;
    },
};
