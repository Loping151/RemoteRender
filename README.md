# 外置渲染服务 (Remote Render Service)

基于 Node.js + Puppeteer 的 HTML 渲染服务，用于将 HTML 转换为图片。

## 功能特性

- ✅ 高性能 HTML 转图片渲染
- ✅ 并发处理多个请求（默认最大 6 个）
- ✅ 浏览器实例自动管理
- ✅ 智能队列管理
- ✅ 健康检查接口
- ✅ 渲染统计（本地 SQLite）

## 快速开始

### 一键启动

```bash
chmod +x start.sh
./start.sh
```

### 手动启动

```bash
npm install
npm start
```

### 自定义端口

```bash
PORT=8080 npm start
```

## API 接口

### 健康检查

```bash
GET /health
```

### 渲染 HTML

```bash
POST /render
Content-Type: application/json

{
  "html": "<html>...</html>"
}
```

返回：`image/jpeg` 格式图片

### 渲染统计

```bash
GET /stats
GET /stats?date=YYYY-MM-DD
```

返回示例：
```json
{
  "total": {
    "renderCount": 100,
    "inBytes": 123456,
    "outBytes": 654321,
    "totalMs": 120000,
    "avgMs": 1200
  },
  "day": {
    "day": "2026-01-27",
    "renderCount": 10,
    "inBytes": 12345,
    "outBytes": 54321,
    "totalMs": 12000,
    "avgMs": 1200
  }
}
```

说明：
- `total` 为总览统计
- `day` 为指定日期统计（不传 `date` 默认当天）

## 配置说明

支持命令行参数和环境变量两种方式配置：

| 参数 | 命令行 | 环境变量 | 默认值 | 说明 |
|------|--------|----------|--------|------|
| 端口 | `--port` | `PORT` | 3000 | 服务监听端口 |
| 最大并发数 | `--max-renders` | `MAX_RENDERS` | 6 | 同时处理的最大渲染请求数 |
| 截图质量 | `--quality` | `SCREENSHOT_QUALITY` | 80 | JPEG 截图质量 (1-100) |

示例：
```bash
# 命令行参数
node server.js --port 3001 --max-renders 4 --quality 80

# 环境变量
PORT=3001 MAX_RENDERS=4 SCREENSHOT_QUALITY=80 node server.js
```

其他内部参数（在 `server.js` 中调整）：

```javascript
const MAX_BROWSER_USES = 1000;     // 浏览器重启阈值
const BROWSER_IDLE_TTL = 3600000;  // 空闲超时（1小时）
```

## 统计数据存储

统计数据保存在本地 SQLite：`RemoteRender/data/stats.db`  
按天分表：`stats_day_YYYYMMDD`，总览表：`stats_total`

**并发数建议：**
- 1-2GB 内存：2-3
- 2-4GB 内存：5-6（默认）
- 4GB+ 内存：8-10

## 在 gsuid_core 中使用

1. 启动渲染服务：
```bash
cd /home/loping/Server/wwdev/RemoteRender
./start.sh
```

2. 在 gsuid_core 配置中设置：
   - **外置渲染开关**: `true`
   - **外置渲染地址**: `http://127.0.0.1:3000/render`

## 故障排查

### 浏览器启动失败

**Ubuntu/Debian:**
```bash
apt-get update
sudo apt-get update && sudo apt-get install -y \
libasound2t64 \
libnspr4 \
libnss3 \
libatk1.0-0 \
libatk-bridge2.0-0 \
libcups2 \
libdrm2 \
libxkbcommon0 \
libxcomposite1 \
libxdamage1 \
libxfixes3 \
libxrandr2 \
libgbm1 \
libpango-1.0-0 \
libcairo2
```
### 字体支持（推荐）

为了获得最佳渲染效果，建议安装以下字体：

**Ubuntu/Debian:**
```bash
# 安装 JetBrains Mono（等宽字体）、Oswald（标题字体）、
# Noto Sans SC（思源黑体）、Noto Color Emoji（彩色表情）
sudo apt update
sudo apt install -y fonts-jetbrains-mono fonts-noto-cjk-extra fonts-noto-color-emoji

# 下载并安装 Oswald 字体（手动安装）
cd /tmp
wget -q https://fonts.gstatic.com/s/oswald/v53/TK3iWkUHHAIjg752GT8G.woff2 -O Oswald-Regular.woff2
sudo mkdir -p /usr/share/fonts/truetype/oswald
sudo mv Oswald-Regular.woff2 /usr/share/fonts/truetype/oswald/

# 刷新字体缓存
sudo fc-cache -fv
```

**CentOS/RHEL:**
```bash
# 安装基础字体包
sudo yum install -y google-noto-sans-cjk-fonts fonts-noto-color-emoji

# JetBrains Mono 和 Oswald 需要手动下载安装（参考上面的 Ubuntu 命令）
sudo fc-cache -fv
```

**字体说明：**
- `fonts-jetbrains-mono`: JetBrains Mono - 程序代码等宽字体
- `fonts-noto-cjk-extra`: Noto Sans SC - 思源黑体（包含简体中文）
- `fonts-noto-color-emoji`: Noto Color Emoji - Google彩色表情字体
- `Oswald`: 标题装饰字体（需手动安装）

### 端口被占用

```bash
# 查看占用
lsof -ti:3000

# 杀死进程
lsof -ti:3000 | xargs kill -9
```

## 使用 PM2 管理（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
mkdir -p logs
pm2 start ecosystem.config.js

# 常用命令
pm2 status                 # 查看状态
pm2 logs remote-render     # 查看日志
pm2 restart remote-render  # 重启服务

# 开机自启
pm2 startup
pm2 save
```

## 许可证

MIT License
