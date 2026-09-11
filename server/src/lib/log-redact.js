export const logRedact = Object.freeze({
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers.set-cookie',
    '*.password',
    '*.passwordHash',
    '*.token',
    '*.refreshToken',
    '*.secret',
    '*.apiKey',
  ],
  censor: '[REDACTED]',
})
