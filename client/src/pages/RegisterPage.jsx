import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useSession } from '../auth/session-context.js'
import { authErrorMessage, fieldErrors } from './auth-errors.js'

const inputClass =
  'mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/50'

export function RegisterPage() {
  const { register, isAuthenticated } = useSession()
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const emailRef = useRef(null)
  const passwordRef = useRef(null)

  useEffect(() => {
    if (!error) return
    const fields = Object.keys(fieldErrors(error))
    const name = fields[0] ?? (error.code === 'email_taken' ? 'email' : 'password')
    ;(name === 'password' ? passwordRef : emailRef).current?.focus()
  }, [error])

  async function handleSubmit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setPending(true)
    try {
      await register({
        email: form.get('email'),
        password: form.get('password'),
        ...(form.get('displayName') ? { displayName: form.get('displayName') } : {}),
        ...(form.get('organizationName') ? { organizationName: form.get('organizationName') } : {}),
      })
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  if (isAuthenticated) return <Navigate to="/" replace />

  const fields = fieldErrors(error)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-slate-100">Create your account</h1>
        <p className="mt-1 text-sm text-slate-400">Set up your DispatchGrid organization.</p>
        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
          {error ? (
            <div
              role="alert"
              className="rounded-card border border-danger/30 bg-danger/10 p-gutter text-sm text-danger"
            >
              {authErrorMessage(error)}
            </div>
          ) : null}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              ref={emailRef}
              aria-invalid={fields.email ? true : undefined}
              aria-describedby={fields.email ? 'email-error' : undefined}
              className={inputClass}
            />
            {fields.email ? (
              <p id="email-error" className="mt-1 text-xs text-danger">
                {fields.email}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              ref={passwordRef}
              aria-invalid={fields.password ? true : undefined}
              aria-describedby={fields.password ? 'password-error' : undefined}
              className={inputClass}
            />
            {fields.password ? (
              <p id="password-error" className="mt-1 text-xs text-danger">
                {fields.password}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="displayName" className="block text-sm font-medium text-slate-300">
              Display name <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              autoComplete="name"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="organizationName" className="block text-sm font-medium text-slate-300">
              Organization name <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <input
              id="organizationName"
              name="organizationName"
              type="text"
              autoComplete="organization"
              className={inputClass}
            />
          </div>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-primary/90 disabled:opacity-60"
          >
            {pending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="mt-4 text-sm text-slate-400">
          Already registered?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  )
}
