import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { setAccessToken, setOrganizationId } from '../lib/api-client.js'

// One global reset: RTL unmount plus the api client's module-level session
// state, so no test inherits an access token or organization hint.
afterEach(() => {
  cleanup()
  setAccessToken(null)
  setOrganizationId(null)
})
