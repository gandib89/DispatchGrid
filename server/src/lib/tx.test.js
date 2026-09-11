import { describe, expect, it, vi } from 'vitest'
import { withTransaction } from './tx.js'

describe('withTransaction', () => {
  it('runs registered side effects only after the transaction commits', async () => {
    const order = []
    const afterCommit = vi.fn(() => order.push('after-commit'))
    const database = {
      $transaction: async (work) => {
        order.push('transaction-start')
        const result = await work({ name: 'transaction-client' })
        order.push('transaction-commit')
        return result
      },
    }

    const result = await withTransaction(database, async (transaction, hooks) => {
      order.push(transaction.name)
      hooks.afterCommit(afterCommit)
      return 'result'
    })

    expect(result).toBe('result')
    expect(afterCommit).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'transaction-start',
      'transaction-client',
      'transaction-commit',
      'after-commit',
    ])
  })

  it('does not run side effects when the transaction fails', async () => {
    const afterCommit = vi.fn()
    const database = {
      $transaction: (work) => work({}),
    }

    await expect(
      withTransaction(database, async (_transaction, hooks) => {
        hooks.afterCommit(afterCommit)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    expect(afterCommit).not.toHaveBeenCalled()
  })
})
