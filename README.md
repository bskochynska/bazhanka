# Bazhanka — shared wishlists with secret gift reservations

**Bazhanka** ("бажанка", from *бажання*, "a wish") is a website where you create a wishlist for an occasion and share **one link**.
Friends reserve gifts from it: other guests see an item as taken, but **the owner never sees who reserved what**, so the surprise survives.
Several friends can **chip in** on one expensive gift, and groups can run a **Secret Santa** where everyone sees only their giftee's list.

It solves two problems for students and their friends:
- givers don't know what to buy, and asking directly ruins the surprise;
- gifts get duplicated because classmates, school friends and family are not in one chat.

Team: Inna Dermanska, Bohdana Skochynska, Ksenia Nimas (UCU).

**Live demo:** `https://<your-service>.onrender.com` *(replace after deploying)*

## Features

| Feature | Where |
|---|---|
| Sign up / sign in (email + password, httpOnly session cookie) | `/signup`, `/signin` |
| Create wishlists for an occasion and share them by link (copy or Telegram) | `/dashboard`, `/l/<code>` |
| Add an item by pasting a shop link: title, photo and price are filled in automatically when the shop allows it (JSON-LD / Open Graph); otherwise fill the item in by hand | owner view of a list |
| Secret reservation: guests see "already reserved", the owner sees nothing | guest view of a list |
| Chip in: several guests add amounts to one gift, with a progress bar | items marked "chip-in" |
| Secret Santa: invite link, the organiser draws names, each member sees only their giftee and their list | `/santa` |
| "Gifts I'm giving" across all lists | `/dashboard` |
| In-app feedback button and a metrics page for the validation goals | Feedback button, `/admin` |

## Gift ideas (AI search with partner shops)

Signed-in users open **Gift ideas** (`/ideas`), describe what they like and get real products from online shops, which they can add to a wishlist in one tap.

How it works (`backend/src/discover.js`, `bedrock.js`, `routes/discover.js`):

1. One call to **Amazon Nova 2 Lite on Amazon Bedrock** with the built-in **web grounding** tool searches the web and returns candidate products, each marked `direct` (fits the interests) or `adjacent` (related, shown as **Try something new**).
2. A candidate is kept only if its shop appeared in the search citations. Then the product page is read with the existing link-preview code, so title, photo and price come from the real page rather than from the model. Shops that block bots stay in the list without price and photo.
3. Results are cached for 24 h per normalized query and each user has a daily limit of fresh searches (`DISCOVER_DAILY_LIMIT`, default 5), which keeps the AI bill predictable.
4. **Partner shops** (admin page → *Gift ideas: partner shops*) are searched explicitly and ranked higher, always with a visible **Partner** mark. Ranking puts relevance first: a partner only moves up inside its relevance group, so an off-topic partner product never beats a direct match. Partners apply at read time, so pausing or adding one affects cached results at once.
5. The funnel per partner (shown → clicked → added to a list) is counted in `discover_events` and shown in the admin page; it is the evidence to show a shop when selling placement.

Local development without AWS: `DISCOVER_MOCK=true` returns sample offers (including a `partner-shop.example.ua` partner you can add in the admin page).

Cost and AWS notes:

- Web grounding is only available in US regions (this project runs in `us-east-1`) and is billed on top of model tokens; check the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/). Amazon's own Nova models are billed as an AWS service, so AWS promotional credits should apply; third-party models (such as Claude) are usually billed through AWS Marketplace, which credits typically do not cover. Confirm under *Billing → Credits* before relying on it.
- The Lambda role gets `bedrock:InvokeModel` and `bedrock:InvokeTool` (see `infra/backend.yml`). Enable access to the Nova model in the Bedrock console if your account asks for it.
- **The backend Lambda runs inside a VPC without internet access** (symptom in the logs: `discover search failed: fetch failed` after ~10 s). `infra/backend.yml` therefore creates a `bedrock-runtime` VPC interface endpoint (about $7/month, parameter `CreateBedrockEndpoint`). Bedrock then works, but shop pages cannot be read, so cards have no photo and only an approximate price. A NAT gateway (about $32/month) would also enable reading shop pages (and the existing link-preview); then set `CreateBedrockEndpoint=false`.
- CloudFront waits up to 60 s for the API (`OriginReadTimeout` in `infra/frontend.yml`) because a live search can take 20–40 s.
- Paid placement must be clearly labelled as advertising. Check local advertising rules before signing the first partner.

