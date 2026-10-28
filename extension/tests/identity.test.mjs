import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deriveExtensionIdentity, readExtensionIdentity, verifyExtensionIdentity } from '../../scripts/extension-identity.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const identity = JSON.parse(readFileSync(new URL('../identity.json', import.meta.url), 'utf8'));

test('公开公钥派生的扩展 ID 与固定身份一致，和安装目录无关', () => {
  assert.deepEqual(readExtensionIdentity(), identity);
  assert.deepEqual(deriveExtensionIdentity(manifest.key), identity);
  assert.match(identity.extensionId, /^[a-p]{32}$/);
  assert.match(identity.publicKeySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyExtensionIdentity({ ...manifest, name: '另一个目录下的相同扩展' }, identity), identity);
});

test('拒绝改动 ID、公钥摘要或身份字段，避免发布静默更换身份', () => {
  assert.throws(() => verifyExtensionIdentity(manifest, { ...identity, extensionId: 'a'.repeat(32) }), /不匹配/);
  assert.throws(() => verifyExtensionIdentity(manifest, { ...identity, publicKeySha256: '0'.repeat(64) }), /不匹配/);
  assert.throws(() => verifyExtensionIdentity(manifest, { ...identity, privateKey: '不能存储' }), /格式无效/);
  assert.throws(() => verifyExtensionIdentity({ ...manifest, key: undefined }, identity), /base64/);
});

test('拒绝非公钥、无效 DER 和非规范 base64', () => {
  for (const value of ['', null, 'not base64', 'aGVsbG8=', '-----BEGIN PRIVATE KEY-----', manifest.key + '\n', manifest.key + '=']) {
    assert.throws(() => deriveExtensionIdentity(value));
  }
  assert.throws(() => deriveExtensionIdentity(Buffer.concat([Buffer.from(manifest.key, 'base64'), Buffer.from([0])]).toString('base64')), /规范/);
});
