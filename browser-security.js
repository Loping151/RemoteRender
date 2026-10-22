'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CRL_COMPONENT = 'hfnkpimlhhgieaddgfemjhofmfblmnib';
// Compromised TLS intermediates: Google CRLSet and Go 1.26.10/1.27.3
// block these SPKIs, including cross-signed certificates using the same keys.
const BLOCKED_TLS_KEYS = [
    'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105',
    '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f',
    'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41',
    '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0',
    '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b',
    '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8',
];

function inspectCRL(data) {
    if (data.length < 2) throw new Error('Missing CRLSet header');
    const length = data.readUInt16LE(0);
    const header = JSON.parse(data.subarray(2, 2 + length));
    const blocked = new Set((header.BlockedSPKIs || []).map(value => Buffer.from(value, 'base64').toString('hex')));
    if (header.ContentType !== 'CRLSet' || !Number.isInteger(header.Sequence) || !BLOCKED_TLS_KEYS.every(key => blocked.has(key))) {
        throw new Error('CRLSet does not block the compromised TLS intermediates');
    }
    if (!Number.isFinite(header.NotAfter) || header.NotAfter * 1000 <= Date.now()) throw new Error('Expired CRLSet');
    return { sequence: header.Sequence, expires: header.NotAfter, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

async function launchVerifiedBrowser(puppeteer, options, profileDir) {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const browser = await puppeteer.launch({
        ...options,
        userDataDir: profileDir,
        ignoreDefaultArgs: [...(options.ignoreDefaultArgs || []), '--disable-background-networking'],
    });
    let page;
    try {
        page = await browser.newPage();
        await page.goto('chrome://components/');
        const state = async () => {
            const version = await page.evaluate(() => document.body.innerText.match(/CRLSet - Version: ([^\n]+)/)?.[1]);
            if (!version || version === '0.0.0.0' || !/^\d+(\.\d+)*$/.test(version)) throw new Error('CRLSet has not loaded');
            return inspectCRL(await fs.readFile(path.join(profileDir, 'CertificateRevocation', version, 'crl-set')));
        };
        let current;
        try { current = await state(); } catch {}
        if (!current || current.expires * 1000 - Date.now() < 86400000) {
            // Chromium authenticates the update with Google's pinned CRX key.
            await page.click('#' + CRL_COMPONENT);
            for (let i = 0; i < 60; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                try {
                    current = await state();
                    if (current.expires * 1000 - Date.now() >= 86400000) break;
                } catch {}
            }
            current = await state(); // fail closed if no valid, loaded revocation set
        }
        await fs.writeFile(path.join(profileDir, 'verified-crlset.json'), JSON.stringify({ ...current, checked: new Date().toISOString() }) + '\n');
        await page.close();
        return browser;
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

module.exports = { launchVerifiedBrowser, inspectCRL, BLOCKED_TLS_KEYS };
