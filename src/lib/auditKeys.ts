import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'crypto';
import fs from 'fs';
import path from 'path';
import { sha256 } from './canonicalJson';

// Ed25519 signing for audit exports. Asymmetric on purpose: the public key is
// published (GET /audit/keys) so anyone can verify an export, while only the
// server can produce one. The key is independent of the auth (JWT) secret.
//
// Resolution order:
//   AUDIT_PRIVATE_KEY  PKCS#8 PEM, or its base64 DER
//   AUDIT_KEY_FILE     path to a PEM file (default ./.audit-ed25519.key),
//                      generated with mode 0600 on first use

export interface AuditKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
}

let cached: AuditKey | null = null;

export function keyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return 'ed25519-' + sha256(der.toString('base64')).slice(0, 16);
}

function fromPrivate(privateKey: KeyObject): AuditKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The audit signing key must be an Ed25519 key');
  const publicKey = createPublicKey(privateKey);
  return { kid: keyId(publicKey), privateKey, publicKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

function parsePrivate(text: string): KeyObject {
  const t = text.trim();
  if (t.includes('BEGIN')) return createPrivateKey(t);
  return createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' });
}

export function auditKeyFile(): string {
  return path.resolve(process.env.AUDIT_KEY_FILE || path.join(process.cwd(), '.audit-ed25519.key'));
}

export function auditKey(): AuditKey {
  if (cached) return cached;
  if (process.env.AUDIT_PRIVATE_KEY) {
    cached = fromPrivate(parsePrivate(process.env.AUDIT_PRIVATE_KEY));
    return cached;
  }
  const file = auditKeyFile();
  if (fs.existsSync(file)) {
    cached = fromPrivate(parsePrivate(fs.readFileSync(file, 'utf8')));
    return cached;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  console.warn(`[AIOrc] Generated a new Ed25519 audit signing key at ${file}`);
  cached = fromPrivate(privateKey);
  return cached;
}

export function signBytes(data: string, key: AuditKey = auditKey()): string {
  return sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64');
}

export function verifyBytes(data: string, signatureB64: string, publicKey: KeyObject): boolean {
  try { return verify(null, Buffer.from(data, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64')); }
  catch { return false; }
}

export function publicKeyFromPem(pem: string): KeyObject {
  const k = createPublicKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 public key');
  return k;
}
