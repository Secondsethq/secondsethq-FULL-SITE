// Run: node --test netlify/functions/__tests__/portal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, mapInvoices, billingSummary, cleanClient, youtubeId, CHUNK_BYTES } from '../portal.mjs';

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
      async list(opts = {}) { return { blobs: [...m.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).map((key) => ({ key, etag: '' })) }; },
    };
  };
  return { getStore, data };
}

const ADMIN = 'test-admin';
const BASE = 'https://secondsethq.com/.netlify/functions/portal';
const NOW = Date.parse('2026-11-03T18:00:00Z');

const STRIPE_INVOICES = {
  cus_ALI: [
    { id: 'in_1', number: 'IIIF4HVN-0009', status: 'open', amount_due: 80984, amount_paid: 0, due_date: Date.parse('2026-11-04T07:59:59Z') / 1000, hosted_invoice_url: 'https://invoice.stripe.com/i/1', invoice_pdf: 'https://pay.stripe.com/pdf/1', lines: { data: [{ description: '3% Credit Card processing fee' }, { description: 'Website Design & Development (50% Final Payment)' }] } },
    { id: 'in_2', number: null, status: 'draft', amount_due: 42900, due_date: Date.parse('2026-11-13T08:00:00Z') / 1000, hosted_invoice_url: null, lines: { data: [{ description: 'CRM Setup & Automation' }] } },
    { id: 'in_3', number: 'IIIF4HVN-0008', status: 'paid', amount_due: 39500, amount_paid: 39500, status_transitions: { paid_at: Date.parse('2026-10-30T20:00:00Z') / 1000 }, hosted_invoice_url: 'https://invoice.stripe.com/i/3', lines: { data: [{ description: 'Pen designs' }] } },
    { id: 'in_4', number: 'IIIF4HVN-0001', status: 'void', amount_due: 100000, lines: { data: [] } },
  ],
  cus_BOB: [{ id: 'in_bob', number: 'B-0001', status: 'open', amount_due: 5000, due_date: NOW / 1000 + 86400, hosted_invoice_url: 'https://invoice.stripe.com/i/bob', lines: { data: [{ description: 'Bob work' }] } }],
};

