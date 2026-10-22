'use strict';

// Chromium resolves and connects through this proxy. Resolve once, validate every
// answer, then connect to the numeric address so a second DNS lookup cannot rebind.
const dns = require('node:dns/promises');
const http = require('node:http');
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const path = require('node:path');

const MAX_TRANSFER = 64 * 1024 * 1024;
const IDLE_TIMEOUT = 30000;

function publicAddress(address) {
    try {
        return ipaddr.process(address).range() === 'unicast';
    } catch {
        return false;
    }
}

async function resolveTarget(hostname, port, lookup = dns.lookup) {
    hostname = hostname.replace(/^\[|\]$/g, '');
    if (![80, 443].includes(Number(port)) || !hostname || hostname.includes('%')) {
        throw new Error('Destination not permitted');
    }
    const answers = net.isIP(hostname)
        ? [{ address: hostname, family: net.isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(answer => !publicAddress(answer.address))) {
        throw new Error('Destination not permitted');
    }
    return answers[0];
}

function cleanHeaders(headers) {
    const result = { ...headers };
    for (const name of String(headers.connection || '').split(',')) delete result[name.trim().toLowerCase()];
    for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'upgrade', 'trailer', 'te', 'transfer-encoding']) {
        delete result[name];
    }
    return result;
}

function parseAssetPrefixes(value = '') {
    return value.split(',').filter(Boolean).map(entry => {
        const url = new URL(entry.trim());
        if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/') || url.pathname === '/') {
            throw new Error('Asset prefix must identify a loopback HTTP directory');
        }
        return url;
    });
}

function allowedAsset(target, prefixes) {
    try {
        const decoded = decodeURIComponent(target.pathname);
        if (/[\\\x00%]/.test(decoded) || path.posix.normalize(decoded) !== decoded) return false;
        return prefixes.some(prefix => target.origin === prefix.origin && decoded.startsWith(prefix.pathname));
    } catch { return false; }
}

async function startRenderProxy({ assetPrefixes = parseAssetPrefixes(process.env.RENDER_ASSET_PREFIXES) } = {}) {
    const sockets = new Set();
    const server = http.createServer(async (req, res) => {
        let upstream;
        try {
            const target = new URL(req.url);
            if (target.protocol !== 'http:' || target.username || target.password || !['GET', 'HEAD'].includes(req.method)) {
                throw new Error('Request not permitted');
            }
            const port = Number(target.port || 80);
            const address = allowedAsset(target, assetPrefixes)
                ? { address: target.hostname.replace(/^\[|\]$/g, ''), family: target.hostname.includes(':') ? 6 : 4 }
                : await resolveTarget(target.hostname, port);
            if (req.destroyed || res.destroyed) return;
            const headers = cleanHeaders(req.headers);
            headers.host = target.host;
            delete headers['content-length'];
            upstream = http.request({
                hostname: address.address, family: address.family, port,
                method: req.method, path: target.pathname + target.search,
                headers, agent: false, timeout: IDLE_TIMEOUT,
            }, response => {
                let received = 0;
                if (Number(response.headers['content-length']) > MAX_TRANSFER) {
                    response.destroy();
                    res.writeHead(413).end();
                    return;
                }
                res.writeHead(response.statusCode, cleanHeaders(response.headers));
                response.on('data', data => {
                    received += data.length;
                    if (received > MAX_TRANSFER) {
                        response.destroy();
                        res.destroy();
                    }
                });
                response.on('error', () => res.destroy());
                response.pipe(res);
            });
            upstream.on('timeout', () => upstream.destroy(new Error('Resource timeout')));
            upstream.on('error', () => {
                if (!res.headersSent) res.writeHead(502).end();
                else res.destroy();
            });
            res.on('close', () => upstream.destroy());
            req.resume();
            upstream.end();
        } catch {
            upstream?.destroy();
            if (!res.headersSent) res.writeHead(403).end();
            else res.destroy();
        }
    });
    server.on('connect', async (req, client, head) => {
        let upstream;
        try {
            const target = new URL('http://' + req.url);
            if (target.username || target.password || target.pathname !== '/' || target.search || target.hash || !target.port) {
                throw new Error('Tunnel not permitted');
            }
            const address = await resolveTarget(target.hostname, Number(target.port));
            if (client.destroyed) return;
            upstream = net.connect({ host: address.address, family: address.family, port: Number(target.port) });
            const stop = () => { upstream.destroy(); client.destroy(); };
            let transferred = head.length;
            const count = data => { transferred += data.length; if (transferred > MAX_TRANSFER) stop(); };
            upstream.setTimeout(IDLE_TIMEOUT, stop);
            client.setTimeout(IDLE_TIMEOUT, stop);
            upstream.on('error', stop);
            client.on('error', stop);
            client.on('close', () => upstream.destroy());
            upstream.on('close', () => client.destroy());
            upstream.on('data', count);
            client.on('data', count);
            upstream.once('connect', () => {
                if (client.destroyed) return stop();
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                client.pipe(upstream);
                upstream.pipe(client);
            });
        } catch {
            upstream?.destroy();
            client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.setTimeout(IDLE_TIMEOUT, () => socket.destroy());
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.maxConnections = 256;
    server.requestTimeout = IDLE_TIMEOUT;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        close: () => {
            for (const socket of sockets) socket.destroy();
            return new Promise(resolve => server.close(resolve));
        },
    };
}

module.exports = { publicAddress, resolveTarget, startRenderProxy, parseAssetPrefixes };
