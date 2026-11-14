// Integration test: needs a running Postgres (DATABASE_URL). Starts the server on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { extractMetadata } from '../src/preview.js';
import { drawPairs } from '../src/util.js';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, PORT: String(PORT), ADMIN_EMAILS: 'admin-test@example.com' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server.kill());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = [cookie, ...set.map((c) => c.split(';')[0])].filter(Boolean).join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const uniq = Date.now();
const signup = (c, name) => c('POST', '/api/auth/signup', { email: `${name}-${uniq}@example.com`, name, password: 'password123' });

test('metadata extraction from JSON-LD and Open Graph', () => {
  const html = `<html><head><meta property="og:title" content="OG title"><meta property="og:image" content="/img.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Nice mug","offers":{"price":"1 299,00","priceCurrency":"UAH"}}</script></head></html>`;
  const m = extractMetadata(html, new URL('https://shop.example/p/1'));
  assert.equal(m.title, 'Nice mug');
  assert.equal(m.price, 1299);
  assert.equal(m.currency, 'UAH');
  assert.equal(m.image, 'https://shop.example/img.jpg');
});

test('Secret Santa draw is a derangement', () => {
  for (let n = 3; n < 20; n++) {
    const pairs = drawPairs([...Array(n).keys()]);
    const giftees = new Set();
    for (const [a, b] of pairs) { assert.notEqual(a, b); giftees.add(b); }
    assert.equal(giftees.size, n);
  }
});

test('sign up, sign in, wishlist, secret reservation, chip in', async () => {
  const owner = client(), guest = client(), guest2 = client();
  assert.equal((await signup(owner, 'owner')).status, 201);
  assert.equal((await signup(guest, 'guest')).status, 201);
  assert.equal((await signup(guest2, 'guest2')).status, 201);
  assert.equal((await signup(client(), 'guest')).status, 409, 'duplicate email rejected');

  const anon = client();
  assert.equal((await anon('POST', '/api/auth/login', { email: `owner-${uniq}@example.com`, password: 'nope-nope' })).status, 401);
  const login = await anon('POST', '/api/auth/login', { email: `owner-${uniq}@example.com`, password: 'password123' });
  assert.equal(login.status, 200);
  assert.equal((await anon('GET', '/api/auth/me')).body.user.name, 'owner');

  const { body: { wishlist } } = await owner('POST', '/api/wishlists', { title: 'Birthday', occasion: 'Birthday' });
  const { body: { item: mug } } = await owner('POST', `/api/wishlists/${wishlist.id}/items`, { title: 'Mug', price: 300 });
  const { body: { item: bike } } = await owner('POST', `/api/wishlists/${wishlist.id}/items`, { title: 'Bike', price: 10000, chipIn: true });

  assert.equal((await owner('POST', `/api/items/${mug.id}/reserve`)).status, 403, 'owner cannot reserve');
  assert.equal((await guest('POST', `/api/items/${mug.id}/reserve`)).status, 200);
  assert.equal((await guest2('POST', `/api/items/${mug.id}/reserve`)).status, 409, 'double reservation blocked');
  assert.equal((await guest('POST', `/api/items/${bike.id}/reserve`, { amount: 2000 })).status, 200);
  assert.equal((await guest2('POST', `/api/items/${bike.id}/reserve`, { amount: 3000 })).status, 200);

  const ownerView = (await owner('GET', `/api/lists/${wishlist.slug}`)).body;
  assert.equal(ownerView.isOwner, true);
  for (const it of ownerView.items) {
    assert.equal(it.reserved, undefined, 'owner never sees reservation state');
    assert.equal(it.chip, undefined);
  }
  const g2View = (await guest2('GET', `/api/lists/${wishlist.slug}`)).body;
  const g2Mug = g2View.items.find((i) => i.id === mug.id);
  assert.equal(g2Mug.reserved, true);
  assert.equal(g2Mug.reservedByMe, false);
  const g2Bike = g2View.items.find((i) => i.id === bike.id);
  assert.deepEqual(g2Bike.chip, { total: 5000, people: 2, mine: 3000 });
  assert.ok(!JSON.stringify(g2View).includes('guest-'), 'no giver identities leak');

  const anonView = await client()('GET', `/api/lists/${wishlist.slug}`);
  assert.equal(anonView.status, 200);

  assert.equal((await guest('GET', '/api/me/gifts')).body.gifts.length, 2);
  assert.equal((await guest('DELETE', `/api/items/${mug.id}/reserve`)).status, 200);
  assert.equal((await guest2('POST', `/api/items/${mug.id}/reserve`)).status, 200, 'freed item can be reserved');
  assert.equal((await guest('DELETE', `/api/items/${mug.id}`)).status, 403, 'only owner edits');
});

test('Secret Santa flow', async () => {
  const a = client(), b = client(), c = client();
  await signup(a, 'santa-a'); await signup(b, 'santa-b'); await signup(c, 'santa-c');
  const { body: { wishlist } } = await b('POST', '/api/wishlists', { title: 'B wants' });
  const { body: { code } } = await a('POST', '/api/santa', { name: 'Group 1', budget: '500 UAH' });
  assert.equal((await a('POST', `/api/santa/${code}/draw`)).status, 400, 'needs 3 people');
  assert.equal((await b('POST', `/api/santa/${code}/join`, { wishlistId: wishlist.id })).status, 200);
  assert.equal((await c('POST', `/api/santa/${code}/join`, { wishlistId: wishlist.id })).status, 400, 'cannot attach others list');
  assert.equal((await c('POST', `/api/santa/${code}/join`, {})).status, 200);
  assert.equal((await b('POST', `/api/santa/${code}/draw`)).status, 403);
  assert.equal((await a('POST', `/api/santa/${code}/draw`)).status, 200);
  const names = new Set();
  for (const [cl, me] of [[a, 'santa-a'], [b, 'santa-b'], [c, 'santa-c']]) {
    const v = (await cl('GET', `/api/santa/${code}`)).body;
    assert.ok(v.giftee);
    assert.notEqual(v.giftee.name, me);
    names.add(v.giftee.name);
  }
  assert.equal(names.size, 3);
});

test('admin stats are restricted', async () => {
  const u = client();
  await signup(u, 'random');
  assert.equal((await u('GET', '/api/admin/stats')).status, 403);
  const admin = client();
  await admin('POST', '/api/auth/signup', { email: 'admin-test@example.com', name: 'Admin', password: 'password123' });
  await admin('POST', '/api/auth/login', { email: 'admin-test@example.com', password: 'password123' });
  const s = await admin('GET', '/api/admin/stats');
  assert.equal(s.status, 200);
  assert.ok(s.body.totals.signups > 0);
});
