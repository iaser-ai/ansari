import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hashPassword, checkPasswordStrength } from '@/lib/auth/password';
import { generateToken } from '@/lib/auth/jwt';
import { findUserByEmail, createUser, storeToken } from '@/lib/db/users';
import { createErrorResponse } from '@/lib/auth/middleware';
import { subscribeToNewsletter } from '@/lib/newsletter';
import { getClientId } from '@/lib/attribution';

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  // Opt-in newsletter subscription. Defaults to false (opt-in) when omitted so
  // we never subscribe without explicit consent (CAN-SPAM / GDPR). The frontend
  // always sends this flag; guest sessions send false.
  register_to_mail_list: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parseResult = registerSchema.safeParse(body);

    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(i => i.message);
      return createErrorResponse(errors.join(', '), 422);
    }

    const { email, password, first_name, last_name, register_to_mail_list } = parseResult.data;

    // Check if user already exists
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return createErrorResponse('An account with this email already exists', 409);
    }

    // Check password strength
    const strength = checkPasswordStrength(password);
    if (!strength.valid) {
      return createErrorResponse(
        `Password is too weak. ${strength.suggestions.join(' ')}`,
        400
      );
    }

    // Create user. `registered_via` records which client the account signed up
    // through, from the X-Ansari-Client header (spec 56); NULL when absent.
    // `source` stays 'web' (unchanged) — it is a separate axis.
    const registeredVia = getClientId(request);
    const passwordHash = await hashPassword(password);
    const user = await createUser({
      email,
      passwordHash,
      firstName: first_name,
      lastName: last_name,
      source: 'web',
      registeredVia,
    });

    // Generate tokens
    const jwtSecret = process.env.JWT_SECRET!;
    const accessExpiryHours = parseInt(process.env.ACCESS_TOKEN_EXPIRY_HOURS || '2');
    const refreshExpiryHours = parseInt(process.env.REFRESH_TOKEN_EXPIRY_HOURS || '2160');

    const accessToken = generateToken(user.id, 'access', accessExpiryHours, jwtSecret);
    const refreshToken = generateToken(user.id, 'refresh', refreshExpiryHours, jwtSecret);

    // Store tokens
    await storeToken({
      userId: user.id,
      token: accessToken,
      tokenType: 'access',
      expiresAt: new Date(Date.now() + accessExpiryHours * 60 * 60 * 1000),
    });

    await storeToken({
      userId: user.id,
      token: refreshToken,
      tokenType: 'refresh',
      expiresAt: new Date(Date.now() + refreshExpiryHours * 60 * 60 * 1000),
    });

    // Fire-and-forget: subscribe to newsletter (non-blocking), but only when the
    // user explicitly opted in. Guests and opt-outs send false and are skipped.
    if (register_to_mail_list === true) {
      subscribeToNewsletter(
        email,
        first_name ?? null,
        last_name ?? null,
      ).then((result) => {
        if (!result.success) {
          console.error('Newsletter subscription failed:', result.error);
        }
      }).catch((err) => {
        console.error('Newsletter subscription unexpected error:', err instanceof Error ? err.message : err);
      });
    }

    // Return tokens in Ansari's format (frontend expects status: 'success')
    return NextResponse.json({
      status: 'success',
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
    });
  } catch (error) {
    console.error('Registration error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse(`Registration failed: ${message}`, 500);
  }
}
