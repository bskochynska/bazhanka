import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { HttpError } from './util.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
const COOKIE = 'bz_session';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Attaches req.user if a valid session cookie is present; never rejects.
export async function loadUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const { uid } = jwt.verify(token, SECRET);
    const { rows } = await query('SELECT id, email, name FROM users WHERE id = $1', [uid]);
    if (rows[0]) {
      req.user = rows[0];
      // One row per user per day -> "came back" metric.
      query('INSERT INTO activity_days (user_id, day) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING', [uid]).catch(() => {});
    }
  } catch {
    /* invalid/expired token: treat as signed out */
  }
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

export function isAdmin(user) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !!user && admins.includes(user.email.toLowerCase());
}
