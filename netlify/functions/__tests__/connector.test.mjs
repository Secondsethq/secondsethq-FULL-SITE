// Run: node --test netlify/functions/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHandler, normalizeHost, isStagingHost, generateKey } from '../connector.mjs';
import { makeWatch } from '../connector-watch.mjs';

/* ---------- in-memory @netlify/blobs mock ---------- */
function memoryBlobs() {
  const data = new Map();
  const getStore = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    const m = data.get(name);
    return {
      async get(key, opts = {}) {
        if (!m.has(key)) return null;
        const v = m.get(key);
        if (opts.type === 'json') return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString());
        if (opts.type === 'arrayBuffer') return typeof v === 'string' ? new TextEncoder().encode(v).buffer : v;
        return typeof v === 'string' ? v : Buffer.from(v).toString();
      },
      async set(key, value) { m.set(key, value instanceof ArrayBuffer ? value.slice(0) : value); },
      async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
      async delete(key) { m.delete(key); },
      async list() { return { blobs: [...m.keys()].map((key) => ({ key, etag: '' })) }; },
    };
  };
  return { getStore, data };
}

const ADMIN = 'test-admin-token';
const WH = 'whsec_test';
const BASE = 'https://secondsethq.com/.netlify/functions/connector';

function setup(overrides = {}) {
  const blobs = memoryBlobs();
  const emails = [];
  const fetch = async (url, init) => { emails.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  let t = Date.parse('2026-09-28T12:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const env = { ADMIN_TOKEN: ADMIN, RESEND_API_KEY: 're_test', ALERT_EMAIL: 'ops@example.com', STRIPE_WEBHOOK_SECRET: WH, ...overrides };
  const handler = makeHandler({ getStore: blobs.getStore, fetch, env, now: clock.now });
  const call = async (action, { method = 'POST', body, query = {}, token, headers = {} } = {}) => {
    const qs = new URLSearchParams({ action, ...query }).toString();
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await handler(new Request(`${BASE}?${qs}`, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }));
    return res;
  };
  const j = async (...a) => { const r = await call(...a); return { status: r.status, body: await r.json(), res: r }; };
  const admin = (action, body, method = 'POST') => j(action, { method, body, token: ADMIN });
  return { blobs, emails, clock, env, handler, call, j, admin };
}

function stripeSig(payload, secret = WH, t = Math.floor(Date.parse('2026-09-28T12:00:00Z') / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const FAKE_ZIP = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(60, 1)]);

/* ---------- unit helpers ---------- */
test('normalizeHost and staging detection', () => {
  assert.equal(normalizeHost('https://WWW.AlchemyPrintCo.com:8443/shop?x=1'), 'alchemyprintco.com');
  assert.equal(normalizeHost('alchemyprintco.com.'), 'alchemyprintco.com');
  assert.equal(normalizeHost(''), '');
  for (const h of ['foo.wpengine.com', 'foo.wpenginepowered.com', 'localhost', 'shop.local', 'site.test', 'staging.shop.com', 'x.playground.wordpress.net', 'localhost:10003']) {
    assert.ok(isStagingHost(h), h);
  }
  assert.ok(!isStagingHost('alchemyprintco.com'));
  assert.ok(!isStagingHost('notlocal.com'));
  assert.match(generateKey(), /^SS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

/* ---------- admin auth ---------- */
test('admin actions require a valid bearer token', async () => {
  const s = setup();
  assert.equal((await s.j('admin_list', { method: 'GET' })).status, 401);
  assert.equal((await s.j('admin_list', { method: 'GET', token: 'wrong' })).status, 401);
  assert.equal((await s.j('admin_create', { body: { plan: 'basic' }, token: 'wrong' })).status, 401);
  assert.equal((await s.j('admin_list', { method: 'GET', token: ADMIN })).status, 200);

  const unset = setup({ ADMIN_TOKEN: '' });
  assert.equal((await unset.j('admin_list', { method: 'GET', token: '' })).status, 503);
  assert.equal((await unset.j('admin_list', { method: 'GET', token: 'anything' })).status, 503);
});

/* ---------- licensing flow ---------- */
test('create key, activate, seat limit, staging free, check, deactivate', async () => {
  const s = setup();
  const c = await s.admin('admin_create', { plan: 'premium', email: 'a@shop.com', name: 'Alchemy', max_sites: 1 });
  assert.equal(c.status, 200);
  const key = c.body.license.key;
  assert.match(key, /^SS-/);
  assert.equal(c.body.license.status, 'active');

  const a1 = await s.j('activate', { body: { key, site: 'www.alchemyprintco.com', version: '0.9.0', wp: '6.6', php: '8.2' } });
  assert.equal(a1.body.ok, true);
  assert.equal(a1.body.plan, 'premium');
  assert.equal(a1.body.status, 'active');
  assert.equal(a1.body.sites, 1);
  assert.equal(a1.body.expires, null);

  // Re-activating the same host is idempotent.
  assert.equal((await s.j('activate', { body: { key: key.toLowerCase(), site: 'https://alchemyprintco.com/' } })).body.ok, true);

  const a2 = await s.j('activate', { body: { key, site: 'othershop.com' } });
  assert.equal(a2.body.ok, false);
  assert.equal(a2.body.plan, 'none');
  assert.match(a2.body.message, /already in use/);

  const st = await s.j('activate', { body: { key, site: 'alchemy.wpengine.com' } });
  assert.equal(st.body.ok, true);
  assert.equal(st.body.staging, true);
  assert.equal(st.body.sites, 1);

  const chk = await s.j('check', { body: { key, site: 'alchemyprintco.com' } });
  assert.equal(chk.body.ok, true);
  assert.equal(chk.body.plan, 'premium');
  const chkOther = await s.j('check', { body: { key, site: 'unbound.com' } });
  assert.equal(chkOther.body.ok, false);
  assert.equal(chkOther.body.bound, false);

  const bad = await s.j('activate', { body: { key: 'SS-AAAA-BBBB-CCCC-DDDD', site: 'x.com' } });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.plan, 'none');

  assert.equal((await s.j('deactivate', { body: { key, site: 'alchemyprintco.com' } })).body.ok, true);
  assert.equal((await s.j('activate', { body: { key, site: 'othershop.com' } })).body.ok, true);
});

test('expiry and admin status changes turn plan to none', async () => {
  const s = setup();
  const key = (await s.admin('admin_create', { plan: 'basic', expires: '2026-10-01' })).body.license.key;
  assert.equal((await s.j('activate', { body: { key, site: 'shop.com' } })).body.plan, 'basic');
  s.clock.advance(5 * 86400000);
  const r = await s.j('check', { body: { key, site: 'shop.com' } });
  assert.equal(r.body.status, 'expired');
  assert.equal(r.body.plan, 'none');

  const key2 = (await s.admin('admin_create', { plan: 'premium' })).body.license.key;
  await s.j('activate', { body: { key: key2, site: 'a.com' } });
  const u = await s.admin('admin_update', { key: key2, status: 'suspended' });
  assert.equal(u.body.license.status, 'suspended');
  assert.equal((await s.j('check', { body: { key: key2, site: 'a.com' } })).body.plan, 'none');
  await s.admin('admin_update', { key: key2, status: 'active', reset_sites: true });
  assert.equal((await s.j('check', { body: { key: key2, site: 'a.com' } })).body.ok, false, 'sites were reset');
  assert.equal((await s.admin('admin_update', { key: key2, status: 'bogus' })).status, 400);
});

/* ---------- updates + download ---------- */
test('update and download are gated on a valid key', async () => {
  const s = setup();
  const key = (await s.admin('admin_create', { plan: 'basic' })).body.license.key;

  const none = await s.j('update', { method: 'GET', query: { key, site: 'shop.com', version: '0.8.0' } });
  assert.equal(none.body.package, null);

  const rel = await s.admin('admin_release', {
    version: '0.9.0', requires: '6.0', requires_php: '7.4', tested: '6.6', changelog_html: '<ul><li>New</li></ul>',
    zip_base64: FAKE_ZIP.toString('base64'),
  });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.release.size, FAKE_ZIP.length);
  assert.equal((await s.admin('admin_release', { version: '1.0.0', zip_base64: Buffer.from('nope').toString('base64') })).status, 400);

  const good = await s.j('update', { method: 'GET', query: { key, site: 'www.shop.com', version: '0.8.0' } });
  assert.equal(good.body.ok, true);
  assert.equal(good.body.version, '0.9.0');
  assert.equal(good.body.requires_php, '7.4');
  assert.equal(good.body.update_available, true);
  assert.equal(good.body.package, `${BASE}?action=download&key=${key}&site=shop.com`);

  const bad = await s.j('update', { method: 'GET', query: { key: 'SS-ZZZZ-ZZZZ-ZZZZ-ZZZZ', site: 'shop.com' } });
  assert.equal(bad.body.version, '0.9.0');
  assert.equal(bad.body.package, null);

  const dl = await s.call('download', { method: 'GET', query: { key, site: 'shop.com' } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), FAKE_ZIP);

  const dlBad = await s.call('download', { method: 'GET', query: { key: 'SS-ZZZZ-ZZZZ-ZZZZ-ZZZZ', site: 'shop.com' } });
  assert.equal(dlBad.status, 403);
  assert.match(dlBad.headers.get('content-type'), /json/);
});

/* ---------- health ---------- */
test('health failure alerts once per transition; status message returned', async () => {
  const s = setup();
  const key = (await s.admin('admin_create', { plan: 'premium', name: 'Alchemy' })).body.license.key;
  await s.j('activate', { body: { key, site: 'shop.com' } });
  await s.admin('admin_status', { message: 'InkSoft API is slow today.' });

  const okReport = { key, site: 'shop.com', version: '0.9.0', ok: true,
    checks: { catalog: { ok: true, ms: 120, msg: '' }, details: { ok: true, ms: 80, msg: '' }, designer: { ok: true, ms: 50, msg: '' }, templates: { ok: true, ms: 40, msg: '' } } };
  const failReport = { ...okReport, ok: false, checks: { ...okReport.checks, catalog: { ok: false, ms: 5000, msg: 'Timeout' } } };

  const r1 = await s.j('health', { body: okReport });
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.status_message, 'InkSoft API is slow today.');
  assert.equal(s.emails.length, 0);

  await s.j('health', { body: failReport });
  assert.equal(s.emails.length, 1);
  assert.match(s.emails[0].body.subject, /shop\.com/);
  assert.deepEqual(s.emails[0].body.to, ['ops@example.com']);

  await s.j('health', { body: failReport });
  assert.equal(s.emails.length, 1, 'no repeat while still failing');

  await s.j('health', { body: okReport });
  await s.j('health', { body: failReport });
  assert.equal(s.emails.length, 2, 'alerts again after recovery');

  // First-ever report failing also alerts.
  const key2 = (await s.admin('admin_create', { plan: 'basic' })).body.license.key;
  await s.j('health', { body: { ...failReport, key: key2, site: 'new.com' } });
  assert.equal(s.emails.length, 3);

  // Unknown key: not stored.
  assert.equal((await s.j('health', { body: { ...okReport, key: 'SS-ZZZZ-ZZZZ-ZZZZ-ZZZZ' } })).body.ok, false);

  const h = await s.admin('admin_health', undefined, 'GET');
  const shop = h.body.sites.find((x) => x.host === 'shop.com');
  assert.equal(shop.ok, false);
  assert.equal(shop.stale, false);
  assert.equal(shop.history.length, 5);
  s.clock.advance(37 * 3600000);
  assert.equal((await s.admin('admin_health', undefined, 'GET')).body.sites.find((x) => x.host === 'shop.com').stale, true);

  const pub = await s.call('status', { method: 'GET' });
  assert.equal(pub.headers.get('access-control-allow-origin'), '*');
  assert.equal((await pub.json()).message, 'InkSoft API is slow today.');
});

test('email failures never break health', async () => {
  const blobs = memoryBlobs();
  const handler = makeHandler({ getStore: blobs.getStore, fetch: async () => { throw new Error('network down'); },
    env: { ADMIN_TOKEN: ADMIN, RESEND_API_KEY: 'x', ALERT_EMAIL: 'o@x.com' }, now: () => Date.now() });
  const create = await handler(new Request(`${BASE}?action=admin_create`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ plan: 'basic' }) }));
  const { key } = (await create.json()).license;
  const r = await handler(new Request(`${BASE}?action=health`, { method: 'POST', body: JSON.stringify({ key, site: 'a.com', ok: false, checks: {} }) }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

/* ---------- Stripe ---------- */
test('Stripe: signature checks, checkout creates key, cancel turns update package off', async () => {
  const s = setup();
  const checkout = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'premium' },
    customer_details: { email: 'buyer@shop.com', name: 'Pat Buyer' } } } });

  const bad = await s.j('stripe', { body: checkout, headers: { 'stripe-signature': stripeSig(checkout, 'whsec_wrong') } });
  assert.equal(bad.status, 400);
  const old = await s.j('stripe', { body: checkout, headers: { 'stripe-signature': stripeSig(checkout, WH, Math.floor(Date.parse('2026-09-28T11:50:00Z') / 1000)) } });
  assert.equal(old.status, 400, 'outside 5-minute tolerance');
  assert.equal((await s.j('stripe', { body: checkout })).status, 400, 'missing header');

  const ok = await s.j('stripe', { body: checkout, headers: { 'stripe-signature': stripeSig(checkout) } });
  assert.equal(ok.status, 200);
  const key = ok.body.license;
  assert.match(key, /^SS-/);
  assert.ok(s.emails.some((e) => e.body.to[0] === 'buyer@shop.com' && e.body.html.includes(key)), 'key emailed to buyer');

  // Retry is idempotent.
  const again = await s.j('stripe', { body: checkout, headers: { 'stripe-signature': stripeSig(checkout) } });
  assert.equal(again.body.license, key);
  assert.equal((await s.admin('admin_list', undefined, 'GET')).body.licenses.length, 1);

  const lic = (await s.admin('admin_list', undefined, 'GET')).body.licenses[0];
  assert.equal(lic.stripe_customer, 'cus_1');
  assert.equal(lic.stripe_subscription, 'sub_1');
  assert.equal(lic.plan, 'premium');

  await s.admin('admin_release', { version: '0.9.0', zip_base64: FAKE_ZIP.toString('base64') });
  await s.j('activate', { body: { key, site: 'shop.com' } });
  assert.notEqual((await s.j('update', { method: 'GET', query: { key, site: 'shop.com' } })).body.package, null);

  const failed = JSON.stringify({ type: 'invoice.payment_failed', data: { object: { id: 'in_1', subscription: 'sub_1' } } });
  await s.j('stripe', { body: failed, headers: { 'stripe-signature': stripeSig(failed) } });
  const pd = await s.j('check', { body: { key, site: 'shop.com' } });
  assert.equal(pd.body.status, 'past_due');
  assert.equal(pd.body.plan, 'premium');

  // New-style invoice shape (parent.subscription_details).
  const paid = JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_2', parent: { subscription_details: { subscription: 'sub_1' } } } } });
  await s.j('stripe', { body: paid, headers: { 'stripe-signature': stripeSig(paid) } });
  assert.equal((await s.j('check', { body: { key, site: 'shop.com' } })).body.status, 'active');

  const cancel = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled' } } });
  const cr = await s.j('stripe', { body: cancel, headers: { 'stripe-signature': stripeSig(cancel) } });
  assert.equal(cr.body.changed, true);
  const after = await s.j('check', { body: { key, site: 'shop.com' } });
  assert.equal(after.body.status, 'canceled');
  assert.equal(after.body.plan, 'none');
  assert.equal((await s.j('update', { method: 'GET', query: { key, site: 'shop.com' } })).body.package, null);
  assert.equal((await s.call('download', { method: 'GET', query: { key, site: 'shop.com' } })).status, 403);

  // subscription.updated via metadata.license_key
  const upd = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_other', status: 'active', metadata: { license_key: key } } } });
  await s.j('stripe', { body: upd, headers: { 'stripe-signature': stripeSig(upd) } });
  assert.equal((await s.j('check', { body: { key, site: 'shop.com' } })).body.status, 'active');
});

