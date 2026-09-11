export const config = Object.freeze({
  apiPrefix: '/api/v1',
  serviceName: 'dispatchgrid-api',
  jsonLimit: '1mb',
  apiRateLimit: {
    windowMs: 15 * 60 * 1000,
    limit: 1_000,
  },
})
