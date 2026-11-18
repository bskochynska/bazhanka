import crypto from 'node:crypto';
import { converseWithWebSearch } from './bedrock.js';
import { fetchPreview } from './preview.js';
import { httpUrl } from './util.js';

// ---------- pure helpers (unit-tested) ----------

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
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
Give 8 to 10 items, a mix of about 70% direct and 30% adjacent, from different shops. Prefer shops that deliver in Ukraine.`;

export function buildPrompt({ interests, budget, currency }, partners) {
  const lines = [`Interests / who the gift is for: ${interests}`];
  if (budget) lines.push(`Budget per item: up to ${budget} ${currency}`);
  const active = partners.filter((p) => p.active);
  if (active.length) {
    lines.push(`Search these partner shops explicitly (for example with "site:" queries) and include their relevant products when they exist: ${active.map((p) => p.domain).join(', ')}.`);
  }
  return lines.join('\n');
}

// Pulls the JSON array out of a model reply, tolerating code fences and surrounding prose.
export function parseCandidates(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
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

// Keep a candidate only if its shop actually showed up in the search citations; then read the
// real page for title / image / price instead of trusting the model's numbers.
async function verify(candidates, citations) {
  const citedHosts = new Set(citations.flatMap((c) => [hostOf(c.url), normDomain(c.domain)]).filter(Boolean));
  const checked = await Promise.all(candidates.slice(0, 12).map(async (c) => {
    const host = hostOf(c.url);
    if (!host || !citedHosts.has(host)) return null;
    try {
      const p = await fetchPreview(c.url);
      if (!p.title) return null;
      return strip({ ...c, url: p.url, title: p.title || c.title, imageUrl: p.image || null, price: p.price || null, currency: p.currency || null, verified: true });
    } catch {
      // The shop blocks automatic reading (common for big stores) - we respect that and do not
      // disguise the bot. The page was returned by search, so keep it. A price the search results
      // showed is kept but flagged as approximate; there is no photo.
      return strip({ ...c, imageUrl: null, price: c.seenPrice, currency: c.seenPrice ? c.seenCurrency || 'UAH' : null, priceApprox: !!c.seenPrice, verified: false });
    }
  }));
  return checked.filter(Boolean);
}

export async function searchOffers(params, partners) {
  if (process.env.DISCOVER_MOCK === 'true') return mockOffers(params);
  const { text, citations } = await converseWithWebSearch({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(params, partners),
  });
  const candidates = parseCandidates(text);
  return verify(candidates, citations);
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
