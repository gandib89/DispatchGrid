export async function withTransaction(database, work) {
  const afterCommitCallbacks = []

  const result = await database.$transaction((transaction) =>
    work(transaction, {
      afterCommit(callback) {
        if (typeof callback !== 'function') {
          throw new TypeError('afterCommit requires a function')
        }

        afterCommitCallbacks.push(callback)
      },
    }),
  )

  for (const callback of afterCommitCallbacks) {
    await callback()
  }

  return result
}
