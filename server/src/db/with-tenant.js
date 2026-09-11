const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function withOrganization(database, organizationId, work, transactionOptions) {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new TypeError('withOrganization requires a valid organizationId')
  }

  if (typeof work !== 'function') {
    throw new TypeError('withOrganization requires a transaction callback')
  }

  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, TRUE)`
    return work(transaction)
  }, transactionOptions)
}
