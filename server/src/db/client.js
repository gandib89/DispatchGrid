import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { env } from '../env.js'

const adapter = new PrismaPg({ connectionString: env.APP_DATABASE_URL })

export const prisma = new PrismaClient({ adapter })
