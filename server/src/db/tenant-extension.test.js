import { describe, expect, it } from 'vitest'
import {
  discoverOrganizationScopedModels,
  OrganizationScopeError,
  scopeOrganizationArguments,
} from './tenant-extension.js'

const organizationId = '00000000-0000-4000-8000-000000000001'

describe('organization model discovery', () => {
  it('discovers a future scoped model from its organizationId field', () => {
    const fakeDmmf = {
      datamodel: {
        models: [
          { name: 'GlobalThing', fields: [{ name: 'id' }] },
          {
            name: 'FutureScopedModel',
            fields: [{ name: 'id' }, { name: 'organizationId' }],
          },
        ],
      },
    }

    expect([...discoverOrganizationScopedModels(fakeDmmf)]).toEqual(['FutureScopedModel'])
  })
})

describe('organization argument scoping', () => {
  it('adds organizationId to reads and writes', () => {
    expect(
      scopeOrganizationArguments(
        'Membership',
        'findMany',
        { where: { isAvailable: true } },
        organizationId,
      ),
    ).toEqual({
      where: { isAvailable: true, organizationId },
    })

    expect(
      scopeOrganizationArguments(
        'Membership',
        'create',
        { data: { userId: 'user-id' } },
        organizationId,
      ),
    ).toEqual({
      data: { userId: 'user-id', organizationId },
    })
  })

  it('scopes the Organization root by id', () => {
    expect(scopeOrganizationArguments('Organization', 'findMany', {}, organizationId)).toEqual({
      where: { id: organizationId },
    })
  })

  it('rejects an explicitly conflicting organization', () => {
    expect(() =>
      scopeOrganizationArguments(
        'Membership',
        'findMany',
        { where: { organizationId: '00000000-0000-4000-8000-000000000002' } },
        organizationId,
      ),
    ).toThrow(OrganizationScopeError)
  })
})
