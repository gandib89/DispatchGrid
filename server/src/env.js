import 'dotenv/config'
import { z } from 'zod'

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
)

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  GCS_PROJECT_ID: optionalString,
  GCS_UPLOAD_BUCKET: optionalString,
  SENTRY_DSN: optionalString,
  GEMINI_ENABLED: z.stringbool().default(false),
  GEMINI_API_KEY: optionalString,
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  const problems = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ')

  throw new Error(`Invalid environment configuration: ${problems}`)
}

if (result.data.GEMINI_ENABLED && !result.data.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is required when GEMINI_ENABLED=true')
}

export const env = Object.freeze(result.data)
