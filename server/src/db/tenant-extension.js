import { Prisma } from '@prisma/client'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const WHERE_OPERATIONS = new Set([
  'aggregate',
  'count',
  'delete',
  'deleteMany',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
])

export class OrganizationScopeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OrganizationScopeError'
  }
}

export function discoverOrganizationScopedModels(dmmf = Prisma.dmmf) {
  return new Set(
    dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === 'organizationId'))
      .map((model) => model.name),
  )
}

const organizationScopedModels = discoverOrganizationScopedModels()

export function getOrganizationScopedModelNames() {
  return new Set(organizationScopedModels)
}

function assertOrganizationId(organizationId) {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new OrganizationScopeError('A valid organizationId is required for scoped access')
  }
}

function addScope(value, field, organizationId) {
  if (value?.[field] !== undefined && value[field] !== organizationId) {
    throw new OrganizationScopeError(`Cross-organization ${field} is not allowed`)
  }

  return { ...(value || {}), [field]: organizationId }
}

function scopeData(data, field, organizationId) {
  if (Array.isArray(data)) {
    return data.map((item) => addScope(item, field, organizationId))
  }

  return addScope(data, field, organizationId)
}

export function scopeOrganizationArguments(model, operation, args, organizationId) {
  assertOrganizationId(organizationId)

  const field = model === 'Organization' ? 'id' : 'organizationId'
  const scoped = { ...(args || {}) }

  if (WHERE_OPERATIONS.has(operation)) {
    scoped.where = addScope(scoped.where, field, organizationId)
  }

  if (operation === 'create' || operation === 'createMany' || operation === 'createManyAndReturn') {
    scoped.data = scopeData(scoped.data, field, organizationId)
  }

  if (operation === 'upsert') {
    scoped.where = addScope(scoped.where, field, organizationId)
    scoped.create = scopeData(scoped.create, field, organizationId)
    scoped.update = scopeData(scoped.update, field, organizationId)
  }

  if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    scoped.data = scopeData(scoped.data, field, organizationId)
  }

  return scoped
}

export function organizationExtension(organizationId) {
  assertOrganizationId(organizationId)

  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'organization-isolation',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const isOrganizationRoot = model === 'Organization'
            if (!isOrganizationRoot && !organizationScopedModels.has(model)) {
              return query(args)
            }

            const scopedArgs = scopeOrganizationArguments(model, operation, args, organizationId)
            const [, result] = await client.$transaction([
              client.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, TRUE)`,
              query(scopedArgs),
            ])

            return result
          },
        },
      },
    }),
  )
}

export function forOrganization(client, organizationId) {
  return client.$extends(organizationExtension(organizationId))
}
