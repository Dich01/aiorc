import { Router, Request, Response } from 'express';
import { KeyObject } from 'crypto';
import { auditKey, publicKeyFromPem } from '../lib/auditKeys';
import { verifyExport } from '../lib/auditExport';

const router = Router();

// GET /audit/keys — public keys that verify this server's exports. Public by
// design: verification must not require an account.
router.get('/keys', (_req: Request, res: Response): void => {
  const k = auditKey();
  res.json({ keys: [{ kid: k.kid, alg: 'Ed25519', public_key_pem: k.publicKeyPem }] });
});

// POST /audit/verify — body: a signed export, or {export, public_key_pem} to
// check it against another server's key. Recomputes the event chain and the
// signature; nothing is read from the database.
router.post('/verify', (req: Request, res: Response): void => {
  const body = req.body as { export?: unknown; public_key_pem?: unknown } & Record<string, unknown>;
  const doc = body && 'export' in body ? body.export : body;
  const keys = new Map<string, KeyObject>();
  const k = auditKey();
  keys.set(k.kid, k.publicKey);
  if (typeof body?.public_key_pem === 'string') {
    try {
      const extra = publicKeyFromPem(body.public_key_pem);
      const kid = (doc as { signature?: { kid?: string } })?.signature?.kid;
      if (kid) keys.set(kid, extra);
    } catch { res.status(400).json({ ok: false, errors: ['public_key_pem is not an Ed25519 public key'] }); return; }
  }
  res.json(verifyExport(doc, keys));
});

export default router;
