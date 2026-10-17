// The resolved createAuth() options the cutover depends on (spec 300, phase 3).
// Each behaviour is also proven over HTTP in the sibling suites; this file pins
// the settings themselves, so a removal names the setting that moved.
import type { PGlite } from '@electric-sql/pglite';
import { admin } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BLOCKED_AUTH_PATHS, createAuth, JWT_EXPIRATION, type Auth } from '../../src/index';
import { hashPassword, verifyPassword } from '../../src/password';
import {
  drizzleFor,
  migrate,
  setAuthEnv,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from '../helpers/auth-db';
import { BASE } from '../helpers/http';

let client: PGlite;
let auth: Auth;

beforeAll(async () => {
  setAuthEnv(BASE);
  client = await migrate();
  auth = createAuth(drizzleFor(client));
});

afterAll(async () => {
  await client?.close();
});

type PluginLike = { id: string; options?: Record<string, unknown> };
const plugin = (id: string) =>
  (auth.options.plugins as PluginLike[]).find((p) => p.id === id);

describe('createAuth() options', () => {
  it('maps the user model to auth.users with database-generated UUIDs', () => {
    expect(auth.options.user?.modelName).toBe('users');
    expect(auth.options.advanced?.database?.generateId).toBe('uuid');
  });

  it('declares the additional user fields, registered_via server-only', () => {
    const fields = auth.options.user?.additionalFields ?? {};
    expect(Object.keys(fields).sort()).toEqual(['first_name', 'last_name', 'registered_via']);
    expect(fields.registered_via?.input).toBe(false);
  });

  it('uses the dual-verify password functions and revokes sessions on reset', () => {
    const ep = auth.options.emailAndPassword;
    expect(ep?.password?.hash).toBe(hashPassword);
    expect(ep?.password?.verify).toBe(verifyPassword);
    expect(ep?.revokeSessionsOnPasswordReset).toBe(true);
    expect(ep?.requireEmailVerification).toBeUndefined();
  });

  it('keeps sessions 30 days, refreshed after 1 day', () => {
    expect(auth.options.session).toMatchObject({ expiresIn: 30 * 86_400, updateAge: 86_400 });
  });

  it('turns off change-email and delete-user', () => {
    expect(auth.options.user?.changeEmail?.enabled).toBe(false);
    expect(auth.options.user?.deleteUser?.enabled).toBe(false);
  });

  it('runs exactly expo, bearer, jwt, admin and the rate-limit retention rule', () => {
    expect((auth.options.plugins as PluginLike[]).map((p) => p.id).sort()).toEqual([
      'admin',
      'ansari-rate-limit-retention',
      'bearer',
      'expo',
      'jwt',
    ]);
  });

  it('disables every admin endpoint, change-email, update-user and change-password on the router', () => {
    const adminPaths = Object.values(admin().endpoints).map((e) => e.path);
    expect(adminPaths).toContain('/admin/impersonate-user');
    expect(adminPaths).toContain('/admin/set-role');
    expect(auth.options.disabledPaths).toEqual(
      expect.arrayContaining([...adminPaths, '/change-email', '/update-user', '/change-password'])
    );
    expect(BLOCKED_AUTH_PATHS).toEqual([...adminPaths, '/change-email', '/update-user', '/change-password']);
  });

  it('runs the origin check under NODE_ENV=test too (#266)', () => {
    expect(auth.options.advanced?.disableOriginCheck).toBe(false);
  });

  it('leaves bearer requireSignature unset', () => {
    expect(plugin('bearer')?.options?.requireSignature).toBeUndefined();
  });

  it('signs EdDSA JWTs with the configured iss, aud and a 15-minute lifetime', () => {
    const options = plugin('jwt')?.options as {
      jwks: { keyPairConfig: { alg: string } };
      jwt: { issuer: string; audience: string; expirationTime: string; definePayload: unknown };
    };
    expect(options.jwks.keyPairConfig.alg).toBe('EdDSA');
    expect(options.jwt).toMatchObject({
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      expirationTime: '15m',
    });
    expect(JWT_EXPIRATION).toBe('15m');
    expect(typeof options.jwt.definePayload).toBe('function');
  });
});
