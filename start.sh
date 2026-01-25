#!/bin/bash

# 外置渲染服务一键启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  外置渲染服务 - 一键启动脚本"
echo "========================================"
echo ""

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未检测到 Node.js"
    echo "请先安装 Node.js (>= 16.0.0)"
    echo ""
    echo "安装方法："
    echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    echo "  CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs"
    exit 1
fi

# 显示 Node.js 版本
NODE_VERSION=$(node --version)
echo "✓ Node.js 版本: $NODE_VERSION"

# 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 未检测到 npm"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "✓ npm 版本: $NPM_VERSION"
echo ""

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
    echo "✓ 依赖安装完成"
    echo ""
else
    echo "✓ 依赖已安装"
    echo ""
fi

# 检查端口是否被占用
PORT=${PORT:-3000}
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "⚠️  警告: 端口 $PORT 已被占用"
    echo ""
    read -p "是否杀死占用进程并继续? (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "正在杀死占用进程..."
        lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
        sleep 1
        echo "✓ 进程已杀死"
    else
        echo "请手动更换端口："
        echo "  PORT=8080 ./start.sh"
        exit 1
    fi
fi

echo "========================================"
echo "🚀 正在启动渲染服务..."
echo "========================================"
echo ""
echo "服务地址: http://localhost:$PORT"
echo "健康检查: http://localhost:$PORT/health"
echo "渲染接口: http://localhost:$PORT/render"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

# 启动服务
npm start
