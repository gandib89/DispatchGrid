import { env } from '../env.js'
import { config } from '../config.js'

// Hand-rolled instead of pulling in cookie-parser: we read exactly one cookie,
// on four routes. It lives here so nothing route-shaped depends on it.

export function getCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return undefined
  const match = header
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
}

export const REFRESH_COOKIE = 'refreshToken'

const isProd = env.NODE_ENV === 'production'

export const REFRESH_COOKIE_OPTIONS = {
  // JS cannot read it, so XSS cannot steal it. This is the entire reason the
  // refresh token is a cookie and the access token is not.
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  // Scoped to the auth routes only — the cookie is NOT attached to the other
  // endpoints, which shrinks the CSRF surface to four POST routes that all
  // rotate the token anyway.
  path: `${config.apiPrefix}/auth`,
  maxAge: 7 * 24 * 60 * 60 * 1000,
}

export const CLEAR_COOKIE_OPTIONS = { path: REFRESH_COOKIE_OPTIONS.path }
