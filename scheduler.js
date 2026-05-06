#!/usr/bin/env node
require('dotenv').config();

const cron    = require('node-cron');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const db      = require('./database');

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const HOLIDAYS_FILE  = path.join(__dirname, 'nyse-holidays.json');

const activeTasks = new Map();

function loadConfig() {
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
}

function loadHolidays() {
    return JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8'));
}

// Returns YYYY-MM-DD in America/New_York regardless of server timezone
function todayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isTradingDay(dateStr, holidays) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const dow = new Date(year, month - 1, day).getDay(); // 0 = Sun, 6 = Sat
    if (dow === 0 || dow === 6) return false;
    return !(holidays[String(year)] || []).includes(dateStr);
}

async function executeAction(job) {
    if (job.action.type !== 'http') throw new Error(`Unknown action type: ${job.action.type}`);
    const u   = new URL(job.action.url);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: u.hostname,
            port:     u.port || (u.protocol === 'https:' ? 443 : 80),
            path:     u.pathname + u.search,
            method:   job.action.method || 'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': '0' },
        }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function register(job, holidays) {
    const config = loadConfig();
    const task   = cron.schedule(job.cron, async () => {
        const today = todayET();
        if (job.tradingDaysOnly && !isTradingDay(today, holidays)) {
            console.log(`[scheduler] ${job.id} skipped — ${today} is not a trading day`);
            return;
        }
        console.log(`[scheduler] Firing: ${job.id}`);
        try {
            const result = await executeAction(job);
            const msg    = `HTTP ${result.status}`;
            console.log(`[scheduler] ${job.id} → ${msg}`);
            db.saveSchedulerRun(job.id, 'success', msg);
        } catch (err) {
            console.error(`[scheduler] ${job.id} failed:`, err.message);
            db.saveSchedulerRun(job.id, 'error', err.message);
        }
    }, { timezone: config.timezone || 'America/New_York' });

    activeTasks.set(job.id, task);
    console.log(`[scheduler] Registered ${job.id} — "${job.cron}" ${config.timezone}`);
}

function loadAll() {
    for (const task of activeTasks.values()) task.stop();
    activeTasks.clear();

    const config   = loadConfig();
    const holidays = loadHolidays();
    const enabled  = config.jobs.filter(j => j.enabled);

    for (const job of enabled) register(job, holidays);
    console.log(`[scheduler] ${enabled.length}/${config.jobs.length} jobs active`);
}

// Hot-reload schedules.json without restarting
let reloadTimer;
fs.watch(SCHEDULES_FILE, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
        console.log('[scheduler] schedules.json changed — reloading');
        try { loadAll(); } catch (err) { console.error('[scheduler] reload failed:', err.message); }
    }, 200);
});

loadAll();
console.log('[scheduler] Ready. Ctrl+C to stop.');
