import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { setSession, clearSession, isAdmin } from '../auth.js';
import { ah, HttpError, str } from '../util.js';

const r = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Very small in-memory throttle for sign-in attempts per IP.
const attempts = new Map();
function throttle(req) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) { rec.n = 0; rec.since = now; }
  rec.n++;
  attempts.set(key, rec);
  if (rec.n > 30) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: isAdmin(u) });

r.post('/signup', ah(async (req, res) => {
  throttle(req);
  const email = str(req.body.email, 200)?.toLowerCase();
  const name = str(req.body.name, 80);
  const password = String(req.body.password || '');
  const cameFrom = str(req.body.cameFrom, 40);
  if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!name) throw new HttpError(400, 'Enter your name');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, came_from_slug) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
    [email, name, hash, cameFrom],
  );
  if (!rows[0]) throw new HttpError(409, 'An account with this email already exists — sign in instead');
  setSession(res, rows[0].id);
  res.status(201).json({ user: publicUser(rows[0]) });
}));

r.post('/login', ah(async (req, res) => {
  throttle(req);
  const email = str(req.body.email, 200)?.toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
}));

r.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

export default r;
