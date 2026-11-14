import { useEffect, useState } from 'react';
import { api } from '../api.js';

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Metric({ label, value, goal, ok }) {
  return (
    <div className={`card metric ${ok === undefined ? '' : ok ? 'ok' : 'miss'}`}>
      <div className="metric-value">{value}</div>
      <div>{label}</div>
      {goal && <small className="muted">goal: {goal}</small>}
    </div>
  );
}

export default function Admin() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/admin/stats').then(setS).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="page"><p className="error">{error}</p><p className="muted">Add your email to ADMIN_EMAILS on the server to see this page.</p></div>;
  if (!s) return <div className="page muted">Loading…</div>;
  const { totals: t, guests: g, retention: r } = s;

  return (
    <div className="page">
      <h1>Validation metrics</h1>
      <p className="muted">Live numbers for the report, measured against the goals in our one-pager.</p>
      <div className="metrics">
        <Metric label="Sign-ups" value={t.signups} goal="50" ok={t.signups >= 50} />
        <Metric label="Wishlists created" value={t.wishlists} goal="20" ok={t.wishlists >= 20} />
        <Metric label="Guests who reserved" value={pct(g.guests_reserved, g.guests)} goal="≥ 30%" ok={g.guests && g.guests_reserved / g.guests >= 0.3} />
        <Metric label="Guests who made their own list" value={pct(g.guests_created_list, g.guests)} goal="≥ 15%" ok={g.guests && g.guests_created_list / g.guests >= 0.15} />
        <Metric label="Users who came back (2+ days)" value={pct(r.returning_users, r.active_users)} goal="≥ 40%" ok={r.active_users && r.returning_users / r.active_users >= 0.4} />
        <Metric label="Secret Santa groups drawn" value={t.santa_drawn} goal="3" ok={t.santa_drawn >= 3} />
      </div>
      <h2>Raw numbers</h2>
      <table className="table">
        <tbody>
          {[
            ['Users who created a list', t.list_creators],
            ['Items added', t.items],
            ['Reservations / chip-ins', t.reservations],
            ['Chip-in gifts with contributions', t.chip_in_items],
            ['Unique visitors of shared lists (incl. anonymous)', t.unique_visitors],
            ['Signed-in guests (opened someone else’s list)', g.guests],
            ['Secret Santa groups (all / drawn)', `${t.santa_groups} / ${t.santa_drawn}`],
            ['Secret Santa members', t.santa_members],
          ].map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v}</b></td></tr>)}
        </tbody>
      </table>
      <h2>Sign-ups by day</h2>
      <table className="table"><tbody>{s.signupsByDay.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.n}</td></tr>)}</tbody></table>
      <h2>Feedback ({s.feedback.length})</h2>
      <div className="stack">
        {s.feedback.map((f, i) => (
          <div key={i} className="card">
            <div className="muted small">{new Date(f.created_at).toLocaleString()} · {f.name || 'anonymous'} · {f.page}{f.rating ? ` · ${'★'.repeat(f.rating)}` : ''}</div>
            <p>{f.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
