import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className="page home">
      <section className="hero">
        <h1>Gifts people actually want.<br />Surprises that stay surprises.</h1>
        <p className="lead">
          Make a wishlist for your birthday, graduation or Christmas and share one link.
          Friends reserve gifts secretly — everyone else sees an item as taken, but <b>you never see who is giving what</b>.
        </p>
        <div className="row">
          <Link to="/signup" className="btn big">Create my wishlist</Link>
          <Link to="/signin" className="btn ghost big">I already have an account</Link>
        </div>
      </section>
      <section className="features">
        <div className="card"><h3>🔗 Paste a shop link</h3><p>Title, photo and price are filled in automatically.</p></div>
        <div className="card"><h3>🤫 Secret reservations</h3><p>No duplicate gifts between classmates, school friends and family — and no spoilers for you.</p></div>
        <div className="card"><h3>🤝 Chip in</h3><p>Expensive gift? Several friends add what they can and watch the total grow.</p></div>
        <div className="card"><h3>🎅 Secret Santa</h3><p>Invite your group, we draw the pairs. Each person sees only their giftee’s list.</p></div>
      </section>
    </div>
  );
}
