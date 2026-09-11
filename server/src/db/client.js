import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { env } from '../env.js'

export function createDatabaseClient(connectionString) {
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

// Application code always starts from the restricted role. Migration/seed/test code creates an
// explicit owner client with DATABASE_URL at its boundary rather than exporting one globally.
export const prisma = createDatabaseClient(env.APP_DATABASE_URL)
