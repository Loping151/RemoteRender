'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { publicAddress, resolveTarget, startRenderProxy, parseAssetPrefixes } = require('./render-proxy');

test('blocks local, metadata, mapped, multicast and transition addresses', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '10.2.3.4', '172.16.1.2', '192.168.1.2', '100.64.0.1', '169.254.169.254', '224.0.0.1', '240.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2002:7f00:1::', '2001:0:1::']) {
        assert.equal(publicAddress(address), false, address);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
});

test('explicit local asset directory permits only its read-only files', async () => {
    let calls = 0;
    const asset = http.createServer((_req, res) => { calls++; res.end('font fixture'); });
    await new Promise(resolve => asset.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${asset.address().port}`;
    const proxy = await startRenderProxy({ assetPrefixes: parseAssetPrefixes(origin + '/fonts/') });
    const p = new URL(proxy.url);
    const get = target => new Promise((resolve, reject) => {
        const req = http.get({ hostname: p.hostname, port: p.port, path: origin + target }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
    });
    try {
        assert.equal(await get('/fonts/sample.woff2'), 200);
        for (const target of ['/health', '/fonts/../secret', '/fonts/%2e%2e/secret', '/fonts/%2e%2e%2fsecret', '/fonts/%252e%252e%252fsecret', '/fonts/%5c..%5csecret']) assert.equal(await get(target), 403, target);
        assert.equal(calls, 1);
        assert.throws(() => parseAssetPrefixes(origin + '/'));
    } finally { await proxy.close(); await new Promise(resolve => asset.close(resolve)); }
});

test('DNS answers are all checked and returned as a pinned numeric target', async () => {
    let calls = 0;
    const answer = await resolveTarget('fixture.example', 443, async () => { calls++; return [{ address: '1.1.1.1', family: 4 }]; });
    assert.deepEqual(answer, { address: '1.1.1.1', family: 4 });
    assert.equal(calls, 1);
    await assert.rejects(resolveTarget('fixture.example', 443, async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    await assert.rejects(resolveTarget('fixture.example', 443, async () => []));
    await assert.rejects(resolveTarget('1.1.1.1', 22));
});

test('real proxy rejects private HTTP and CONNECT without contacting the target', async () => {
    const proxy = await startRenderProxy();
    const p = new URL(proxy.url);
    try {
        const status = await new Promise((resolve, reject) => {
            const req = http.get({ hostname: p.hostname, port: p.port, path: 'http://127.0.0.1:80/test' }, res => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject);
        });
        assert.equal(status, 403);
        const tunnelStatus = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: p.hostname, port: p.port, method: 'CONNECT', path: '127.0.0.1:443' });
            req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
            req.on('error', reject); req.end();
        });
        assert.equal(tunnelStatus, 403);
    } finally { await proxy.close(); }
});
