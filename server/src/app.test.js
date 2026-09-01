import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { app } from './app.js'

describe('GET /healthz', () => {
  it('reports process liveness without checking external services', async () => {
    const response = await request(app).get('/healthz')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })
})
