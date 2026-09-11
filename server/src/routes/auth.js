import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { registerUser } from '../auth/register.js'
import { loginUser } from '../auth/login.js'
import { rotateRefreshToken, revokeFamily } from '../auth/refresh-tokens.js'
import { signAccessToken } from '../auth/tokens.js'
import { authenticate } from '../middleware/authenticate.js'
import { authLimiter } from '../lib/rate-limit.js'
import { unauthorized, notFound } from '../errors/http-errors.js'
import {
  getCookie,
  REFRESH_COOKIE,
  REFRESH_COOKIE_OPTIONS,
  CLEAR_COOKIE_OPTIONS,
} from '../lib/cookies.js'

const router = Router()

const serializeUser = (user) => ({ id: user.id, email: user.email })

const registerSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().min(1).max(120).optional(),
    organizationName: z.string().min(1).max(160).optional(),
  })
  .strict()

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body)
    const { user, accessToken, refreshToken } = await registerUser(input.email, input.password, {
      displayName: input.displayName,
      organizationName: input.organizationName,
    })

    res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS)
    res.status(201).json({ user: serializeUser(user), accessToken })
  } catch (err) {
    next(err)
  }
})

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string(),
  })
  .strict()

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body)
    const { user, accessToken, refreshToken } = await loginUser(email, password)

    res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS)
    res.json({ user: serializeUser(user), accessToken })
  } catch (err) {
    next(err)
  }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, REFRESH_COOKIE)
    if (!rawToken) throw unauthorized('Refresh token missing')

    const result = await rotateRefreshToken(rawToken)
    if (result.error) {
      res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTIONS)
      throw unauthorized('Refresh token invalid, reused, or expired')
    }

    const user = await prisma.user.findUnique({ where: { id: result.userId } })
    if (!user) throw unauthorized('Refresh token invalid, reused, or expired')

    res.cookie(REFRESH_COOKIE, result.raw, REFRESH_COOKIE_OPTIONS)
    res.json({ user: serializeUser(user), accessToken: signAccessToken(result.userId) })
  } catch (err) {
    next(err)
  }
})

router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = getCookie(req, REFRESH_COOKIE)
    if (rawToken) await revokeFamily(rawToken)
    res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTIONS)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!user) throw notFound('User not found')
    res.json(serializeUser(user))
  } catch (err) {
    next(err)
  }
})

export default router
