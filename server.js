const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 启动时清理上次遗留的孤儿 Chrome 进程和 profile 目录 ──
(function cleanupOrphans() {
    try {
        const psOut = execSync(
            "ps aux | grep 'puppeteer_dev_chrome_profile' | grep -v grep || true",
            { encoding: 'utf8' }
        );
        const liveProfiles = new Set();
        for (const line of psOut.split('\n')) {
            const m = line.match(/user-data-dir=(\/tmp\/puppeteer_dev_chrome_profile-[^\s]+)/);
            if (m) liveProfiles.add(m[1]);
        }

        const tmpFiles = fs.readdirSync('/tmp').filter(f => f.startsWith('puppeteer_dev_chrome_profile-'));
        let cleaned = 0;
        for (const f of tmpFiles) {
            const fullPath = '/tmp/' + f;
            if (!liveProfiles.has(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[渲染服务] 启动清理: 删除了 ${cleaned} 个孤儿 profile 目录`);
        }
    } catch (err) {
        console.error('[渲染服务] 启动清理失败(可忽略):', err.message);
    }
})();

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

function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((err, _req, res, _next) => {
    if (err.type === 'request.aborted') {
        console.log('[渲染服务] 客户端中途断开连接，忽略');
        return res.end();
    }
    console.error('[渲染服务] 中间件异常:', err.message);
    res.status(400).json({ error: err.message });
});

// ── 统计模块 ──
const DATA_DIR = path.join(__dirname, 'data');
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

async function ensureBrowser() {
    const now = Date.now();

    const needRestart =
        !browser ||
        browserUseCount >= MAX_BROWSER_USES ||
        (lastUsedTime > 0 && now - lastUsedTime > BROWSER_IDLE_TTL);

    if (needRestart && browser) {
        if (activeRenders > 0) {
            lastUsedTime = now;
            return browser;
        }

        console.log('[渲染服务] 正在重启浏览器...');
        try {
            await browser.close();
        } catch (err) {
            console.error('[渲染服务] 关闭浏览器失败:', err.message);
        }
        browser = null;
        browserUseCount = 0;
        _browserLaunching = null;
    }

    if (!browser) {
        if (!_browserLaunching) {
            console.log('[渲染服务] 正在启动新浏览器实例...');
            _browserLaunching = puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ]
            });
        }
        browser = await _browserLaunching;
        _browserLaunching = null;
        console.log('[渲染服务] 浏览器启动成功');
    }

    lastUsedTime = now;
    return browser;
}

async function acquireRenderSlot() {
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders++;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        renderQueue.push(resolve);
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
    const page = await ctx.newPage();
    await page.setViewport({ width: 1200, height: 1000 });
    page._renderContext = ctx;
    page._pageId = pageId;
    page._createTime = Date.now();
    return page;
}

async function releasePage(page) {
    browserUseCount++;
    if (page._renderContext) {
        try {
            await page._renderContext.close();
        } catch (err) {}
        page._renderContext = null;
    }
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
        const { html } = req.body;

        if (!html) {
            return res.status(400).json({ error: 'HTML content is required' });
        }

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const titleTag = title ? ` [${title}]` : '';
        console.log(`[渲染服务]${titleTag} 收到渲染请求，HTML大小: ${fmtSize(html.length)}，当前并发: ${activeRenders}/${MAX_CONCURRENT_RENDERS}`);

        await acquireRenderSlot();
        const renderStartTime = Date.now();

        try {
            page = await acquirePage();

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

            if (size && size.width && size.height) {
                await page.setViewport({
                    width: Math.max(1, size.width),
                    height: Math.max(1, size.height)
                });
            }

            const screenshot = await container.screenshot({
                type: 'jpeg',
                quality: SCREENSHOT_QUALITY
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
            res.send(screenshot);

        } catch (err) {
            console.error('[渲染服务] 渲染失败:', err.message);
            throw err;
        } finally {
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

        res.status(500).json({
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
app.listen(PORT, () => {
    console.log(`[渲染服务] 服务已启动，监听端口: ${PORT}，截图质量: ${SCREENSHOT_QUALITY}`);
    console.log(`[渲染服务] 健康检查: http://localhost:${PORT}/health`);
    console.log(`[渲染服务] 渲染接口: http://localhost:${PORT}/render`);
});

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
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
