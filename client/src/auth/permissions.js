// Presentation-only permission helper (UX): hide controls the caller's
// roleName cannot use. Keys off roleName because no endpoint returns the
// caller's permission codes. Server authorize() middleware remains the
// authority — this map is never a security boundary.
const ALL_PERMISSION_CODES = [
  'job.view',
  'job.create',
  'job.update',
  'job.assign',
  'job.respond',
  'job.cancel',
  'org.invite',
  'org.manage',
  'sla.manage',
  'report.view',
]

export const ROLE_PERMISSIONS = Object.freeze({
  ADMIN: Object.freeze([...ALL_PERMISSION_CODES]),
  DISPATCHER: Object.freeze([
    'job.view',
    'job.create',
    'job.update',
    'job.assign',
    'job.cancel',
    'report.view',
  ]),
  AGENT: Object.freeze(['job.view', 'job.respond']),
})

export function can(roleName, code) {
  return ROLE_PERMISSIONS[roleName]?.includes(code) ?? false
}
