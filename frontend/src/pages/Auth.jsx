import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSession } from '../session.jsx';

export default function Auth({ mode }) {
  const isSignup = mode === 'signup';
  const [params] = useSearchParams();
  const next = params.get('next') || '/dashboard';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const cameFrom = safeNext.match(/^\/(?:l|santa)\/([\w-]+)/)?.[1];
      const { user } = await api(isSignup ? '/auth/signup' : '/auth/login', {
        method: 'POST',
        body: isSignup ? { ...form, cameFrom } : { email: form.email, password: form.password },
      });
      setUser(user);
      navigate(safeNext, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const other = `${isSignup ? '/signin' : '/signup'}${params.get('next') ? `?next=${encodeURIComponent(safeNext)}` : ''}`;

  return (
    <div className="page narrow">
      <div className="card">
        <h1>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
        {params.get('next')?.startsWith('/l/') && (
          <p className="muted">Sign {isSignup ? 'up' : 'in'} to reserve a gift. The list owner will never see that it was you.</p>
        )}
        <form onSubmit={submit} className="stack">
          {isSignup && (
            <label>Your name<input required value={form.name} onChange={set('name')} autoComplete="name" placeholder="Bohdana" /></label>
          )}
          <label>Email<input required type="email" value={form.email} onChange={set('email')} autoComplete="email" /></label>
          <label>
            Password
            <input required type="password" minLength={isSignup ? 8 : undefined} value={form.password} onChange={set('password')}
              autoComplete={isSignup ? 'new-password' : 'current-password'} />
            {isSignup && <small className="muted">At least 8 characters</small>}
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? 'Please wait…' : isSignup ? 'Sign up' : 'Sign in'}</button>
        </form>
        <p className="muted center">
          {isSignup ? 'Already have an account? ' : 'New to Bazhanka? '}
          <Link to={other}>{isSignup ? 'Sign in' : 'Create an account'}</Link>
        </p>
      </div>
    </div>
  );
}
