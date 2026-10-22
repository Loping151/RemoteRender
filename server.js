const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { startRenderProxy } = require('./render-proxy');

const app = express();

const args = process.argv.slice(2);
function getArg(name, envName, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
    if (process.env[envName]) return parseInt(process.env[envName], 10);
    return defaultVal;
}
const PORT = getArg('port', 'PORT', 3000);
const MAX_CONCURRENT_RENDERS = getArg('max-renders', 'MAX_RENDERS', 6);
const SCREENSHOT_QUALITY = getArg('quality', 'SCREENSHOT_QUALITY', 80);
const MAX_QUEUE = getArg('max-queue', 'MAX_QUEUE', MAX_CONCURRENT_RENDERS);
const MAX_RENDER_MS = getArg('render-timeout', 'RENDER_TIMEOUT_MS', 45000);
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 32000000;
for (const [name, value, max] of [['port', PORT, 65535], ['max-renders', MAX_CONCURRENT_RENDERS, 64], ['quality', SCREENSHOT_QUALITY, 100], ['max-queue', MAX_QUEUE, 64], ['render-timeout', MAX_RENDER_MS, 120000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
}

function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

// 中间件
app.disable('x-powered-by');
// Bound admission before buffering JSON, not only after each 50 MiB body is read.
let admittedRequests = 0;
app.use('/render', (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (admittedRequests >= MAX_CONCURRENT_RENDERS + MAX_QUEUE) return res.status(503).json({ error: 'Render queue full' });
    admittedRequests++;
    let released = false;
    const release = () => { if (!released) { released = true; admittedRequests--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((err, _req, res, _next) => {
    if (err.type === 'request.aborted') {
        console.log('[渲染服务] 客户端中途断开连接，忽略');
        return res.end();
    }
    console.error('[渲染服务] 中间件异常:', err.message);
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' });
});

// ── 统计模块 ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('[渲染服务] 加载统计文件失败:', err.message);
    }
    return { total: { renderCount: 0, inBytes: 0, outBytes: 0, totalMs: 0 }, days: {} };
}

const stats = loadStats();
let statsDirty = false;

function flushStats() {
    if (!statsDirty) return;
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
        statsDirty = false;
    } catch (err) {
        console.error('[渲染服务] 写入统计文件失败:', err.message);
    }
}

setInterval(flushStats, 30000);

function getLocalDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addStats({ dayStr, renderCount, inBytes, outBytes, totalMs }) {
    stats.total.renderCount += renderCount;
    stats.total.inBytes += inBytes;
    stats.total.outBytes += outBytes;
    stats.total.totalMs += totalMs;

    if (!stats.days[dayStr]) {
        stats.days[dayStr] = { renderCount: 0, inBytes: 0, outBytes: 0, totalMs: 0 };
    }
    stats.days[dayStr].renderCount += renderCount;
    stats.days[dayStr].inBytes += inBytes;
    stats.days[dayStr].outBytes += outBytes;
    stats.days[dayStr].totalMs += totalMs;

    statsDirty = true;
}

function getStatsTotal() {
    const t = stats.total;
    return { ...t, avgMs: t.renderCount > 0 ? Math.round(t.totalMs / t.renderCount) : 0 };
}

function getStatsDay(dayStr) {
    const d = stats.days[dayStr] || { renderCount: 0, inBytes: 0, outBytes: 0, totalMs: 0 };
    return { day: dayStr, ...d, avgMs: d.renderCount > 0 ? Math.round(d.totalMs / d.renderCount) : 0 };
}

// ── 浏览器实例管理（单实例 + 多独立 context） ──
let browser = null;
let browserUseCount = 0;
let lastUsedTime = Date.now();
const MAX_BROWSER_USES = 1000;
const BROWSER_IDLE_TTL = 3600000;
let activeRenders = 0;
const renderQueue = [];
let _browserLaunching = null;
let renderProxy = null;
let proxyLaunching = null;

async function ensureProxy() {
    if (!proxyLaunching) proxyLaunching = startRenderProxy().then(proxy => { renderProxy = proxy; return proxy; }).catch(error => { proxyLaunching = null; throw error; });
    return proxyLaunching;
}

async function ensureBrowser() {
    if (_browserLaunching) return _browserLaunching;
    const now = Date.now();
    const expired = browserUseCount >= MAX_BROWSER_USES || now - lastUsedTime > BROWSER_IDLE_TTL;
    lastUsedTime = now;
    if (browser?.connected && (!expired || activeRenders > 1)) return browser;
    _browserLaunching = (async () => {
        const previous = browser;
        browser = null;
        if (previous) { try { await previous.close(); } catch {} }
        browserUseCount = 0;
        const proxy = await ensureProxy();
        // No --no-sandbox fallback: failure to enable the sandbox fails closed.
        const launched = await puppeteer.launch({
            headless: true,
            pipe: true,
            protocolTimeout: MAX_RENDER_MS,
            args: [
                `--proxy-server=${proxy.url}`,
                '--proxy-bypass-list=<-loopback>',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
                '--disable-quic',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });
        browser = launched;
        console.log('[渲染服务] 浏览器启动成功');
        return launched;
    })().finally(() => { _browserLaunching = null; });
    return _browserLaunching;
}

async function acquireRenderSlot(res) {
    if (res.destroyed) throw Object.assign(new Error('Request closed'), { status: 499 });
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders++;
        return Promise.resolve();
    }
    if (renderQueue.length >= MAX_QUEUE) throw Object.assign(new Error('Render queue full'), { status: 503 });
    return new Promise((resolve, reject) => {
        const cancel = () => {
            const index = renderQueue.indexOf(waiter);
            if (index !== -1) renderQueue.splice(index, 1);
            clearTimeout(timer);
            res.off('close', cancel);
            reject(Object.assign(new Error('Render queue timeout'), { status: 503 }));
        };
        const timer = setTimeout(cancel, 15000);
        const waiter = () => { clearTimeout(timer); res.off('close', cancel); resolve(); };
        res.once('close', cancel);
        renderQueue.push(waiter);
    });
}

function releaseRenderSlot() {
    activeRenders--;
    if (renderQueue.length > 0) {
        const resolve = renderQueue.shift();
        activeRenders++;
        resolve();
    }
}

// 每次渲染创建独立 context，渲染完毕后关闭
let _pageIdCounter = 0;

async function acquirePage() {
    const b = await ensureBrowser();
    const ctx = await b.createBrowserContext();
    const pageId = ++_pageIdCounter;
    try {
        const page = await ctx.newPage();
        await page.setBypassServiceWorker(true);
        await page.setRequestInterception(true);
        page.on('request', request => {
            const allowed = /^(https?:|data:|blob:|about:blank$)/i.test(request.url());
            (allowed ? request.continue() : request.abort('blockedbyclient')).catch(() => {});
        });
        await page.setViewport({ width: 1200, height: 1000 });
        page._renderContext = ctx;
        page._pageId = pageId;
        page._createTime = Date.now();
        return page;
    } catch (error) {
        await ctx.close().catch(() => {});
        throw error;
    }
}

async function releasePage(page) {
    const context = page._renderContext;
    if (!context) return;
    page._renderContext = null;
    browserUseCount++;
    try { await context.close(); } catch {}
}

// 健康检查
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        browserActive: !!browser,
        browserUseCount,
        activeRenders,
        queueLength: renderQueue.length,
        maxConcurrent: MAX_CONCURRENT_RENDERS,
        uptime: process.uptime()
    });
});

