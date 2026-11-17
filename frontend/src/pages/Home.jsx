import { Link } from 'react-router-dom';

const IDEAS = [
  { badge: 'Birthday', emoji: '🎂', title: 'Birthday wishlist', meta: 'Share one link with everyone' },
  { badge: 'Christmas', emoji: '🎄', title: 'Christmas wishlist', meta: 'No duplicate presents' },
  { badge: 'St Nicholas', emoji: '🧦', title: 'St Nicholas Day', meta: 'Small surprises, big joy' },
  { badge: 'Graduation', emoji: '🎓', title: 'Graduation gifts', meta: 'Chip in on the big one' },
];

export default function Home() {
  return (
    <div className="landing">
      {/* ---------- hero ---------- */}
      <section className="hero-banner">
        <div className="confetti" />
        <span className="star" aria-hidden>✦</span>
        <div className="float f1" aria-hidden>🎁</div>
        <div className="float f2" aria-hidden>💌</div>
        <div className="float f3" aria-hidden>🧴</div>
        <svg className="squiggle" viewBox="0 0 80 60" fill="none" stroke="#1c1917" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 14c30-14 62 2 40 16s-30 14-18 22 38 0 46-10" />
        </svg>

        <span className="hero-tree" aria-hidden>🎄</span>
        <span className="eyebrow">Shared wishlists · secret reservations</span>
        <h1>Wishes that stay surprises</h1>
        <p className="sub">
          Make a wishlist, share one link. Friends reserve gifts secretly — you never see who is giving what.
        </p>
        <div className="hero-actions">
          <Link to="/signup" className="btn light big">Create my wishlist</Link>
          <Link to="/signin" className="btn ghost big">Sign in</Link>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="section">
        <h2 className="section-title">How Bazhanka works</h2>
        <p className="section-sub">Three steps from idea to the perfect gift</p>
        <div className="deal-grid">
          <article className="deal">
            <div className="pic p1" aria-hidden>🔗</div>
            <h3>Paste a shop link</h3>
            <p>Title, photo and price are filled in automatically.</p>
            <Link to="/signup" className="btn small">Try it</Link>
          </article>
          <article className="deal">
            <div className="pic p2" aria-hidden>🤫</div>
            <h3>Secret reservations</h3>
            <p>No duplicates and no spoilers — guests see an item as taken, you don’t.</p>
            <Link to="/signup" className="btn small">Try it</Link>
          </article>
          <article className="deal">
            <div className="pic p3" aria-hidden>🤝</div>
            <h3>Chip in together</h3>
            <p>Expensive gift? Friends add what they can and watch the total grow.</p>
            <Link to="/signup" className="btn small">Try it</Link>
          </article>
        </div>
      </section>

      {/* ---------- occasions ---------- */}
      <section className="section">
        <h2 className="section-title">Lists for every occasion</h2>
        <p className="section-sub">Pick a moment, start a list in a minute</p>
        <div className="wish-row">
          {IDEAS.map((i) => (
            <Link key={i.title} to="/signup" className="wish" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="badge">{i.badge}</span>
              <div className="thumb" aria-hidden>{i.emoji}</div>
              <span className="stars-row" aria-hidden>★★★★★</span>
              <h3>{i.title}</h3>
              <span className="meta">{i.meta}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ---------- Secret Santa ---------- */}
      <section className="bundle">
        <div className="left">
          <div>
            <div className="big" aria-hidden>🎅</div>
            <p>Invite your group, we draw the pairs. Everyone sees only their giftee’s list.</p>
          </div>
        </div>
        <div className="right">
          <h2 className="section-title">Secret Santa</h2>
          <p className="section-sub" style={{ margin: 0 }}>Draw names in one tap</p>
          <div className="bundle-cards" aria-hidden>
            <div className="mini"><span className="em">🎁</span>Invite link</div>
            <div className="mini"><span className="em">🎲</span>Fair draw</div>
          </div>
          <Link to="/signup" className="btn">Start Secret Santa</Link>
        </div>
      </section>
    </div>
  );
}