## Repository layout

```
backend/    Node.js + Express API, PostgreSQL (pg). Also serves the built frontend.
  src/index.js           server entry, static hosting, error handling
  src/db.js              connection pool + schema (created automatically on start)
  src/auth.js            JWT session cookie, password hashing in routes/auth.js
  src/preview.js         shop link → title/photo/price (with SSRF protection)
  src/routes/            auth, wishlists/items/reservations, santa, feedback/stats
  test/api.test.js       integration tests (needs Postgres)
frontend/   React 18 + Vite single-page app
  src/pages/             Home, Auth, Dashboard, ListPage (owner + guest views), Santa, Admin
infra/      Dockerfile, docker-compose.yml (local), render.yaml (deployment)
docs/       report template for the user-testing report
```

## Run locally

You need **Node.js 20+** and **PostgreSQL 14+**.

### Option A — Docker (easiest)

```bash
docker compose -f infra/docker-compose.yml up --build
```

Open http://localhost:3000. Sign up with `admin@example.com` to see `/admin`.

### Option B — without Docker

1. Create a database (default URL is `postgres://postgres:postgres@localhost:5432/bazhanka`):

```bash
createdb bazhanka
```

2. Start the API (tables are created automatically):

```bash
cd backend && npm install && ADMIN_EMAILS=you@example.com npm run dev
```

3. In a second terminal start the frontend with hot reload (proxies `/api` to port 3000):

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173.

### Tests

```bash
cd backend && npm test
```

The tests start the server against your local database and cover sign-up/sign-in, secret reservations (the owner must not see them),
chip-in, Secret Santa draws and admin access.

## Configuration

All configuration is via environment variables (see `backend/.env.example`):

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes in prod | PostgreSQL connection string |
| `DATABASE_SSL` | no | `true` for hosted Postgres reached over the internet (Neon, Supabase) |
| `JWT_SECRET` | **yes in prod** | secret used to sign session cookies |
| `ADMIN_EMAILS` | no | comma-separated emails allowed to open `/admin` |
| `DONATION_URL` | no | link shown in the footer (e.g. a Monobank jar for a volunteer cause) |
| `DONATION_LABEL` | no | text for that link |
| `PORT` | no | default 3000 |

## Deploy (HTTPS) — Render, free tier

The app is a single Docker service plus a Postgres database, described in `infra/render.yaml`.

1. Push this repository to GitHub.
2. In [Render](https://render.com): **New → Blueprint**, pick the repo, set **Blueprint Path** to `infra/render.yaml`.
3. When asked, fill in `ADMIN_EMAILS` (your team's emails) and optionally `DONATION_URL`.
4. Deploy. Render builds `infra/Dockerfile`, creates the database, generates `JWT_SECRET`, and gives you
   `https://bazhanka-xxxx.onrender.com` with HTTPS. The schema is created on first start.

Notes: the free web service sleeps after ~15 minutes idle (the first request then takes ~30–50 s — open it before a demo);
Render's free Postgres expires after 30 days, so for longer use point `DATABASE_URL` at a free [Neon](https://neon.tech) database with `DATABASE_SSL=true`.

**Any other host** that runs Docker works the same way (Fly.io, Railway, a VPS behind Caddy):

```bash
docker build -f infra/Dockerfile -t bazhanka .
```

```bash
docker run -p 3000:3000 -e DATABASE_URL=... -e JWT_SECRET=... bazhanka
```

## Measuring the validation goals

Sign in with an email listed in `ADMIN_EMAILS` and open `/admin`. It shows, live, the goals from our one-pager:
sign-ups (goal 50), wishlists (20), % of guests who reserved (≥ 30%), % of guests who created their own list (≥ 15%),
% of users who came back on another day (≥ 40%), and Secret Santa groups drawn (3), plus all feedback sent through the Feedback button.

## Privacy and security notes

- Reservation data is never sent to the list owner's browser; it's filtered on the server, not hidden in the UI.
- Passwords are hashed with bcrypt; sessions are signed httpOnly, SameSite=Lax cookies (Secure in production).
- The link-preview fetcher refuses private/internal addresses and limits redirects, time and size.
- Some large shops block automated requests; then the form simply asks the user to fill the details in by hand.
