import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'

/* Password rules for sign-up (2026-09-18): 8+ chars, at least one digit,
   at least one special character. Checked client-side before signUp() is
   ever called - Supabase Auth's own password policy isn't configured to
   enforce this, so this is the actual enforcement, not just UX polish. */
function passwordMeetsRequirements(pw) {
  return pw.length >= 8 && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)
}

/* Lightweight in-house strength score (0-5), no external library - this
   is a beta-gated app, not a bank, a rough visual nudge is enough. */
function passwordStrengthScore(pw) {
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  return score
}

const STRENGTH_LEVELS = [
  { label: 'Too weak', color: '#D4886B' },
  { label: 'Too weak', color: '#D4886B' },
  { label: 'Fair', color: '#D6934A' },
  { label: 'Good', color: '#C9C25A' },
  { label: 'Strong', color: '#9AD488' },
  { label: 'Strong', color: '#9AD488' },
]

function PasswordStrengthMeter({ password }) {
  const score = passwordStrengthScore(password)
  const { label, color } = STRENGTH_LEVELS[score]
  return (
    <div className="pw-strength">
      <div className="pw-strength-track">
        <div className="pw-strength-fill" style={{ width: `${(score / 5) * 100}%`, background: color }} />
      </div>
      <span className="pw-strength-label" style={{ color }}>{label}</span>
    </div>
  )
}

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
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'forgot'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [betaCode, setBetaCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  // True once Supabase reports the PASSWORD_RECOVERY event - fires after
  // the user clicks a "reset your password" email link and lands back
  // here with a valid-but-special recovery session. While true, they see
  // the set-new-password screen regardless of session state, instead of
  // being dropped straight into the app on a session they didn't mean to
  // just "log in" with.
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')

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

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (_event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      setSession(s);
    });
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

      if (mode === 'forgot') {
        const { error: err } = await withTimeout(
          supabase.auth.resetPasswordForEmail(email.trim(), {
            // Same reasoning as signUp's emailRedirectTo below - explicit
            // rather than relying on the dashboard's Site URL. Landing
            // back here fires Supabase's PASSWORD_RECOVERY event, which
            // the onAuthStateChange listener above catches to show the
            // set-new-password screen instead of the sign-in form.
            redirectTo: window.location.origin,
          })
        )
        if (err) { setError(err.message); return }
        // Deliberately doesn't say whether the email exists - Supabase's
        // own call doesn't distinguish this either, so no wording here
        // should claim otherwise (that would leak which emails have
        // accounts).
        setResetSent(true)
        return
      }

      if (mode === 'signin') {
        const { error: err } = await withTimeout(
          supabase.auth.signInWithPassword({ email: email.trim(), password })
        )
        if (err) setError(err.message)
        return
      }

      // Sign up: validate the password locally first - no reason to hit
      // the network at all if it's already going to fail.
      if (!passwordMeetsRequirements(password)) {
        setError('Password must be at least 8 characters and include a number and a special character.')
        return
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.')
        return
      }

      // Sign up: check the beta code first for a clean error message,
      // before touching auth.users at all.
      const { data: codeOk, error: codeErr } = await withTimeout(
        supabase.rpc('check_beta_code', { code: betaCode.trim() })
      )
      if (codeErr) { setError(codeErr.message); return }
      if (!codeOk) { setError('That beta code is not valid - double check it and try again.'); return }

      const { data: signUpData, error: err } = await withTimeout(
        supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { beta_code: betaCode.trim() },
            // Explicit rather than relying on the dashboard's Site URL -
            // this is where the confirmation-email link sends them back
            // to. Must be present in Supabase's Redirect URLs allow list
            // (Auth > URL Configuration) or Supabase silently falls back
            // to the Site URL instead of honoring this.
            emailRedirectTo: window.location.origin,
          },
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
      if (signUpData.session) {
        // Email confirmation is off (or this project auto-confirms) -
        // already signed in. onAuthStateChange picks this up and swaps
        // straight to the app; nothing else to do here.
        return
      }
      // Confirmation required (the actual default for this project, even
      // though nothing here used to say so) - don't claim they can sign in
      // yet, that fails with "Email not confirmed" until the link's clicked.
      // Clicking it redirects back here with the session already attached
      // (supabase-js auto-detects it from the URL), so there's no separate
      // manual sign-in step after confirming.
      setAwaitingConfirmation(true)
      setPassword('')
      setConfirmPassword('')
    } catch (ex) {
      setError(ex.message || 'Something went wrong - check the browser console.')
      console.error(ex)
    } finally {
      setBusy(false)
    }
  }

  const submitNewPassword = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!passwordMeetsRequirements(newPassword)) {
        setError('Password must be at least 8 characters and include a number and a special character.')
        return
      }
      if (newPassword !== newPasswordConfirm) {
        setError('Passwords do not match.')
        return
      }
      const withTimeout = (p) => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out - check your connection and try again.')), 12000)),
      ])
      const { error: err } = await withTimeout(supabase.auth.updateUser({ password: newPassword }))
      if (err) { setError(err.message); return }
      // The recovery session Supabase attached on redirect is already a
      // real, valid session - clearing recoveryMode is enough to drop
      // straight into the app, same auto-sign-in pattern as email
      // confirmation. No separate manual sign-in step.
      setRecoveryMode(false)
      setNewPassword('')
      setNewPasswordConfirm('')
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
        <img src={`${import.meta.env.BASE_URL}sporedesk-lockup-stacked-light.svg`} alt="SporeDesk" className="auth-loading-mark" />
      </div>
    )
  }

  if (recoveryMode) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <form className="auth-card" onSubmit={submitNewPassword}>
          <img src={`${import.meta.env.BASE_URL}sporedesk-plate.svg`} alt="" className="auth-badge" />
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">Set a new password</div>

          <label>New password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoFocus />
          {newPassword && <PasswordStrengthMeter password={newPassword} />}

          <label>Confirm new password</label>
          <input type="password" value={newPasswordConfirm} onChange={(e) => setNewPasswordConfirm(e.target.value)} required minLength={8} />

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Set password'}
          </button>
        </form>
      </div>
    )
  }

  if (!session && awaitingConfirmation) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <div className="auth-card">
          <img src={`${import.meta.env.BASE_URL}sporedesk-plate.svg`} alt="" className="auth-badge" />
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">Confirm your email</div>
          <p className="auth-confirm-text">
            We sent a confirmation link to <strong>{email.trim()}</strong>. Click it to activate your
            account - this tab will sign you in automatically once you do, no need to come back and
            sign in by hand.
          </p>
          <button type="button" className="auth-switch" onClick={() => {
            setAwaitingConfirmation(false)
            setMode('signup')
            setError('')
            setNotice('')
          }}>
            Wrong email? Start over
          </button>
        </div>
      </div>
    )
  }

  if (!session && mode === 'forgot' && resetSent) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <div className="auth-card">
          <img src={`${import.meta.env.BASE_URL}sporedesk-plate.svg`} alt="" className="auth-badge" />
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">Check your email</div>
          <p className="auth-confirm-text">
            If an account exists for <strong>{email.trim()}</strong>, we've sent a link to reset the
            password. Click it and you'll be asked to set a new one - no need to come back here and
            sign in by hand afterward.
          </p>
          <button type="button" className="auth-switch" onClick={() => {
            setResetSent(false)
            setMode('signin')
            setError('')
            setNotice('')
          }}>
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div>
        <style>{AUTH_CSS}</style>
        <form className="auth-card" onSubmit={submit}>
          <img src={`${import.meta.env.BASE_URL}sporedesk-plate.svg`} alt="" className="auth-badge" />
          <div className="auth-brand">SporeDesk</div>
          <div className="auth-sub">
            {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create an account - beta' : 'Reset your password'}
          </div>

          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />

          {mode !== 'forgot' && (
            <>
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 8 : 6} />
              {mode === 'signup' && password && <PasswordStrengthMeter password={password} />}
            </>
          )}

          {mode === 'signup' && (
            <>
              <label>Confirm password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />

              <label>Beta code</label>
              <input type="text" value={betaCode} onChange={(e) => setBetaCode(e.target.value)} required />

              {/* Required consent: age gate + agreement to the Terms/Privacy
                  Policy, which live on the marketing site (single source). */}
              <label className="auth-consent">
                <input type="checkbox" required />
                <span>
                  I'm 18 or older and agree to the{' '}
                  <a href="https://sporedesk.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
                  {' '}and{' '}
                  <a href="https://sporedesk.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
                </span>
              </label>
            </>
          )}

          {error && <div className="auth-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>

          {mode === 'signin' && (
            <button type="button" className="auth-switch" onClick={() => {
              setMode('forgot')
              setError('')
              setNotice('')
            }}>
              Forgot password?
            </button>
          )}

          {mode !== 'forgot' && (
            <button type="button" className="auth-switch" onClick={() => {
              setMode(mode === 'signup' ? 'signin' : 'signup')
              setError('')
              setNotice('')
            }}>
              {mode === 'signup' ? 'Already have an account? Sign in' : "Have a beta code? Create an account"}
            </button>
          )}

          {mode === 'forgot' && (
            <button type="button" className="auth-switch" onClick={() => {
              setMode('signin')
              setError('')
              setNotice('')
            }}>
              Back to sign in
            </button>
          )}
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
.auth-confirm-text{font-size:13px;line-height:1.55;color:#D8CDB8;margin:4px 0 6px;}
.auth-card label{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#A6927A;margin-top:6px;}
.auth-card input{background:#2F2216;border:1px solid #4A3826;border-radius:8px;padding:10px 12px;color:#EDE3D0;font-size:13.5px;}
.auth-card input:focus{outline:none;border-color:#D6934A;}
.auth-card button[type=submit]{margin-top:14px;background:#D6934A;color:#241811;border:none;border-radius:9px;padding:11px;font-size:13.5px;font-weight:600;cursor:pointer;}
.auth-card button[type=submit]:disabled{opacity:.6;cursor:default;}
.auth-error{background:#2E1710;border:1px solid #6B2717;color:#D4886B;font-size:12px;padding:8px 10px;border-radius:8px;}
.auth-notice{background:#1E2E17;border:1px solid #3A6B27;color:#9AD488;font-size:12px;padding:8px 10px;border-radius:8px;}
.auth-switch{background:none;border:none;color:#A6927A;font-size:12px;text-decoration:underline;cursor:pointer;padding:4px 0;margin-top:2px;}
.auth-card label.auth-consent{display:flex;align-items:flex-start;gap:9px;margin-top:12px;font-family:inherit;font-size:12.5px;letter-spacing:normal;text-transform:none;line-height:1.5;color:#D8CDB8;cursor:pointer;}
.auth-card label.auth-consent input{width:16px;height:16px;padding:0;margin:2px 0 0;flex:none;accent-color:#D6934A;}
.auth-card label.auth-consent a{color:#D6934A;}
.pw-strength{display:flex;align-items:center;gap:8px;margin-top:5px;}
.pw-strength-track{flex:1;height:5px;background:#2F2216;border-radius:3px;overflow:hidden;}
.pw-strength-fill{height:100%;border-radius:3px;transition:width .15s ease,background .15s ease;}
.pw-strength-label{font-size:10px;font-family:ui-monospace,monospace;letter-spacing:.05em;white-space:nowrap;}
body{background:#B3966B;margin:0;}
`
