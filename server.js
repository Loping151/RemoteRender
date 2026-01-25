const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 浏览器实例管理
let browser = null;
let browserUseCount = 0;
let lastUsedTime = Date.now();
const MAX_BROWSER_USES = 1000; // 最大使用次数
const BROWSER_IDLE_TTL = 3600000; // 空闲超时时间 1小时（毫秒）
const MAX_CONCURRENT_RENDERS = 6; // 最大并发渲染数
let activeRenders = 0; // 当前活动渲染数
const renderQueue = []; // 渲染队列

// 获取或创建浏览器实例
async function ensureBrowser() {
    const now = Date.now();

    // 检查是否需要重启浏览器
    const needRestart =
        !browser ||
        browserUseCount >= MAX_BROWSER_USES ||
        (lastUsedTime > 0 && now - lastUsedTime > BROWSER_IDLE_TTL);

    if (needRestart && browser) {
        // 如果有活动渲染，不重启
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
    }

    if (!browser) {
        console.log('[渲染服务] 正在启动新浏览器实例...');
        browser = await puppeteer.launch({
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
        console.log('[渲染服务] 浏览器启动成功');
    }

    lastUsedTime = now;
    return browser;
}

// 并发控制：等待可用的渲染槽位
async function acquireRenderSlot() {
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders++;
        return Promise.resolve();
    }

    // 如果已达到最大并发，加入队列等待
    return new Promise((resolve) => {
        renderQueue.push(resolve);
    });
}

// 释放渲染槽位
function releaseRenderSlot() {
    activeRenders--;

    // 如果队列中有等待的请求，唤醒一个
    if (renderQueue.length > 0) {
        const resolve = renderQueue.shift();
        activeRenders++;
        resolve();
    }
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

// 渲染接口
app.post('/render', async (req, res) => {
    const startTime = Date.now();
    let page = null;
    let context = null;

    try {
        const { html } = req.body;

        if (!html) {
            return res.status(400).json({ error: 'HTML content is required' });
        }

        console.log(`[渲染服务] 收到渲染请求，HTML大小: ${html.length} bytes，当前并发: ${activeRenders}/${MAX_CONCURRENT_RENDERS}`);

        // 等待可用的渲染槽位
        await acquireRenderSlot();

        try {
            // 获取浏览器实例
            const browserInstance = await ensureBrowser();

            // 创建独立的浏览器上下文（支持并发）
            context = await browserInstance.createBrowserContext();

            // 创建新页面
            page = await context.newPage();
            await page.setViewport({ width: 1200, height: 1000 });

            // 加载 HTML 内容
            await page.setContent(html, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // 等待容器元素
            await page.waitForSelector('.container', { timeout: 10000 });

            // 尝试等待网络空闲（可选，失败不影响）
            try {
                await page.waitForNetworkIdle({ timeout: 5000 });
            } catch (err) {
                console.log('[渲染服务] 网络未完全空闲，继续渲染');
            }

            // 获取容器尺寸
            const container = await page.$('.container');
            const size = await page.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const width = Math.ceil(Math.max(rect.width, el.scrollWidth));
                const height = Math.ceil(Math.max(rect.height, el.scrollHeight));
                return { width, height };
            }, container);

            // 设置视口大小
            if (size && size.width && size.height) {
                await page.setViewport({
                    width: Math.max(1, size.width),
                    height: Math.max(1, size.height)
                });
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // 截图
            const screenshot = await container.screenshot({
                type: 'jpeg',
                quality: 90
            });

            // 关闭浏览器上下文（会自动关闭其中的所有页面）
            await context.close();
            context = null;
            page = null;

            // 增加使用计数
            browserUseCount++;

            const duration = Date.now() - startTime;
            console.log(`[渲染服务] 渲染成功，耗时: ${duration}ms, 图片大小: ${screenshot.length} bytes`);

            // 返回图片
            res.set('Content-Type', 'image/jpeg');
            res.send(screenshot);

        } finally {
            // 释放渲染槽位
            releaseRenderSlot();
        }

    } catch (error) {
        console.error('[渲染服务] 渲染失败:', error.message);

        // 清理资源
        if (context) {
            try {
                await context.close();
            } catch (err) {
                console.error('[渲染服务] 关闭浏览器上下文失败:', err.message);
            }
        } else if (page) {
            try {
                await page.close();
            } catch (err) {
                console.error('[渲染服务] 关闭页面失败:', err.message);
            }
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
}, 300000); // 每5分钟检查一次

// 启动服务器
app.listen(PORT, () => {
    console.log(`[渲染服务] 服务已启动，监听端口: ${PORT}`);
    console.log(`[渲染服务] 健康检查: http://localhost:${PORT}/health`);
    console.log(`[渲染服务] 渲染接口: http://localhost:${PORT}/render`);
});

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n[渲染服务] 正在关闭服务...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[渲染服务] 正在关闭服务...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});
