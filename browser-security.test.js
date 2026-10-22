'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCRL, BLOCKED_TLS_KEYS } = require('./browser-security');

test('rejects missing compromised-key blocks and expired revocation sets', () => {
    const header = { ContentType: 'CRLSet', Sequence: 1, NotAfter: Math.floor(Date.now() / 1000) + 86400, BlockedSPKIs: BLOCKED_TLS_KEYS.map(key => Buffer.from(key, 'hex').toString('base64')) };
    const encode = value => {
        const json = Buffer.from(JSON.stringify(value));
        const length = Buffer.alloc(2); length.writeUInt16LE(json.length);
        return Buffer.concat([length, json]);
    };
    assert.equal(inspectCRL(encode(header)).sequence, 1);
    assert.throws(() => inspectCRL(encode({ ...header, BlockedSPKIs: header.BlockedSPKIs.slice(1) })));
    assert.throws(() => inspectCRL(encode({ ...header, NotAfter: 1 })));
});