// 统计接口
app.get('/stats', (req, res) => {
    try {
        const dateParam = req.query.date;
        const dayStr = dateParam ? String(dateParam) : getLocalDateString();
        res.json({ total: getStatsTotal(), day: getStatsDay(dayStr) });
    } catch (err) {
        res.status(400).json({ error: 'Invalid request', message: err.message });
    }
});

// 渲染接口
app.post('/render', async (req, res) => {
    const startTime = Date.now();
    let page = null;

    try {
        const { html } = req.body || {};

        if (typeof html !== 'string' || !html.trim()) {
            return res.status(400).json({ error: 'HTML content is required' });
        }

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';
        const titleTag = title ? ` [${title}]` : '';
        console.log(`[渲染服务]${titleTag} 收到渲染请求，HTML大小: ${fmtSize(html.length)}，当前并发: ${activeRenders}/${MAX_CONCURRENT_RENDERS}`);

        await acquireRenderSlot(res);
        const renderStartTime = Date.now();
        let deadline;
        const closeOnDisconnect = () => { if (!res.writableEnded && page) releasePage(page).catch(() => {}); };
        res.once('close', closeOnDisconnect);

        try {
            if (res.destroyed) return;
            page = await acquirePage();
            deadline = setTimeout(() => { if (page) releasePage(page).catch(() => {}); }, MAX_RENDER_MS);
            if (res.destroyed) return;

            await page.setContent(html, {
                waitUntil: 'load',
                timeout: 30000
            });

            await page.waitForSelector('.container', { timeout: 10000 });

            const container = await page.$('.container');
            const size = await page.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const width = Math.ceil(Math.max(rect.width, el.scrollWidth));
                const height = Math.ceil(Math.max(rect.height, el.scrollHeight));
                return { width, height };
            }, container);

            if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 1 || size.height < 1 || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION || size.width * size.height > MAX_PIXELS) {
                throw Object.assign(new Error('Render dimensions exceed limit'), { status: 413 });
            }
            if (size.width && size.height) {
                await page.setViewport({
                    width: Math.max(1, size.width),
                    height: Math.max(1, size.height)
                });
            }

            // Fix the capture rectangle after layout. Element.screenshot() would
            // measure it again and let page JavaScript enlarge it after our check.
            const box = await container.boundingBox();
            if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 1 || box.height < 1 || box.width > MAX_DIMENSION || box.height > MAX_DIMENSION || Math.ceil(box.width) * Math.ceil(box.height) > MAX_PIXELS) {
                throw Object.assign(new Error('Render dimensions exceed limit'), { status: 413 });
            }
            const screenshot = await page.screenshot({
                type: 'jpeg',
                quality: SCREENSHOT_QUALITY,
                clip: { x: box.x, y: box.y, width: Math.ceil(box.width), height: Math.ceil(box.height) },
                captureBeyondViewport: true
            });

            const duration = Date.now() - renderStartTime;
            const inBytes = Buffer.byteLength(html, 'utf8');
            const outBytes = screenshot.length;

            addStats({
                dayStr: getLocalDateString(),
                renderCount: 1,
                inBytes,
                outBytes,
                totalMs: duration
            });

            await releasePage(page);
            page = null;

            console.log(`[渲染服务]${titleTag} 渲染成功，耗时: ${duration}ms，图片大小: ${fmtSize(outBytes)}`);

            res.set('Content-Type', 'image/jpeg');
            res.send(Buffer.from(screenshot));

        } catch (err) {
            console.error('[渲染服务] 渲染失败:', err.message);
            throw err;
        } finally {
            clearTimeout(deadline);
            res.off('close', closeOnDisconnect);
            if (page) {
                try { await releasePage(page); } catch (e) {}
                page = null;
            }
            try { releaseRenderSlot(); } catch (e) {}
        }

    } catch (error) {
        console.error('[渲染服务] 渲染失败:', error.message);

        if (browser) {
            try {
                await browser.version();
            } catch (probeErr) {
                await forceResetBrowser(`浏览器已崩溃: ${probeErr.message}`);
            }
        }

        if (res.destroyed || res.headersSent) return;
        res.status(error.status || 500).json({
            error: 'Render failed',
            message: error.message
        });
    }
});

