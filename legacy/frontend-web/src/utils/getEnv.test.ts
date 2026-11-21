import { parseMaintenanceMode } from './getEnv'

describe('parseMaintenanceMode (same values as apps/api/lib/config.ts MAINTENANCE_MODE)', () => {
  it.each(['true', 'True', '1'])('%p is on', (value) => {
    expect(parseMaintenanceMode(value)).toBe(true)
  })

  it.each(['false', 'False', '0', '', 'TRUE', 'yes', 'on', ' true', 'true '])('%p is off', (value) => {
    expect(parseMaintenanceMode(value)).toBe(false)
  })

  it('unset is off', () => {
    expect(parseMaintenanceMode(undefined)).toBe(false)
  })
})

// getEnv('MAINTENANCE_MODE') itself is not exercised here: babel-preset-expo inlines every
// process.env.EXPO_PUBLIC_* at TRANSFORM time (in jest as in `expo export`), so setting the
// variable inside a test changes nothing. The wiring is proven by building the Docker image with
// and without --build-arg MAINTENANCE_MODE=true (see the PR).
