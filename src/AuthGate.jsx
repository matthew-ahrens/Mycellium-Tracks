import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'

/* Wraps the whole app. Nothing renders (no data loads, no queries fire)
   until there's a real Supabase session. Session persists in the browser,
   so this is a one-time thing per device, not a repeated login.

   Sign-up added 2026-09-17 alongside real per-user data isolation
   (every table now has user_id + owner-scoped RLS, see the migration
   history) - self-serve is safe now that RLS actually separates one
   account's data from another's. Gated by a shared beta code, checked
   two ways: a pre-flight RPC (public.check_beta_code) for a clean error
   message before attempting signUp(), and a BEFORE INSERT trigger on
   auth.users (public.enforce_beta_code) as the real enforcement - the
   RPC alone wouldn't stop someone from calling supabase.auth.signUp()
   directly and skipping it. The code itself lives in the app_config
   table, not hardcoded here, so Matt can rotate it any time from the
   Supabase dashboard without a redeploy. This gate is beta-only - hard
   launch replaces it with a paywall/subscription check instead. */
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still checking
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [betaCode, setBetaCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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
    setNotice('')
    setBusy(true)
    try {
      /* Same timeout backstop as the initial session check - a slow or
         hung request here shouldn't be able to leave the button stuck on
         "Working..." for a browser-default minute-ish before it gives up
         on its own. */
      const withTimeout = (p) => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out - check your connection and try again.')), 12000)),
      ])

      if (mode === 'signin') {
        const { error: err } = await withTimeout(
          supabase.auth.signInWithPassword({ email: email.trim(), password })
        )
        if (err) setError(err.message)
        return
      }

      // Sign up: check the beta code first for a clean error message,
      // before touching auth.users at all.
      const { data: codeOk, error: codeErr } = await withTimeout(
        supabase.rpc('check_beta_code', { code: betaCode.trim() })
      )
      if (codeErr) { setError(codeErr.message); return }
      if (!codeOk) { setError('That beta code is not valid - double check it and try again.'); return }

      const { error: err } = await withTimeout(
        supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { beta_code: betaCode.trim() } },
        })
      )
      if (err) {
        // The auth.users trigger is the real enforcement, but Supabase Auth
        // wraps a trigger exception in a generic message rather than
        // passing it through - the RPC check above is what actually
        // surfaces a clean "invalid code" message in the normal case.
        setError(err.message)
        return
      }
      setNotice('Account created - you can sign in now.')
      setMode('signin')
      setPassword('')
    } catch (ex) {
      setError(ex.message || 'Something went wrong - check the browser console.')
      console.error(ex)
    } finally {
      setBusy(false)
    }
  }

  if (session === undefined) {
    return (
      <div className="auth-loading">
        <style>{AUTH_CSS}</style>
        <img src={`${import.meta.env.BASE_URL}sporedesk-wordmark.png`} alt="SporeDesk" className="auth-loading-mark" />
      </div>
    )
  }

  if (!session) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <form className="auth-card" onSubmit={submit}>
          <img src={`${import.meta.env.BASE_URL}sporedesk-badge.png`} alt="" className="auth-badge" />
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">{mode === 'signin' ? 'Sign in' : 'Create an account - beta'}</div>

          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />

          {mode === 'signup' && (
            <>
              <label>Beta code</label>
              <input type="text" value={betaCode} onChange={(e) => setBetaCode(e.target.value)} required />
            </>
          )}

          {error && <div className="auth-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <button type="button" className="auth-switch" onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError('')
            setNotice('')
          }}>
            {mode === 'signin' ? "Have a beta code? Create an account" : 'Already have an account? Sign in'}
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
.auth-brand{font-family:'Libre Caslon Display','Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;font-size:24px;color:#6B2717;}
.auth-badge{width:64px;height:64px;align-self:center;margin-bottom:2px;}
.auth-loading{background:#B3966B;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.auth-loading-mark{width:220px;max-width:60vw;animation:auth-pulse 1.8s ease-in-out infinite;}
@keyframes auth-pulse{0%,100%{opacity:.55;transform:scale(.97);}50%{opacity:1;transform:scale(1);}}
.auth-sub{font-size:12.5px;color:#A6927A;margin-bottom:10px;}
.auth-card label{font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#A6927A;margin-top:6px;}
.auth-card input{background:#2F2216;border:1px solid #4A3826;border-radius:8px;padding:10px 12px;color:#EDE3D0;font-size:13.5px;}
.auth-card input:focus{outline:none;border-color:#D6934A;}
.auth-card button[type=submit]{margin-top:14px;background:#D6934A;color:#241811;border:none;border-radius:9px;padding:11px;font-size:13.5px;font-weight:600;cursor:pointer;}
.auth-card button[type=submit]:disabled{opacity:.6;cursor:default;}
.auth-error{background:#2E1710;border:1px solid #6B2717;color:#D4886B;font-size:12px;padding:8px 10px;border-radius:8px;}
.auth-notice{background:#1E2E17;border:1px solid #3A6B27;color:#9AD488;font-size:12px;padding:8px 10px;border-radius:8px;}
.auth-switch{background:none;border:none;color:#A6927A;font-size:12px;text-decoration:underline;cursor:pointer;padding:4px 0;margin-top:2px;}
body{background:#B3966B;margin:0;}
`
