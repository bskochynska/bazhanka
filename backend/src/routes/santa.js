import { Router } from 'express';
import { query, tx } from '../db.js';
import { requireUser } from '../auth.js';
import { ah, HttpError, str, randomCode, drawPairs } from '../util.js';

const r = Router();
r.use(requireUser);

async function groupByCode(code) {
  const { rows } = await query('SELECT * FROM santa_groups WHERE code = $1', [String(code).toLowerCase()]);
  if (!rows[0]) throw new HttpError(404, 'Secret Santa group not found — check the invite link');
  return rows[0];
}

async function checkOwnWishlist(wishlistId, userId) {
  if (!wishlistId) return null;
  const { rows } = await query('SELECT id FROM wishlists WHERE id = $1 AND owner_id = $2', [wishlistId, userId]);
  if (!rows[0]) throw new HttpError(400, 'Pick one of your own wishlists');
  return rows[0].id;
}

r.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, (SELECT count(*) FROM santa_members m2 WHERE m2.group_id = g.id) AS members
     FROM santa_groups g JOIN santa_members m ON m.group_id = g.id
     WHERE m.user_id = $1 ORDER BY g.created_at DESC`,
    [req.user.id],
  );
  res.json({
    groups: rows.map((g) => ({ name: g.name, code: g.code, members: Number(g.members), drawn: !!g.drawn_at, exchangeDate: g.exchange_date ? String(g.exchange_date).slice(0, 10) : null })),
  });
}));

r.post('/', ah(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Give your group a name');
  const wishlistId = await checkOwnWishlist(req.body.wishlistId, req.user.id);
  const code = await tx(async (c) => {
    const code = randomCode(8);
    const { rows } = await c.query(
      'INSERT INTO santa_groups (name, code, owner_id, budget, exchange_date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, code, req.user.id, str(req.body.budget, 60), str(req.body.exchangeDate, 10)],
    );
    await c.query('INSERT INTO santa_members (group_id, user_id, wishlist_id) VALUES ($1,$2,$3)', [rows[0].id, req.user.id, wishlistId]);
    return code;
  });
  res.status(201).json({ code });
}));

r.get('/:code', ah(async (req, res) => {
  const g = await groupByCode(req.params.code);
  const { rows: members } = await query(
    `SELECT m.user_id, m.wishlist_id, m.giftee_id, u.name FROM santa_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 ORDER BY m.joined_at`,
    [g.id],
  );
  const me = members.find((m) => m.user_id === req.user.id);
  let giftee = null;
  if (g.drawn_at && me?.giftee_id) {
    const target = members.find((m) => m.user_id === me.giftee_id);
    let list = null;
    if (target?.wishlist_id) {
      const w = await query('SELECT title, slug FROM wishlists WHERE id = $1', [target.wishlist_id]);
      list = w.rows[0] || null;
    }
    giftee = { name: target?.name || 'A former member', list };
  }
  res.json({
    group: {
      name: g.name,
      code: g.code,
      budget: g.budget,
      exchangeDate: g.exchange_date ? String(g.exchange_date).slice(0, 10) : null,
      drawn: !!g.drawn_at,
    },
    isOwner: g.owner_id === req.user.id,
    isMember: !!me,
    myWishlistId: me?.wishlist_id || null,
    // Members only see who is in the group and whether they attached a list.
    members: members.map((m) => ({ name: m.name, hasList: !!m.wishlist_id, isMe: m.user_id === req.user.id })),
    giftee,
  });
}));

r.post('/:code/join', ah(async (req, res) => {
  const g = await groupByCode(req.params.code);
  if (g.drawn_at) throw new HttpError(409, 'Names have already been drawn in this group');
  const wishlistId = await checkOwnWishlist(req.body.wishlistId, req.user.id);
  await query(
    `INSERT INTO santa_members (group_id, user_id, wishlist_id) VALUES ($1,$2,$3)
     ON CONFLICT (group_id, user_id) DO UPDATE SET wishlist_id = EXCLUDED.wishlist_id`,
    [g.id, req.user.id, wishlistId],
  );
  res.json({ ok: true });
}));

r.patch('/:code/me', ah(async (req, res) => {
  const g = await groupByCode(req.params.code);
  const wishlistId = await checkOwnWishlist(req.body.wishlistId, req.user.id);
  const { rowCount } = await query('UPDATE santa_members SET wishlist_id = $1 WHERE group_id = $2 AND user_id = $3', [wishlistId, g.id, req.user.id]);
  if (!rowCount) throw new HttpError(403, 'Join the group first');
  res.json({ ok: true });
}));

r.delete('/:code/me', ah(async (req, res) => {
  const g = await groupByCode(req.params.code);
  if (g.drawn_at) throw new HttpError(409, 'You cannot leave after the draw');
  if (g.owner_id === req.user.id) throw new HttpError(400, 'The organiser cannot leave; delete the group instead');
  await query('DELETE FROM santa_members WHERE group_id = $1 AND user_id = $2', [g.id, req.user.id]);
  res.json({ ok: true });
}));

r.delete('/:code', ah(async (req, res) => {
  const g = await groupByCode(req.params.code);
  if (g.owner_id !== req.user.id) throw new HttpError(403, 'Only the organiser can delete the group');
  await query('DELETE FROM santa_groups WHERE id = $1', [g.id]);
  res.json({ ok: true });
}));

r.post('/:code/draw', ah(async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM santa_groups WHERE code = $1 FOR UPDATE', [String(req.params.code).toLowerCase()]);
    const g = rows[0];
    if (!g) throw new HttpError(404, 'Group not found');
    if (g.owner_id !== req.user.id) throw new HttpError(403, 'Only the organiser can draw names');
    if (g.drawn_at) throw new HttpError(409, 'Names have already been drawn');
    const members = (await c.query('SELECT user_id FROM santa_members WHERE group_id = $1', [g.id])).rows.map((m) => m.user_id);
    if (members.length < 3) throw new HttpError(400, 'You need at least 3 people to draw names');
    const pairs = drawPairs(members);
    for (const [giver, giftee] of pairs) {
      await c.query('UPDATE santa_members SET giftee_id = $1 WHERE group_id = $2 AND user_id = $3', [giftee, g.id, giver]);
    }
    await c.query('UPDATE santa_groups SET drawn_at = now() WHERE id = $1', [g.id]);
  });
  res.json({ ok: true });
}));

export default r;
