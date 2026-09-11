import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

function serviceSources() {
  return readdirSync(here)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => ({ name: `services/${name}`, text: readFileSync(join(here, name), 'utf8') }))
}

function libSources() {
  return ['sequence.js', 'idempotency.js'].map((name) => ({
    name: `lib/${name}`,
    text: readFileSync(join(libDir, name), 'utf8'),
  }))
}

describe('service boundary', () => {
  it('imports no HTTP, queue, or socket modules', () => {
    const banned = /from\s+['"](express|bullmq|socket\.io|redis)['"]|require\(\s*['"](express|bullmq|socket\.io|redis)['"]/
    for (const { name, text } of [...serviceSources(), ...libSources()]) {
      expect(`${name}: ${banned.test(text)}`).toBe(`${name}: false`)
    }
  })

  it('never names request or response objects', () => {
    for (const { name, text } of serviceSources()) {
      expect(`${name}: ${/\breq\b|\bres\b/.test(text)}`).toBe(`${name}: false`)
    }
  })
})
