import { verifyAccessToken } from '../auth/tokens.js'
import { unauthorized } from '../errors/http-errors.js'

export function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Authentication is required')
    }

    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      throw unauthorized('Authentication is required')
    }

    let payload
    try {
      payload = verifyAccessToken(token)
    } catch {
      throw unauthorized('Invalid or expired access token')
    }

    if (!payload?.sub) {
      throw unauthorized('Invalid or expired access token')
    }

    req.userId = payload.sub
    next()
  } catch (error) {
    next(error)
  }
}
