/**
 * Elapsed-time text, conversation expiry and the stale-message check. Python tests only touch
 * `get_retention_time_seconds`; everything else is compared with what Python returned on a frozen clock
 * (`tests/fixtures/pythonOracle.ts`).
 */
import { describe, expect, it } from 'vitest';
import { calculateTimePassed, formatTimeDelta, getRetentionTimeSeconds, isMessageTooOld } from '../src/utils/time';
import {
  FIXED_NOW_UNIX,
  MESSAGE_AGE_CASES,
  TIME_DELTA_CASES,
  TIME_PASSED_CASES,
} from './fixtures/pythonOracle';

const NOW = new Date(FIXED_NOW_UNIX * 1000);
const THRESHOLD = 86400;

describe('formatTimeDelta', () => {
  it.each(TIME_DELTA_CASES)('%s seconds -> %s', (seconds, expected) => {
    expect(formatTimeDelta(seconds)).toBe(expected);
  });

  // JavaScript's toFixed(1) rounds an exact tie up; Python's format rounds it to the even digit. 0.25 is exact in binary.
  it('rounds ties to even like Python, not up like toFixed', () => {
    expect((0.25).toFixed(1)).toBe('0.3');
    expect(formatTimeDelta(0.25)).toBe('0.2 seconds');
    expect(formatTimeDelta(0.75)).toBe('0.8 seconds');
  });
});

describe('calculateTimePassed', () => {
  it.each(TIME_PASSED_CASES)('%s seconds ago -> %s, %s', (secondsAgo, passed, logging) => {
    const last = secondsAgo === null ? null : new Date(NOW.getTime() - secondsAgo * 1000);
    const result = calculateTimePassed(last, NOW);
    expect(result.seconds).toBe(passed === 'inf' ? Infinity : passed);
    expect(result.forLogging).toBe(logging);
  });

  it('reads the real clock when none is given', () => {
    const result = calculateTimePassed(new Date(Date.now() - 5000));
    expect(result.seconds).toBeGreaterThanOrEqual(5);
    expect(result.seconds).toBeLessThan(10);
  });
});

describe('getRetentionTimeSeconds', () => {
  it('turns hours into seconds', () => {
    expect(getRetentionTimeSeconds(3)).toBe(10800);
  });
});

describe('isMessageTooOld', () => {
  it.each(MESSAGE_AGE_CASES)('%s seconds old (unix %s) -> too old: %s', (_secondsAgo, unixTime, tooOld) => {
    expect(isMessageTooOld(unixTime, THRESHOLD, { now: NOW })).toBe(tooOld);
  });

  it('treats exactly the threshold as not too old, and one second more as too old', () => {
    expect(isMessageTooOld(FIXED_NOW_UNIX - THRESHOLD, THRESHOLD, { now: NOW })).toBe(false);
    expect(isMessageTooOld(FIXED_NOW_UNIX - THRESHOLD - 1, THRESHOLD, { now: NOW })).toBe(true);
  });

  it('uses the threshold it is given', () => {
    expect(isMessageTooOld(FIXED_NOW_UNIX - 100, 50, { now: NOW })).toBe(true);
    expect(isMessageTooOld(FIXED_NOW_UNIX - 100, 500, { now: NOW })).toBe(false);
  });

  // `if not message_unix_time` in Python is also true for 0
  it.each([null, undefined, 0])('cannot judge a missing timestamp (%s), so the message is answered', (value) => {
    expect(isMessageTooOld(value, THRESHOLD, { now: NOW })).toBe(false);
  });

  // Not from the oracle: CPython raises ValueError for these on Railway's Linux (caught: "not too old") but OSError on
  // Windows (not caught), so this machine cannot produce Python's answer. The TypeScript follows Linux.
  it.each([Number.NaN, Infinity, -Infinity, 253402300800, -62135596801])(
    'cannot judge an unusable timestamp (%s), so the message is answered',
    (value) => {
      expect(isMessageTooOld(value, THRESHOLD, { now: NOW })).toBe(false);
    },
  );

  it('logs why a timestamp was not judged', () => {
    const lines: string[] = [];
    const logger = { debug: (m: string) => lines.push(`debug: ${m}`), error: (m: string) => lines.push(`error: ${m}`) };
    isMessageTooOld(null, THRESHOLD, { now: NOW, logger });
    isMessageTooOld(Number.NaN, THRESHOLD, { now: NOW, logger });
    isMessageTooOld(FIXED_NOW_UNIX - 90, THRESHOLD, { now: NOW, logger });
    expect(lines).toEqual([
      'debug: No timestamp available, cannot determine message age',
      'error: Error parsing message timestamp: NaN is not a usable unix time',
      'debug: Message age: 1.5 minutes',
    ]);
  });
});
