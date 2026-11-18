import crypto from 'node:crypto';
import { converseWithWebSearch } from './bedrock.js';
import { fetchPreview } from './preview.js';
import { httpUrl } from './util.js';

// ---------- pure helpers (unit-tested) ----------

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// "m.rozetka.com.ua" -> "rozetka.com.ua"; "www.shop.com" -> "shop.com". Good enough without a
// public-suffix list: common two-level suffixes keep three labels.
const SECOND_LEVEL = new Set(['com', 'org', 'net', 'co', 'in', 'kiev', 'lviv', 'kharkov', 'od', 'dp', 'edu', 'gov']);
export function baseDomain(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const keep = parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function normDomain(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

// "shop.rozetka.com.ua" matches partner "rozetka.com.ua".
export function findPartner(host, partners) {
  if (!host) return null;
  return partners.find((p) => host === p.domain || host.endsWith(`.${p.domain}`)) || null;
}

export function cacheKey({ interests, budget, currency }) {
  const norm = String(interests).toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, ' ').split(/[\s,]+/).filter(Boolean).sort().join(' ');
  const b = budget ? Math.ceil(Number(budget) / 500) * 500 : 0; // coarse buckets so near-identical budgets share a cache entry
  return crypto.createHash('sha256').update(`${norm}|${b}|${currency}`).digest('hex').slice(0, 40);
}

export const SYSTEM_PROMPT = `You are a gift-idea scout for a wishlist website used mostly in Ukraine.
Use web search to find REAL products that can be bought online right now. Never invent products, shops or links.
Reply with ONLY a JSON array (no prose, no markdown). Each element:
{"title": string, "url": string (direct product page you found), "fit": "direct" | "adjacent", "why": string (max 140 chars, same language as the user's interests), "price": number or null (only if you saw it in the search results, otherwise null), "currency": "UAH" | "USD" | "EUR" | null}
- "direct": clearly matches the person's interests.
- "adjacent": not exactly what they asked for, but related enough to be a pleasant discovery.
Output the JSON array and nothing else: no introduction, no explanations, no citations inside the text. Give 8 to 10 items, a mix of about 70% direct and 30% adjacent, from different shops. Prefer shops that deliver in Ukraine.`;

export function buildPrompt({ interests, budget, currency }, partners) {
  const lines = [`Interests / who the gift is for: ${interests}`];
  if (budget) lines.push(`Budget per item: up to ${budget} ${currency}`);
  const active = partners.filter((p) => p.active);
  if (active.length) {
    lines.push(`Search these partner shops explicitly (for example with "site:" queries) and include their relevant products when they exist: ${active.map((p) => p.domain).join(', ')}.`);
  }
  return lines.join('\n');
}

// Splits "[{...},{...}" (possibly truncated or followed by prose) into its complete top-level objects.
function salvageObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0 && start >= 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip broken object */ }
      start = -1;
    }
  }
  return out;
}

// Pulls the product list out of a model reply, tolerating code fences, surrounding prose and a
// reply that was cut off in the middle of the array.
export function parseCandidates(text) {
  let arr = null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try { arr = JSON.parse(text.slice(start, end + 1)); } catch { arr = null; }
  }
  if (!Array.isArray(arr)) arr = salvageObjects(start === -1 ? text : text.slice(start));
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    const url = httpUrl(c?.url);
    const title = typeof c?.title === 'string' ? c.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      url,
      fit: c.fit === 'adjacent' ? 'adjacent' : 'direct',
      why: typeof c.why === 'string' ? c.why.trim().slice(0, 200) : '',
      seenPrice: Number.isFinite(Number(c.price)) && Number(c.price) > 0 ? Math.round(Number(c.price) * 100) / 100 : null,
      seenCurrency: typeof c.currency === 'string' && /^[A-Za-z]{3}$/.test(c.currency) ? c.currency.toUpperCase() : null,
    });
  }
  return out;
}

