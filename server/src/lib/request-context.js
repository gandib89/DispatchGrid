import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

const requestStorage = new AsyncLocalStorage()

export function runWithRequestContext(context, callback) {
  return requestStorage.run(context, callback)
}

export function getRequestContext() {
  return requestStorage.getStore()
}

export function requestContextMiddleware(request, response, next) {
  const requestId = request.get('x-request-id') || crypto.randomUUID()
  request.id = requestId
  response.set('x-request-id', requestId)

  runWithRequestContext({ requestId }, next)
}