/* ---------- misc ---------- */
test('body size limits and unknown action', async () => {
  const s = setup();
  const big = JSON.stringify({ key: 'x', pad: 'a'.repeat(70 * 1024) });
  assert.equal((await s.j('health', { body: big })).status, 413);
  assert.equal((await s.j('nope', { method: 'GET' })).status, 404);
});

/* ---------- daily watch ---------- */
test('watch digest lists stale/failing sites and expiring licenses', async () => {
  const s = setup();
  const k1 = (await s.admin('admin_create', { plan: 'premium', name: 'Stale Co' })).body.license.key;
  await s.j('activate', { body: { key: k1, site: 'stale.com' } });
  await s.j('activate', { body: { key: k1, site: 'staging.stale.com' } });
  const k2 = (await s.admin('admin_create', { plan: 'basic', name: 'Soon Co', expires: '2026-10-02' })).body.license.key;
  await s.j('activate', { body: { key: k2, site: 'healthy.com' } });
  await s.j('health', { body: { key: k2, site: 'healthy.com', ok: true, checks: { catalog: { ok: true } } } });

  const sent = [];
  const watch = makeWatch({ getStore: s.blobs.getStore, fetch: async (u, i) => { sent.push(JSON.parse(i.body)); return new Response('{}'); },
    env: s.env, now: s.clock.now });
  const r = await watch();
  assert.equal(r.sent, true);
  assert.equal(r.problems, 1);
  assert.equal(r.expiring, 1);
  assert.match(sent[0].html, /stale\.com/);
  assert.doesNotMatch(sent[0].html, /staging\.stale\.com/);
  assert.match(sent[0].html, /Soon Co/);

  const off = makeWatch({ getStore: s.blobs.getStore, fetch: async () => { throw new Error('should not send'); }, env: {}, now: s.clock.now });
  assert.equal((await off()).sent, false);
});
