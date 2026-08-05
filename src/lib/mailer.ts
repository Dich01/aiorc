import fs from 'fs';
import path from 'path';
import nodemailer, { Transporter } from 'nodemailer';
import db from '../db/client';

// ── Outbound email (invitations) ─────────────────────────────────────────────
//
// Config resolution: env vars → .mail-config.json (gitignored) → disabled.
// Designed for Gmail SMTP with an App Password (free, ~500 mails/day), but any
// SMTP provider works. When unconfigured, sends become silent no-ops so the
// invitation flow never breaks.
//
// .mail-config.json:
// {
//   "smtp_user": "you@gmail.com",
//   "smtp_pass": "xxxx xxxx xxxx xxxx",   // Gmail App Password (needs 2FA)
//   "smtp_host": "smtp.gmail.com",        // optional, defaults to Gmail
//   "smtp_port": 465,                     // optional
//   "from_name": "AIOrc",                 // optional
//   "public_url": "https://204-216-144-224.sslip.io"  // links in the emails
// }

interface MailConfig {
  user: string;
  pass: string;
  host: string;
  port: number;
  fromName: string;
  publicUrl: string;
}

function loadConfig(): MailConfig | null {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 465,
      fromName: process.env.MAIL_FROM_NAME || 'AIOrc',
      publicUrl: process.env.AIORC_PUBLIC_URL || 'http://localhost:3001',
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mail-config.json'), 'utf8'));
    if (!raw.smtp_user || !raw.smtp_pass) return null;
    return {
      user: raw.smtp_user,
      pass: raw.smtp_pass,
      host: raw.smtp_host || 'smtp.gmail.com',
      port: Number(raw.smtp_port) || 465,
      fromName: raw.from_name || 'AIOrc',
      publicUrl: raw.public_url || 'http://localhost:3001',
    };
  } catch {
    return null;
  }
}

const config = loadConfig();
let transporter: Transporter | null = null;
if (config) {
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
}

export const mailEnabled = !!config;

const ENTITY_LABEL: Record<string, string> = {
  project: 'the project',
  agent: 'the agent',
  skill: 'the skill',
  context: 'the context',
};

export interface InvitationMail {
  inviterUserId: string;
  inviteeEmail: string;
  entityType: 'project' | 'agent' | 'skill' | 'context';
  entityName: string;
}

// Fire-and-forget: the HTTP response never waits for SMTP, and a mail failure
// never breaks the invitation itself.
export function sendInvitationEmail(opts: InvitationMail): void {
  if (!config || !transporter) return;

  const inviter = db.prepare('SELECT nickname, email FROM users WHERE id = ?')
    .get(opts.inviterUserId) as { nickname: string; email: string } | undefined;
  const inviterName = inviter?.nickname ? '@' + inviter.nickname : (inviter?.email ?? 'Someone');
  const what = ENTITY_LABEL[opts.entityType] ?? 'the item';
  const subject = `AIOrc — ${inviterName} invited you to ${what} "${opts.entityName}"`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:540px;margin:0 auto;color:#1f2937">
    <div style="padding:24px 28px;border:1px solid #e5e7eb;border-radius:12px">
      <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px">AI<span style="color:#4361ee">Orc</span></div>
      <p style="font-size:0.95rem;line-height:1.6">
        <strong>${inviterName}</strong> invited you to ${what} <strong>"${opts.entityName}"</strong> on AIOrc,
        where your team shares and runs its AI agents.
      </p>
      <p style="font-size:0.9rem;line-height:1.6">
        To accept, sign in with this address (<strong>${opts.inviteeEmail}</strong>).
        If you do not have an account yet, create one with this same address and the
        invitation will be waiting in the <strong>Team</strong> section of the dashboard.
      </p>
      <a href="${config.publicUrl}" style="display:inline-block;background:#4361ee;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:0.9rem;font-weight:600;margin:10px 0">
        Open AIOrc
      </a>
      <p style="font-size:0.75rem;color:#6b7280;margin-top:14px">
        If you were not expecting this message, you can ignore it.
      </p>
    </div>
  </div>`;

  transporter.sendMail({
    from: `"${config.fromName}" <${config.user}>`,
    to: opts.inviteeEmail,
    subject,
    html,
  }).then(() => {
    console.log(`[mail] invitation sent to ${opts.inviteeEmail} (${opts.entityType} "${opts.entityName}")`);
  }).catch(err => {
    console.warn(`[mail] failed sending to ${opts.inviteeEmail}:`, err?.message ?? err);
  });
}