function setup(envOverrides = {}) {
  const blobs = memoryBlobs();
  const emails = [];
  const stripeCalls = [];
  let t = NOW;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.resend.com')) { emails.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    if (String(url).startsWith('https://api.stripe.com/v1/invoices')) {
      const cus = new URL(url).searchParams.get('customer');
      stripeCalls.push(cus);
      return new Response(JSON.stringify({ data: STRIPE_INVOICES[cus] || [], has_more: false }), { status: 200 });
    }
    if (String(url).startsWith('https://api.stripe.com/v1/customers')) {
      return new Response(JSON.stringify({ data: [{ id: 'cus_ALI', name: 'Allison Jackson', email: 'ali@escrowali.com' }] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  const env = { ADMIN_TOKEN: ADMIN, RESEND_API_KEY: 're_test', STRIPE_SECRET_KEY: 'rk_test', ...envOverrides };
  const handler = makeHandler({ getStore: blobs.getStore, fetch, env, now: clock.now });
  const call = async (action, { method = 'POST', body, query = {}, token, cookie, raw, contentType } = {}) => {
    const qs = new URLSearchParams({ action, ...query }).toString();
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (cookie) h.cookie = cookie;
    let payload;
    if (raw !== undefined) { payload = raw; h['content-type'] = contentType || 'application/octet-stream'; }
    else if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] = contentType || 'application/json'; }
    return handler(new Request(`${BASE}?${qs}`, { method, headers: h, body: payload }));
  };
  const j = async (...a) => { const r = await call(...a); return { status: r.status, body: await r.json(), res: r }; };
  const admin = (action, body, method = 'POST', query) => j(action, { method, body, token: ADMIN, query });
  return { blobs, emails, stripeCalls, clock, call, j, admin };
}

const ALI = {
  id: 'ali-jackson', name: 'Ali Jackson', business: 'Escrow Ali', greeting: 'Ali',
  emails: ['Ali@EscrowAli.com'], stripeCustomerId: 'cus_ALI',
  todos: [
    { id: 't1', owner: 'client', title: 'Approve announcement', clientCanCheck: true },
    { id: 't2', owner: 'secondset', title: 'Launch website' },
  ],
  files: [],
  reports: [{ id: 'r1', title: 'October report', period: 'Oct' }],
};
const BOB = { id: 'bob', name: 'Bob Builder', emails: ['bob@example.com'], stripeCustomerId: 'cus_BOB' };

async function withClients(s) {
  assert.equal((await s.admin('admin_save', { client: ALI })).status, 200);
  assert.equal((await s.admin('admin_save', { client: BOB })).status, 200);
}

async function loginAs(s, email) {
  const before = s.emails.length;
  const r = await s.j('login', { body: { email } });
  assert.equal(r.status, 200);
  assert.equal(s.emails.length, before + 1, 'a login email was sent');
  const link = s.emails.at(-1).text.match(/https:\S+#login=(\S+)/);
  assert.ok(link, 'email contains the login link');
  const v = await s.call('verify', { body: { token: link[1] } });
  assert.equal(v.status, 200);
  const cookie = v.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  return { cookie: cookie.split(';')[0], token: link[1] };
}

test('unknown email gets the same answer and no email', async () => {
  const s = setup();
  await withClients(s);
  const r = await s.j('login', { body: { email: 'stranger@example.com' } });
  assert.equal(r.status, 200);
  const known = await s.j('login', { body: { email: 'ali@escrowali.com' } });
  assert.equal(r.body.message, known.body.message);
  assert.equal(s.emails.length, 1);
  assert.deepEqual(s.emails[0].to, ['ali@escrowali.com']);
});

test('login link works once, is case-insensitive, and expires', async () => {
  const s = setup();
  await withClients(s);
  const { token } = await loginAs(s, 'ALI@escrowali.com');
  const again = await s.j('verify', { body: { token } });
  assert.equal(again.status, 401);

  await s.j('login', { body: { email: 'ali@escrowali.com' } });
  const t2 = s.emails.at(-1).text.match(/#login=(\S+)/)[1];
  s.clock.advance(21 * 60 * 1000);
  assert.equal((await s.j('verify', { body: { token: t2 } })).status, 401);
});

test('login emails are rate limited per address', async () => {
  const s = setup();
  await withClients(s);
  for (let i = 0; i < 8; i++) await s.j('login', { body: { email: 'ali@escrowali.com' } });
  assert.equal(s.emails.length, 5);
  s.clock.advance(61 * 60 * 1000);
  await s.j('login', { body: { email: 'ali@escrowali.com' } });
  assert.equal(s.emails.length, 6);
});

test('a client sees only their own data, with no internal fields', async () => {
  const s = setup();
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  const me = await s.j('me', { method: 'GET', cookie });
  assert.equal(me.status, 200);
  const p = me.body.portal;
  assert.equal(p.name, 'Ali Jackson');
  assert.equal(p.emails, undefined);
  assert.equal(p.stripeCustomerId, undefined);
  assert.deepEqual(s.stripeCalls, ['cus_ALI']);
  assert.ok(!JSON.stringify(p).includes('Bob'));
  assert.ok(!JSON.stringify(p).includes('in_bob'));
});

test('billing mapping: drafts scheduled, void hidden, fee lines dropped, totals right', async () => {
  const rows = mapInvoices(STRIPE_INVOICES.cus_ALI, NOW);
  assert.equal(rows.length, 3);
  const open = rows.find((r) => r.id === 'in_1');
  assert.equal(open.state, 'due');
  assert.equal(open.number, '0009');
  assert.equal(open.description, 'Website Design & Development (50% Final Payment)');
  assert.equal(open.url, 'https://invoice.stripe.com/i/1');
  const draft = rows.find((r) => r.id === 'in_2');
  assert.equal(draft.state, 'scheduled');
  assert.equal(draft.url, '');
  const sum = billingSummary(rows);
  assert.equal(sum.dueNow, 80984);
  assert.equal(sum.scheduled, 42900);
  assert.equal(sum.paid, 39500);
  assert.equal(sum.totalOwed, 80984 + 42900);
  const late = mapInvoices(STRIPE_INVOICES.cus_ALI, NOW + 5 * 86400 * 1000).find((r) => r.id === 'in_1');
  assert.equal(late.state, 'overdue');
});

test('no session means no data', async () => {
  const s = setup();
  await withClients(s);
  assert.equal((await s.j('me', { method: 'GET' })).status, 401);
  assert.equal((await s.j('me', { method: 'GET', cookie: 'ss_portal=forged' })).status, 401);
});

test('removing an email from a client ends that session immediately', async () => {
  const s = setup();
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  await s.admin('admin_save', { client: { ...ALI, emails: ['other@escrowali.com'] } });
  assert.equal((await s.j('me', { method: 'GET', cookie })).status, 401);
});

test('sessions expire after 30 days and logout ends them', async () => {
  const s = setup();
  await withClients(s);
  const a = await loginAs(s, 'ali@escrowali.com');
  assert.equal((await s.j('logout', { body: {}, cookie: a.cookie })).status, 200);
  assert.equal((await s.j('me', { method: 'GET', cookie: a.cookie })).status, 401);
  const b = await loginAs(s, 'ali@escrowali.com');
  s.clock.advance(31 * 24 * 3600 * 1000);
  assert.equal((await s.j('me', { method: 'GET', cookie: b.cookie })).status, 401);
});

test('admin actions need the admin token', async () => {
  const s = setup();
  assert.equal((await s.j('admin_save', { body: { client: ALI } })).status, 401);
  assert.equal((await s.j('admin_save', { body: { client: ALI }, token: 'wrong' })).status, 401);
  assert.equal((await s.j('admin_clients', { method: 'GET' })).status, 401);
  const off = setup({ ADMIN_TOKEN: '' });
  assert.equal((await off.j('admin_clients', { method: 'GET', token: 'x' })).status, 503);
});

test('one email can belong to only one client', async () => {
  const s = setup();
  await withClients(s);
  const r = await s.admin('admin_save', { client: { ...BOB, emails: ['bob@example.com', 'ali@escrowali.com'] } });
  assert.equal(r.status, 409);
});

test('client can tick only their own checkable to-dos', async () => {
  const s = setup();
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  assert.equal((await s.j('todo_done', { body: { id: 't1' }, cookie })).status, 200);
  assert.equal((await s.j('todo_done', { body: { id: 't2' }, cookie })).status, 404);
  const me = await s.j('me', { method: 'GET', cookie });
  assert.equal(me.body.portal.todos.find((t) => t.id === 't1').done, true);
});

test('cookie POSTs must be JSON', async () => {
  const s = setup();
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  const r = await s.j('todo_done', { body: 'id=t1', cookie, contentType: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
});

test('files upload in chunks, download for the owner, and are invisible to other clients', async () => {
  const s = setup();
  await withClients(s);
  const size = CHUNK_BYTES + 10;
  const start = await s.admin('admin_file_start', { clientId: 'ali-jackson', name: 'logo.zip', type: 'application/zip', size });
  assert.equal(start.body.chunks, 2);
  const fid = start.body.fileId;
  const part0 = new Uint8Array(CHUNK_BYTES).fill(7);
  const part1 = new Uint8Array(10).fill(9);
  await s.call('admin_file_chunk', { raw: part0, token: ADMIN, query: { clientId: 'ali-jackson', fileId: fid, n: '0' } });
  const last = await s.j('admin_file_chunk', { raw: part1, token: ADMIN, query: { clientId: 'ali-jackson', fileId: fid, n: '1' } });
  assert.equal(last.body.done, true);
  await s.admin('admin_save', { client: { ...ALI, files: [{ id: 'f1', title: 'Logo kit', links: [{ label: 'Download', fileId: fid }] }] } });

  const ali = await loginAs(s, 'ali@escrowali.com');
  const me = await s.j('me', { method: 'GET', cookie: ali.cookie });
  assert.equal(me.body.portal.fileMeta[fid].chunks, 2);
  const c1 = await s.call('file', { method: 'GET', query: { id: fid, n: '1' }, cookie: ali.cookie });
  assert.equal(c1.status, 200);
  assert.equal((await c1.arrayBuffer()).byteLength, 10);

  const bob = await loginAs(s, 'bob@example.com');
  const stolen = await s.call('file', { method: 'GET', query: { id: fid, n: '0' }, cookie: bob.cookie });
  assert.equal(stolen.status, 404);
});

test('ad reports only show when the client has advertising', async () => {
  const s = setup();
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  assert.equal((await s.j('me', { method: 'GET', cookie })).body.portal.reports.length, 0);
  await s.admin('admin_save', { client: { ...ALI, services: { ads: true } } });
  assert.equal((await s.j('me', { method: 'GET', cookie })).body.portal.reports.length, 1);
});

test('cleaning drops unsafe links and normalizes fields', () => {
  const c = cleanClient({
    name: 'Ali Jackson', emails: ['not-an-email', 'A@B.co'], stripeCustomerId: 'nope',
    deliverables: [{ title: 'X', coverage: 'weird', links: [{ label: 'bad', url: 'javascript:alert(1)' }, { label: 'ok', url: 'https://x.com/a' }] }],
    training: [{ title: 'Video', video: 'https://youtu.be/dQw4w9WgXcQ' }, { title: 'No video', video: 'https://evil.com' }],
  });
  assert.equal(c.id, 'ali-jackson');
  assert.deepEqual(c.emails, ['a@b.co']);
  assert.equal(c.stripeCustomerId, '');
  assert.equal(c.deliverables[0].coverage, 'included');
  assert.deepEqual(c.deliverables[0].links, [{ label: 'ok', url: 'https://x.com/a' }]);
  assert.equal(c.training[0].video, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(c.training[1].video, '');
  assert.equal(youtubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('billing degrades gracefully without a Stripe key', async () => {
  const s = setup({ STRIPE_SECRET_KEY: '' });
  await withClients(s);
  const { cookie } = await loginAs(s, 'ali@escrowali.com');
  const me = await s.j('me', { method: 'GET', cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.portal.invoices.length, 0);
  assert.match(me.body.portal.billingError, /not connected/);
});
