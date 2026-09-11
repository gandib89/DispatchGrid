// Gapless per-organization reference allocation. The counter row is locked and
// incremented inside the caller's transaction, so a rollback consumes neither
// the number nor the business row written with it. Callers must set the
// organization database context before invoking (row-level security), and must
// never call this outside a transaction.

export async function nextCounterValue(tx, organizationId, name) {
  const rows = await tx.$queryRaw`
    SELECT value FROM "Counter"
    WHERE "organizationId" = ${organizationId}::uuid AND name = ${name}
    FOR UPDATE
  `
  if (rows.length === 0) {
    throw new Error(`Counter ${name} does not exist for this organization`)
  }

  const next = BigInt(rows[0].value) + 1n
  await tx.$executeRaw`
    UPDATE "Counter" SET value = ${next}
    WHERE "organizationId" = ${organizationId}::uuid AND name = ${name}
  `
  return next
}

export function formatJobReference(date, value) {
  const year = date instanceof Date ? date.getUTCFullYear() : new Date(date).getUTCFullYear()
  return `JOB-${year}-${String(value).padStart(6, '0')}`
}
