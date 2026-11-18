// Unit tests for the gift-idea pipeline plus an integration run against DISCOVER_MOCK mode.
// The integration part needs a running Postgres (DATABASE_URL), like api.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseCandidates, rankOffers, findPartner, cacheKey, buildPrompt, normDomain } from '../src/discover.js';
import { signRequest, signingKey } from '../src/bedrock.js';

const partners = [
  { id: 1, name: 'Partner Shop', domain: 'partner-shop.example.ua', boost: 3, active: true },
  { id: 2, name: 'Paused Shop', domain: 'paused.example.com', boost: 5, active: false },
];

test('SigV4 signing key matches the AWS documentation example', () => {
  const k = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.equal(k.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
});

test('SigV4 request signing is well-formed and deterministic', () => {
  const args = {
    host: 'bedrock-runtime.us-east-1.amazonaws.com', path: '/model/us.amazon.nova-2-lite-v1:0/converse',
    region: 'us-east-1', body: '{}', creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' },
    now: new Date('2026-01-02T03:04:05.678Z'),
  };
  const a = signRequest(args);
  assert.equal(a['x-amz-date'], '20260102T030405Z');
  assert.match(a.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(signRequest(args).authorization, a.authorization);
});

test('parseCandidates tolerates fences/prose and drops junk and duplicates', () => {
  const text = 'Here you go:\n```json\n[{"title":"A","url":"https://a.example/p?utm_source=x","fit":"direct","why":"ok"},' +
    '{"title":"A again","url":"https://a.example/p"},{"title":"Bad","url":"javascript:alert(1)"},{"url":"https://b.example"},' +
    '{"title":"B","url":"https://b.example/x","fit":"adjacent"}]\n```';
  const out = parseCandidates(text);
  assert.deepEqual(out.map((o) => [o.title, o.fit]), [['A', 'direct'], ['B', 'adjacent']]);
  assert.equal(out[0].url, 'https://a.example/p', 'tracking params stripped');
  assert.deepEqual(parseCandidates('no json here'), []);
  assert.deepEqual(parseCandidates('[broken'), []);
});

test('partner matching covers subdomains and ignores inactive partners in ranking', () => {
  assert.equal(findPartner('shop.partner-shop.example.ua', partners).id, 1);
  assert.equal(findPartner('notpartner-shop.example.ua', partners), null);
  const ranked = rankOffers([{ title: 'x', url: 'https://paused.example.com/a', fit: 'direct' }], partners);
  assert.equal(ranked[0].partner, null);
});

test('ranking: relevance first, partner boost inside a group, adjacent items interleaved and labelled', () => {
  const offers = [
    { title: 'adj partner', url: 'https://partner-shop.example.ua/adj', fit: 'adjacent' },
    { title: 'd1', url: 'https://x1.example/1', fit: 'direct' },
    { title: 'd2', url: 'https://x2.example/2', fit: 'direct' },
    { title: 'd partner', url: 'https://partner-shop.example.ua/d', fit: 'direct' },
    { title: 'd3', url: 'https://x3.example/3', fit: 'direct' },
    { title: 'adj plain', url: 'https://x4.example/4', fit: 'adjacent' },
  ];
  const r = rankOffers(offers, partners);
  assert.equal(r.length, offers.length);
  assert.equal(r[0].title, 'd partner', 'boosted partner leads the direct matches');
  assert.equal(r[0].label, 'match');
  assert.equal(r[3].label, 'new', 'one "try something new" after three matches');
  assert.equal(r[3].title, 'adj partner', 'partner leads inside the adjacent group too');
  assert.equal(r.filter((o) => o.partner).length, 2);
  // Paid placement never lifts an adjacent item above a direct match.
  assert.ok(r.findIndex((o) => o.title === 'adj partner') > r.findIndex((o) => o.title === 'd1'));
});

test('cache key ignores case, order and punctuation; budget is bucketed', () => {
  const a = cacheKey({ interests: 'Coffee, Board games', budget: 1200, currency: 'UAH' });
  const b = cacheKey({ interests: 'board games coffee!', budget: 1400, currency: 'UAH' });
  assert.equal(a, b);
  assert.notEqual(a, cacheKey({ interests: 'board games coffee', budget: 1400, currency: 'USD' }));
});

test('prompt mentions only active partners; normDomain cleans input', () => {
  assert.match(buildPrompt({ interests: 'tea', budget: 500, currency: 'UAH' }, partners), /partner-shop\.example\.ua/);
  assert.doesNotMatch(buildPrompt({ interests: 'tea', budget: null, currency: 'UAH' }, partners), /paused\.example\.com/);
  assert.equal(normDomain('https://www.Shop.com.ua/path'), 'shop.com.ua');
  assert.equal(normDomain('not a domain'), null);
});

// ---------- integration (mock search backend) ----------
const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, PORT: String(PORT), ADMIN_EMAILS: 'admin-disc@example.com', DISCOVER_MOCK: 'true', DISCOVER_DAILY_LIMIT: '2' },
    stdio: 'inherit',
  });
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
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = [cookie, ...set.map((c) => c.split(';')[0])].filter(Boolean).join('; ');
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const uniq = Date.now();
const signup = (c, name) => c('POST', '/api/auth/signup', { email: `${name}-${uniq}@example.com`, name, password: 'password123' });