// Final ordering. Relevance comes first: paid placement only reorders results inside the same
// relevance group, it never lets an irrelevant partner product beat a direct match.
// Returned offers carry a label: 'match' | 'new', plus `partner` ({ id, name } | null).
export function rankOffers(offers, partners) {
  const decorated = offers.map((o, i) => {
    const partner = findPartner(hostOf(o.url), partners.filter((p) => p.active));
    return { ...o, partner: partner ? { id: partner.id, name: partner.name } : null, _boost: partner ? partner.boost : 0, _i: i };
  });
  const group = (o) => (o.fit === 'direct' ? 0 : 1);
  decorated.sort((a, b) => group(a) - group(b) || b._boost - a._boost || a._i - b._i);

  // Keep roughly 1 "try something new" per 4 cards, interleaved instead of dumped at the end.
  const direct = decorated.filter((o) => o.fit === 'direct');
  const adjacent = decorated.filter((o) => o.fit !== 'direct');
  const merged = [];
  while (direct.length || adjacent.length) {
    for (let k = 0; k < 3 && direct.length; k++) merged.push(direct.shift());
    if (adjacent.length) merged.push(adjacent.shift());
    else if (!direct.length) break;
  }
  return merged.map(({ _boost, _i, ...o }) => ({ ...o, label: o.fit === 'direct' ? 'match' : 'new' }));
}

// ---------- search pipeline ----------

const strip = ({ seenPrice, seenCurrency, ...o }) => o;

// Keep a candidate only if its shop actually showed up in the search citations (compared by
// registrable domain, so "m.shop.ua" matches "shop.ua"); then read the real page for title / image
// / price instead of trusting the model's numbers.
async function verify(candidates, citations, debug) {
  const cited = new Set(citations.flatMap((c) => [baseDomain(hostOf(c.url)), baseDomain(normDomain(c.domain))]).filter(Boolean));
  const checked = await Promise.all(candidates.slice(0, 12).map(async (c) => {
    const host = hostOf(c.url);
    if (!host || !cited.has(baseDomain(host))) { debug.notCited.push(host); return null; }
    try {
      const p = await fetchPreview(c.url);
      if (!p.title) { debug.noTitle++; return null; }
      debug.verified++;
      return strip({ ...c, url: p.url, title: p.title || c.title, imageUrl: p.image || null, price: p.price || null, currency: p.currency || null, verified: true });
    } catch {
      // The shop blocks automatic reading (common for big stores) - we respect that and do not
      // disguise the bot. The page was returned by search, so keep it. A price the search results
      // showed is kept but flagged as approximate; there is no photo.
      debug.unreadable++;
      return strip({ ...c, imageUrl: null, price: c.seenPrice, currency: c.seenPrice ? c.seenCurrency || 'UAH' : null, priceApprox: !!c.seenPrice, verified: false });
    }
  }));
  return checked.filter(Boolean);
}

// `debug` (optional) is filled with counters so an admin can see where results disappear.
export async function searchOffers(params, partners, debug = {}) {
  if (process.env.DISCOVER_MOCK === 'true') return mockOffers(params);
  const { text, citations } = await converseWithWebSearch({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(params, partners),
  });
  const candidates = parseCandidates(text);
  Object.assign(debug, {
    textLength: text.length, textHead: text.slice(0, 500), candidates: candidates.length,
    citations: citations.length, citedSample: citations.slice(0, 6).map((c) => c.url),
    notCited: [], noTitle: 0, verified: 0, unreadable: 0,
  });
  const offers = await verify(candidates, citations, debug);
  debug.kept = offers.length;
  console.log('discover:', JSON.stringify({ text: text.length, candidates: candidates.length, citations: citations.length, notCited: debug.notCited.length, verified: debug.verified, unreadable: debug.unreadable, kept: offers.length }));
  return offers;
}

// Offline sample data for local development and tests (DISCOVER_MOCK=true).
function mockOffers({ interests }) {
  const base = [
    ['Ceramic pour-over coffee set', 'https://shop-one.example.com/coffee-set', 'direct', 1290],
    ['Specialty coffee beans sampler', 'https://partner-shop.example.ua/beans', 'direct', 620],
    ['Hand grinder', 'https://shop-two.example.com/grinder', 'direct', 1850],
    ['Insulated travel mug', 'https://shop-one.example.com/mug', 'direct', 540],
    ['Loose-leaf tea discovery box', 'https://partner-shop.example.ua/tea', 'adjacent', 480],
    ['Cozy reading blanket', 'https://shop-two.example.com/blanket', 'adjacent', 990],
  ];
  return base.map(([title, url, fit, price]) => ({
    title, url, fit, why: `Matches “${String(interests).slice(0, 40)}”`, imageUrl: null, price, currency: 'UAH', verified: true,
  }));
}
