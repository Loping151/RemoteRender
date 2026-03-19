const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();

// 支持命令行参数: --port 3001 --max-renders 12
const args = process.argv.slice(2);
function getArg(name, envName, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
    if (process.env[envName]) return parseInt(process.env[envName], 10);
    return defaultVal;
}
const PORT = getArg('port', 'PORT', 3000);
const MAX_CONCURRENT_RENDERS = getArg('max-renders', 'MAX_RENDERS', 6);

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── 统计模块：内存计数 + 定时刷盘 ──
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const FLUSH_INTERVAL = 30000; // 30秒刷盘一次

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 从磁盘加载已有统计
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

// 定时刷盘
setInterval(flushStats, FLUSH_INTERVAL);

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
    return {
        ...t,
        avgMs: t.renderCount > 0 ? Math.round(t.totalMs / t.renderCount) : 0
    };
}

function getStatsDay(dayStr) {
    const d = stats.days[dayStr] || { renderCount: 0, inBytes: 0, outBytes: 0, totalMs: 0 };
    return {
        day: dayStr,
        ...d,
        avgMs: d.renderCount > 0 ? Math.round(d.totalMs / d.renderCount) : 0
    };
}

// ── 浏览器实例管理 ──
let browser = null;
let browserUseCount = 0;
let lastUsedTime = Date.now();
const MAX_BROWSER_USES = 1000;
const BROWSER_IDLE_TTL = 3600000;
let activeRenders = 0;
const renderQueue = [];

// 页面池：复用 page 避免每次创建 context + page 的开销
const pagePool = [];
let poolContext = null;

let _browserLaunching = null; // 防止并发启动多个浏览器

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
        pagePool.length = 0;
        poolContext = null;
        _contextCreating = null;
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
                    '--disable-gpu'
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

// 并发控制
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

// 页面池
let _contextCreating = null; // 防止并发创建多个 context

async function acquirePage() {
    const b = await ensureBrowser();
    if (pagePool.length > 0) {
        return pagePool.pop();
    }
    if (!poolContext) {
        if (!_contextCreating) {
            _contextCreating = b.createBrowserContext();
        }
        poolContext = await _contextCreating;
        _contextCreating = null;
    }
    const page = await poolContext.newPage();
    await page.setViewport({ width: 1200, height: 1000 });
    return page;
}

function releasePage(page) {
    browserUseCount++;
    pagePool.push(page);
}

// 健康检查接口
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

        console.log(`[渲染服务] 收到渲染请求，HTML大小: ${html.length} bytes，当前并发: ${activeRenders}/${MAX_CONCURRENT_RENDERS}`);

        await acquireRenderSlot();

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
                quality: 90
            });

            releasePage(page);
            page = null;

            const duration = Date.now() - startTime;
            const inBytes = Buffer.byteLength(html, 'utf8');
            const outBytes = screenshot.length;

            addStats({
                dayStr: getLocalDateString(),
                renderCount: 1,
                inBytes,
                outBytes,
                totalMs: duration
            });

            console.log(`[渲染服务] 渲染成功，耗时: ${duration}ms, 图片大小: ${screenshot.length} bytes`);

            res.set('Content-Type', 'image/jpeg');
            res.send(screenshot);

        } finally {
            releaseRenderSlot();
        }

    } catch (error) {
        console.error('[渲染服务] 渲染失败:', error.message);

        // 渲染失败的 page 不放回池，直接丢弃
        if (page) {
            try { await page.close(); } catch (err) {}
        }

        res.status(500).json({
            error: 'Render failed',
            message: error.message
        });
    }
});

// 定期清理空闲浏览器
setInterval(async () => {
    if (browser && Date.now() - lastUsedTime > BROWSER_IDLE_TTL) {
        console.log('[渲染服务] 检测到浏览器空闲超时，正在关闭...');
        try {
            await browser.close();
            browser = null;
            browserUseCount = 0;
            console.log('[渲染服务] 浏览器已关闭');
        } catch (err) {
            console.error('[渲染服务] 关闭浏览器失败:', err.message);
        }
    }
}, 300000);

// 启动服务器
app.listen(PORT, () => {
    console.log(`[渲染服务] 服务已启动，监听端口: ${PORT}`);
    console.log(`[渲染服务] 健康检查: http://localhost:${PORT}/health`);
    console.log(`[渲染服务] 渲染接口: http://localhost:${PORT}/render`);
});

// 优雅关闭：刷盘后退出
async function shutdown() {
    console.log('\n[渲染服务] 正在关闭服务...');
    flushStats();
    if (browser) {
        await browser.close();
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
