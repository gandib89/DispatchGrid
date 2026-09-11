import { forbidden } from '../errors/http-errors.js'

export function actorFrom(req) {
  return req.actor
}

export function authorize(requiredPermission) {
  return (req, _res, next) => {
    try {
      if (!req.actor) {
        throw forbidden('Authorization requires an organization context')
      }
      if (!req.actor.permissions.includes(requiredPermission)) {
        throw forbidden('This action is not allowed')
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
