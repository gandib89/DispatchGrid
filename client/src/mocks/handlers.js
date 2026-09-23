import { HttpResponse, http } from 'msw'

export const mockUser = { id: 'user-1', email: 'dispatcher@example.com' }
export const mockCredentials = { email: mockUser.email, password: 'password123' }
export const mockAccessToken = 'mock-access-token'
export const mockOrganization = {
  id: 'org-1',
  name: 'DispatchGrid Demo',
  slug: 'dispatchgrid-demo',
  defaultConcurrentJobCap: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
export const mockMember = {
  id: 'membership-1',
  organizationId: mockOrganization.id,
  userId: mockUser.id,
  roleId: 'role-1',
  roleName: 'ADMIN',
  isAvailable: false,
  concurrentJobCap: 3,
  user: { id: mockUser.id, email: mockUser.email, displayName: 'Dispatcher' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function hasBearer(request) {
  return request.headers.get('authorization') === `Bearer ${mockAccessToken}`
}

export const jobsBoard = {
  jobs: [{ id: 'job-1', status: 'PENDING', title: 'Pump' }],
}

const REFRESH_COOKIE = 'refreshToken=mock-refresh-token; Path=/api/v1/auth; HttpOnly; SameSite=Strict'
const CLEARED_COOKIE = 'refreshToken=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0'

function fail(status, code, message) {
  return HttpResponse.json({ error: { code, message } }, { status })
}

function sessionResponse() {
  return HttpResponse.json(
    { user: mockUser, accessToken: mockAccessToken },
    { headers: { 'Set-Cookie': REFRESH_COOKIE } },
  )
}

export const handlers = [
  http.get('*/healthz', () => HttpResponse.json({ status: 'ok' })),

  http.get('*/api/v1/jobs', () => HttpResponse.json({ jobs: jobsBoard.jobs })),

  http.post('*/api/v1/auth/register', async ({ request }) => {
    const body = await request.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || password.length < 8) {
      return fail(400, 'validation_error', 'Invalid registration payload')
    }
    if (email.toLowerCase() === mockCredentials.email) {
      return fail(409, 'email_taken', 'Email already registered')
    }
    return HttpResponse.json(
      { user: { id: mockUser.id, email }, accessToken: mockAccessToken },
      { status: 201, headers: { 'Set-Cookie': REFRESH_COOKIE } },
    )
  }),

  http.post('*/api/v1/auth/login', async ({ request }) => {
    const body = await request.json().catch(() => null)
    if (body?.email !== mockCredentials.email || body?.password !== mockCredentials.password) {
      return fail(401, 'unauthorized', 'Invalid email or password')
    }
    return sessionResponse()
  }),

  http.post('*/api/v1/auth/refresh', ({ request }) => {
    const cookie = request.headers.get('cookie') ?? ''
    if (!cookie.includes('refreshToken=')) {
      return fail(401, 'unauthorized', 'Refresh token missing')
    }
    if (cookie.includes('refreshToken=invalid')) {
      return fail(401, 'unauthorized', 'Refresh token invalid, reused, or expired')
    }
    return sessionResponse()
  }),

  http.post('*/api/v1/auth/logout', () =>
    new HttpResponse(null, { status: 204, headers: { 'Set-Cookie': CLEARED_COOKIE } }),
  ),

  http.get('*/api/v1/auth/me', ({ request }) => {
    if (!hasBearer(request)) {
      return fail(401, 'unauthorized', 'Invalid or expired access token')
    }
    return HttpResponse.json({ id: mockUser.id, email: mockUser.email })
  }),

  http.get('*/api/v1/organizations', ({ request }) => {
    if (!hasBearer(request)) {
      return fail(401, 'unauthorized', 'Invalid or expired access token')
    }
    return HttpResponse.json({ organizations: [mockOrganization] })
  }),

  http.get('*/api/v1/organizations/:orgId/members', ({ request }) => {
    if (!hasBearer(request)) {
      return fail(401, 'unauthorized', 'Invalid or expired access token')
    }
    return HttpResponse.json({ members: [mockMember] })
  }),
]