async function forceResetBrowser(reason) {
    console.log(`[渲染服务] 强制重置浏览器: ${reason}`);
    const old = browser;
    browser = null;
    browserUseCount = 0;
    _browserLaunching = null;
    if (old) {
        try { await old.close(); } catch (err) {}
    }
}

// 定期清理空闲浏览器
setInterval(async () => {
    if (browser && activeRenders === 0 && Date.now() - lastUsedTime > BROWSER_IDLE_TTL) {
        await forceResetBrowser('空闲超时');
        console.log('[渲染服务] 浏览器已关闭');
    }
}, 300000);

// 启动服务器
const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`[渲染服务] 服务已启动，监听端口: ${PORT}，截图质量: ${SCREENSHOT_QUALITY}`);
    console.log(`[渲染服务] 健康检查: http://localhost:${PORT}/health`);
    console.log(`[渲染服务] 渲染接口: http://localhost:${PORT}/render`);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;

// 优雅关闭
async function shutdown() {
    console.log('\n[渲染服务] 正在关闭服务...');
    flushStats();
    if (browser) {
        try {
            await Promise.race([
                browser.close(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 3000))
            ]);
        } catch (err) {
            console.error('[渲染服务] 关闭浏览器超时或失败:', err.message);
            try { browser.process()?.kill('SIGKILL'); } catch (_) {}
        }
    }
    if (renderProxy) await renderProxy.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
