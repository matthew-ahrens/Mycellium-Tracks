import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'

/* Wraps the whole app. Nothing renders (no data loads, no queries fire)
   until there's a real Supabase session. Session persists in the browser,
   so this is a one-time thing per device, not a repeated login.

   Sign-in only, deliberately - no sign-up UI. There's exactly one account
   for this app, already created. Leaving a self-serve sign-up button live
   would mean anyone who finds the URL could register their own account
   and, once RLS just checks "is someone logged in," see everything. */
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still checking
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    /* If this hangs or fails - flaky connection, stale token, Supabase
       briefly unreachable - fall back to the sign-in screen instead of
       leaving the app stuck on a bare colored div forever with no error
       and no way out. */
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000));
    Promise.race([supabase.auth.getSession(), timeout])
      .then((result) => {
        if (result === 'timeout') {
          console.error('Session check timed out after 8s');
          setSession(null);
        } else {
          setSession(result.data.session);
        }
      })
      .catch((ex) => {
        console.error('Session check failed', ex);
        setSession(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      /* Same timeout backstop as the initial session check - a slow or
         hung request here shouldn't be able to leave the button stuck on
         "Working..." for a browser-default minute-ish before it gives up
         on its own. */
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out - check your connection and try again.')), 12000))
      const { error: err } = await Promise.race([
        supabase.auth.signInWithPassword({ email: email.trim(), password }),
        timeout,
      ])
      if (err) setError(err.message)
    } catch (ex) {
      setError(ex.message || 'Something went wrong - check the browser console.')
      console.error(ex)
    } finally {
      setBusy(false)
    }
  }

  if (session === undefined) {
    return <div style={{ background: '#B3966B', minHeight: '100vh' }} />
  }

  if (!session) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">Sign in</div>

          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Sign in'}
          </button>
        </form>
      </div>
    )
  }

  return children
}

const AUTH_CSS = `
.auth-card{
  max-width:340px;margin:14vh auto;padding:28px;background:#241811;border:1px solid #4A3826;
  border-radius:16px;display:flex;flex-direction:column;gap:10px;font-family:system-ui,-apple-system,sans-serif;
}
.auth-brand{font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;font-size:24px;color:#6B2717;}
.auth-sub{font-size:12.5px;color:#A6927A;margin-bottom:10px;}
.auth-card label{font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#A6927A;margin-top:6px;}
.auth-card input{background:#2F2216;border:1px solid #4A3826;border-radius:8px;padding:10px 12px;color:#EDE3D0;font-size:13.5px;}
.auth-card input:focus{outline:none;border-color:#D6934A;}
.auth-card button[type=submit]{margin-top:14px;background:#D6934A;color:#241811;border:none;border-radius:9px;padding:11px;font-size:13.5px;font-weight:600;cursor:pointer;}
.auth-card button[type=submit]:disabled{opacity:.6;cursor:default;}
.auth-error{background:#2E1710;border:1px solid #6B2717;color:#D4886B;font-size:12px;padding:8px 10px;border-radius:8px;}
body{background:#B3966B;margin:0;}
`
