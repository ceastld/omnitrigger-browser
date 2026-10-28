import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// manifest.key 是公开的 SPKI DER 公钥；不需要或接受私钥。
export function deriveExtensionIdentity(manifestKey) {
  if (typeof manifestKey !== 'string' || !manifestKey || manifestKey.length > 4096
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifestKey)) {
    throw new Error('manifest.key 必须为单行 base64 公钥。');
  }
  const bytes = Buffer.from(manifestKey, 'base64');
  if (bytes.toString('base64') !== manifestKey) throw new Error('manifest.key 不是规范 base64。');
  let publicKey;
  try { publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' }); }
  catch { throw new Error('manifest.key 必须为 SPKI DER 公钥。'); }
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048
      || !publicKey.export({ format: 'der', type: 'spki' }).equals(bytes)) {
    throw new Error('manifest.key 必须为规范的至少 2048 位 RSA 公钥。');
  }
  const publicKeySha256 = createHash('sha256').update(bytes).digest('hex');
  // Chromium GenerateId: SHA256 前 16 字节，每个十六进制位映射至 a..p。
  const extensionId = [...publicKeySha256.slice(0, 32)]
    .map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
  return { schemaVersion: 1, extensionId, publicKeySha256 };
}

export function verifyExtensionIdentity(manifest, identity) {
  if (!manifest || manifest.manifest_version !== 3 || !identity || identity.schemaVersion !== 1
      || Object.keys(identity).sort().join(',') !== 'extensionId,publicKeySha256,schemaVersion'
      || !/^[a-p]{32}$/.test(identity.extensionId ?? '')
      || !/^[a-f0-9]{64}$/.test(identity.publicKeySha256 ?? '')) {
    throw new Error('扩展身份元数据格式无效。');
  }
  const derived = deriveExtensionIdentity(manifest.key);
  if (identity.extensionId !== derived.extensionId || identity.publicKeySha256 !== derived.publicKeySha256) {
    throw new Error('manifest.key 与 extension/identity.json 不匹配，不能静默改变扩展 ID。');
  }
  return derived;
}

export function readExtensionIdentity(extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../extension')) {
  const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8'));
  const identity = JSON.parse(readFileSync(join(extensionDirectory, 'identity.json'), 'utf8'));
  return verifyExtensionIdentity(manifest, identity);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--extension-dir')) {
      throw new Error('用法：node scripts/extension-identity.mjs [--extension-dir DIR]');
    }
    console.log(JSON.stringify(readExtensionIdentity(args.length ? resolve(args[1]) : undefined)));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
