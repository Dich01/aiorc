import assert from 'assert';
import { section, test } from '../harness';
import { assertSafeOutbound, isBlockedAddress, OutboundError } from '../../lib/outbound';
import { isSafeOutboundUrl } from '../../lib/mcpServers';

section('outbound guard (F12)');

test('IPv4-mapped, compatible and NAT64 IPv6 forms are judged by the IPv4 they carry', () => {
  for (const a of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::a9fe:a9fe', '::ffff:10.0.0.1']) {
    assert.strictEqual(isBlockedAddress(a), true, a);
  }
  assert.strictEqual(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('private, loopback, link-local, CGNAT and ULA ranges are blocked', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::']) {
    assert.strictEqual(isBlockedAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.strictEqual(isBlockedAddress(a), false, a);
});

test('the literal pre-check rejects bracketed IPv6 and single-label service names', () => {
  assert.strictEqual(isSafeOutboundUrl('http://[::ffff:127.0.0.1]/'), false);
  assert.strictEqual(isSafeOutboundUrl('http://[fd00::1]/'), false);
  assert.strictEqual(isSafeOutboundUrl('http://aiorc:3001/mcp'), false);
  assert.strictEqual(isSafeOutboundUrl('http://localhost:3001'), false);
  assert.strictEqual(isSafeOutboundUrl('https://mcp.example.com/jira'), true);
});

test('a public-looking name that resolves to a private address is rejected', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(assertSafeOutbound('https://evil.example.com/mcp', resolver), OutboundError);
});

test('one bad address among several answers is enough to reject', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
  await assert.rejects(assertSafeOutbound('https://mixed.example.com/mcp', resolver), /private|reserved/);
});

test('a name resolving only to public addresses is pinned to the first one', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const t = await assertSafeOutbound('https://ok.example.com/mcp', resolver);
  assert.strictEqual(t.address, '93.184.216.34');
});

test('AIORC_GATEWAY_ALLOW_PRIVATE=1 lifts the address check', async () => {
  process.env.AIORC_GATEWAY_ALLOW_PRIVATE = '1';
  try {
    const t = await assertSafeOutbound('http://127.0.0.1:9/mcp');
    assert.strictEqual(t.address, '127.0.0.1');
  } finally {
    delete process.env.AIORC_GATEWAY_ALLOW_PRIVATE;
  }
});
