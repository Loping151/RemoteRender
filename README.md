# 外置渲染服务 (Remote Render Service)

基于 Node.js + Puppeteer 的 HTML 渲染服务，用于将 HTML 转换为图片。

## 功能特性

- ✅ 高性能 HTML 转图片渲染
- ✅ 并发处理多个请求（默认最大 6 个）
- ✅ 浏览器实例自动管理
- ✅ 智能队列管理
- ✅ 健康检查接口

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

## 配置说明

在 `server.js` 中调整参数：

```javascript
const MAX_CONCURRENT_RENDERS = 6;  // 最大并发数
const MAX_BROWSER_USES = 1000;     // 浏览器重启阈值
const BROWSER_IDLE_TTL = 3600000;  // 空闲超时（1小时）
```

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
### 中文字体支持（可选）

如果渲染的内容包含中文，建议安装中文字体：

**Ubuntu/Debian:**
```bash
# 安装常用中文字体
apt install -y fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei fonts-noto-color-emoji

# 刷新字体缓存
fc-cache -fv
```

**CentOS/RHEL:**
```bash
yum install -y google-noto-sans-cjk-fonts wqy-microhei-fonts wqy-zenhei-fonts fonts-noto-color-emoji
fc-cache -fv
```

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
