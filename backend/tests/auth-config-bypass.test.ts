import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Phase 1+2 (config-validation bypass, item 6): the auth routes and middleware
// must obtain the JWT secret from validated `config.auth`, never a direct
// process.env read. This guard fails if any of them reintroduces the bypass.

const AUTH_FILES = [
  'src/app/api/v2/users/register/route.ts',
  'src/app/api/v2/users/login/route.ts',
  'src/app/api/v2/users/refresh_token/route.ts',
  'src/app/api/v2/request_password_reset/route.ts',
  'src/app/api/v2/reset_password/route.ts',
  'lib/auth/middleware.ts',
];

describe('auth config-validation bypass guard', () => {
  it.each(AUTH_FILES)('%s does not read process.env.JWT_SECRET directly', (relPath) => {
    const source = readFileSync(resolve(__dirname, '..', relPath), 'utf8');
    expect(source).not.toMatch(/process\.env\.JWT_SECRET/);
  });

  it.each(AUTH_FILES)('%s does not read token expiry from process.env directly', (relPath) => {
    const source = readFileSync(resolve(__dirname, '..', relPath), 'utf8');
    expect(source).not.toMatch(/process\.env\.(ACCESS|REFRESH)_TOKEN_EXPIRY_HOURS/);
  });
});
