// The key-material scan (#314): a raw key, or any 16-character window of its
// random part, in some text. The public prefix (`ansari_mcp_<environment>_`, stored in
// `apikey.prefix` and published as the secret-scanning pattern) is exempt, so
// the scan never keys on it. Negative-tested in service-verify.test.ts against
// a known-bad line and the bare prefix (a verification pattern is code).
import { ENVIRONMENTS, serviceUsers } from '@ansari/auth';

export const LEAK_WINDOW = 16;

// Longest first, so `ansari_mcp_staging_` is stripped whole, never just `ansari_mcp_`.
const PREFIXES = (Object.keys(serviceUsers.SERVICES) as serviceUsers.ServiceName[])
  .flatMap((name) => [
    serviceUsers.SERVICES[name].prefix,
    ...serviceUsers.LEGACY_PREFIXES[name],
    ...ENVIRONMENTS.map((env) => serviceUsers.keyPrefix(name, env)),
  ])
  .sort((a, b) => b.length - a.length);

/** Every 16-character window of the key's random part (the part after its prefix, environment included). */
export function keyWindows(key: string): string[] {
  const prefix = PREFIXES.find((p) => key.startsWith(p)) ?? '';
  const random = key.slice(prefix.length);
  if (random.length < LEAK_WINDOW) throw new Error('not a key: its random part is shorter than the scan window');
  return Array.from({ length: random.length - LEAK_WINDOW + 1 }, (_, i) => random.slice(i, i + LEAK_WINDOW));
}

/** The windows of `keys` that `text` contains; empty when it carries no key material. */
export function leakedWindows(text: string, keys: Iterable<string>): string[] {
  const found: string[] = [];
  for (const key of keys) for (const window of keyWindows(key)) if (text.includes(window)) found.push(window);
  return found;
}