test('discover: search, partner label, add to wishlist, funnel stats, limits and permissions', async () => {
  const admin = client();
  await admin('POST', '/api/auth/signup', { email: 'admin-disc@example.com', name: 'Admin', password: 'password123' });
  await admin('POST', '/api/auth/login', { email: 'admin-disc@example.com', password: 'password123' });

  const u = client();
  assert.equal((await client()('POST', '/api/discover/search', { interests: 'coffee' })).status, 401);
  await signup(u, 'disc-user');
  assert.equal((await u('GET', '/api/admin/partners')).status, 403, 'partners are admin-only');
  assert.equal((await u('POST', '/api/admin/partners', { name: 'x', domain: 'x.com' })).status, 403);

  const domain = `partner-shop.example.ua`;
  await admin('DELETE', '/api/admin/partners/0'); // 404 is fine, just exercises id validation
  const list0 = (await admin('GET', '/api/admin/partners')).body.partners;
  const old = list0.find((p) => p.domain === domain);
  if (old) await admin('DELETE', `/api/admin/partners/${old.id}`);
  assert.equal((await admin('POST', '/api/admin/partners', { name: 'Bad', domain: 'nope' })).status, 400);
  const created = await admin('POST', '/api/admin/partners', { name: 'Partner Shop', domain, boost: 3 });
  assert.equal(created.status, 201);
  assert.equal((await admin('POST', '/api/admin/partners', { name: 'Partner Shop', domain })).status, 409);

  assert.equal((await u('POST', '/api/discover/search', { interests: 'a' })).status, 400, 'too short');
  const interests = `coffee and tea ${uniq}`;
  const s1 = await u('POST', '/api/discover/search', { interests });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.cached, false);
  assert.equal(s1.body.remaining, 1);
  const offers = s1.body.offers;
  assert.ok(offers.length >= 4);
  assert.ok(offers.some((o) => o.label === 'new'), 'has a "try something new" card');
  assert.ok(offers.some((o) => o.label === 'match'));
  const partnerOffers = offers.filter((o) => o.partner);
  assert.ok(partnerOffers.length >= 1 && partnerOffers.every((o) => o.partner.name === 'Partner Shop'));
  assert.equal(offers[0].partner?.name, 'Partner Shop', 'boosted partner match leads');

  const s2 = await u('POST', '/api/discover/search', { interests: `tea gadgets ${uniq}` });
  assert.equal(s2.body.cached, false, 'different words -> new search');
  const s3 = await u('POST', '/api/discover/search', { interests: `${uniq} And tea, coffee!` });
  assert.equal(s3.status, 200);
  assert.equal(s3.body.cached, true, 'same words in a different order hit the cache');
  assert.equal((await u('POST', '/api/discover/search', { interests: `a brand new thing ${uniq}` })).status, 429, 'daily limit reached');

  const { body: { wishlist } } = await u('POST', '/api/wishlists', { title: 'Ideas test' });
  const pick = partnerOffers[0];
  const add = await u('POST', '/api/discover/add', { wishlistId: wishlist.id, title: pick.title, url: pick.url, price: pick.price, currency: 'UAH', label: pick.label });
  assert.equal(add.status, 201);
  const other = client();
  await signup(other, 'disc-other');
  assert.equal((await other('POST', '/api/discover/add', { wishlistId: wishlist.id, title: 'x' })).status, 403, 'cannot add to someone else’s list');
  assert.equal((await u('POST', '/api/discover/event', { url: pick.url, label: pick.label })).status, 200);

  const view = (await u('GET', `/api/lists/${wishlist.slug}`)).body;
  assert.ok(view.items.some((i) => i.title === pick.title), 'item landed in the wishlist');

  const stats = (await admin('GET', '/api/admin/partners')).body;
  const p = stats.partners.find((x) => x.domain === domain);
  assert.ok(p.shown >= 1 && p.clicks === 1 && p.adds === 1, JSON.stringify(p));
  assert.ok(stats.totals.searches >= 2);

  assert.equal((await admin('PATCH', `/api/admin/partners/${p.id}`, { active: false })).status, 200);
  const off = (await u('POST', '/api/discover/search', { interests: `${uniq} coffee tea and` })).body;
  assert.ok(off.offers.every((o) => !o.partner), 'paused partner is no longer promoted, even from cache');
});
