// Outbound calls to external MCP servers registered by project owners.
//
// A registered URL is attacker-controlled input, so every call goes through
// assertSafeOutbound(): the host is resolved, and the request is refused if
// ANY resolved address falls in a loopback, private, link-local, CGNAT,
// unique-local, multicast or reserved range (IPv4-mapped and NAT64 IPv6 forms
// are unwrapped first). The connection is then pinned to the address that was
// validated, so a second DNS answer (rebinding) cannot redirect it, redirects
// are never followed, and the response body is capped.
//
// AIORC_GATEWAY_ALLOW_PRIVATE=1 lifts the address check for internal
// installations whose MCP servers live on a private network.
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

export const MAX_RESPONSE_BYTES = 1024 * 1024;

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as [string, number][]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['2001::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as [string, number][]) blocked.addSubnet(network, prefix, 'ipv6');

// Expand an IPv6 address to its 8 hextets (handles '::' and a trailing dotted quad).
function hextets(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const dotted = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    if (parts.some(p => p > 255)) return null;
    a = a.slice(0, -dotted[1]!.length) + ((parts[0]! << 8) | parts[1]!).toString(16) + ':' + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const out = all.map(h => parseInt(h, 16));
  return out.some(n => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : out;
}

// An IPv6 address that embeds an IPv4 one (mapped ::ffff:a.b.c.d, compatible
// ::a.b.c.d, NAT64 64:ff9b::a.b.c.d) is judged by the IPv4 address it carries.
function embeddedIPv4(addr: string): string | null {
  const h = hextets(addr);
  if (!h) return null;
  const v4 = () => `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
  const zero = (from: number, to: number) => h.slice(from, to).every(x => x === 0);
  if (zero(0, 5) && h[5] === 0xffff) return v4();
  if (zero(0, 6) && (h[6]! !== 0 || h[7]! > 1)) return v4();
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return v4();
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: never "safe"
}

export function allowPrivateTargets(): boolean {
  return process.env.AIORC_GATEWAY_ALLOW_PRIVATE === '1';
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = host => dns.promises.lookup(host, { all: true, verbatim: true });

export interface SafeTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export class OutboundError extends Error {}

// Validate a URL for an outbound call and pick the address to pin the
// connection to. Throws OutboundError with a user-facing reason.
export async function assertSafeOutbound(rawUrl: string, resolve: Resolver = systemResolver): Promise<SafeTarget> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new OutboundError('url must be a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundError('url must use http or https');
  if (url.username || url.password) throw new OutboundError('url must not embed credentials');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try { addresses = await resolve(host); } catch { throw new OutboundError(`could not resolve host "${host}"`); }
    if (addresses.length === 0) throw new OutboundError(`could not resolve host "${host}"`);
  }

  if (!allowPrivateTargets()) {
    const bad = addresses.find(a => isBlockedAddress(a.address));
    if (bad) throw new OutboundError(`url resolves to a loopback, private or reserved address (${bad.address})`);
  }
  const chosen = addresses[0]!;
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

// POST a JSON body to a validated target. The socket connects to the pinned
// address (TLS still verifies the certificate against the original hostname),
// any 3xx is an error, and bodies over MAX_RESPONSE_BYTES are cut off.
export function postJsonPinned(target: SafeTarget, payload: unknown, timeoutMs: number): Promise<JsonResponse> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const isHttps = target.url.protocol === 'https:';
  const lookup: net.LookupFunction = (_host, opts, cb) => {
    if ((opts as dns.LookupOptions)?.all) {
      (cb as unknown as (e: null, list: dns.LookupAddress[]) => void)(null, [{ address: target.address, family: target.family }]);
    } else {
      cb(null, target.address, target.family);
    }
  };

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request({
      protocol: target.url.protocol,
      hostname: target.url.hostname.replace(/^\[|\]$/g, ''),
      port: target.url.port || (isHttps ? 443 : 80),
      path: target.url.pathname + target.url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json' },
      lookup,
      timeout: timeoutMs,
      ...(isHttps ? { servername: net.isIP(target.url.hostname.replace(/^\[|\]$/g, '')) ? undefined : target.url.hostname } : {}),
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        reject(new OutboundError(`the server answered with a redirect (${status}); redirects are not followed`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new OutboundError(`response larger than ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status, body: text ? JSON.parse(text) : null }); }
        catch { reject(new OutboundError('the server did not answer with JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new OutboundError(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
