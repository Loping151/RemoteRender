'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function jpegSize(data) {
    assert.equal(data.readUInt16BE(0), 0xffd8);
    for (let offset = 2; offset < data.length;) {
        const marker = data.readUInt16BE(offset);
        const length = data.readUInt16BE(offset + 2);
        if ([0xffc0, 0xffc1, 0xffc2].includes(marker)) return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
        offset += length + 2;
    }
    throw new Error('JPEG dimensions missing');
}

test('isolated renderer preserves JavaScript and images, bounds dimensions and queues', { timeout: 90000 }, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-render-test-'));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['server.js', '--port', String(port), '--max-renders', '1', '--max-queue', '1'], {
        cwd: __dirname, env: { ...process.env, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    const url = `http://127.0.0.1:${port}`;
    const post = html => fetch(url + '/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html }) });
    try {
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(url + '/health')).ok) break; } catch {}
            if (child.exitCode !== null) throw new Error(logs);
            await delay(100);
        }
        assert.equal((await post({ invalid: true })).status, 400);
        const response = await post(`<body style="margin:0"><div id="card" style="width:320px;height:120px;background:#123456;color:white">渲染測試 Render<img width="12" height="12" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Crect width='12' height='12' fill='red'/%3E%3C/svg%3E"></div><script>document.getElementById('card').className='container'</script>`);
        assert.equal(response.status, 200, logs);
        assert.match(response.headers.get('content-type'), /image\/jpeg/);
        assert.deepEqual(jpegSize(Buffer.from(await response.arrayBuffer())), [320, 120]);
        let privateRequests = 0;
        const canary = http.createServer((_req, res) => { privateRequests++; res.writeHead(404).end(); });
        await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve));
        try {
            const blocked = await post(`<div id="card" style="width:100px;height:50px"><img src="http://127.0.0.1:${canary.address().port}/canary" onerror="document.getElementById('card').className='container'"></div>`);
            assert.equal(blocked.status, 200, logs);
            assert.equal(privateRequests, 0, 'Browser must not bypass the proxy for loopback');
        } finally { await new Promise(resolve => canary.close(resolve)); }
        const oversized = await post('<div class="container" style="width:20000px;height:2px">bounds</div>');
        assert.equal(oversized.status, 413, (await oversized.text()) + '\n' + logs);
        // A normal delayed template holds one slot, a second waits, and a third
        // receives 503 instead of buffering an unbounded request queue.
        const slow = '<div id="card" style="width:100px;height:50px">wait</div><script>setTimeout(()=>document.getElementById("card").className="container",1800)</script>';
        const first = post(slow);
        for (let i = 0; i < 50; i++) {
            if ((await (await fetch(url + '/health')).json()).activeRenders === 1) break;
            await delay(20);
        }
        const second = post('<div class="container" style="width:120px;height:60px">queue</div>');
        await delay(150);
        assert.equal((await post(slow)).status, 503);
        assert.equal((await first).status, 200, logs);
        assert.equal((await second).status, 200, logs);
        const health = await (await fetch(url + '/health')).json();
        assert.equal(health.activeRenders, 0);
        assert.equal(health.queueLength, 0);
        assert.equal((await (await fetch(url + '/stats')).json()).total.renderCount, 4);
    } finally {
        child.kill('SIGTERM');
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
        await fs.rm(dataDir, { recursive: true, force: true });
    }
});
