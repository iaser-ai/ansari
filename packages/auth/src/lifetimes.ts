// Session and token lifetimes, in seconds: createAuth() configures better-auth
// with them, and the WhatsApp exchange (spec 329) writes sessions and signs
// tokens with the same numbers, so its sessions and tokens match better-auth's.

const DAY = 24 * 60 * 60;

/** The JWT access-token lifetime: the revocation window (spec 300, item 11). */
export const JWT_LIFETIME_SECONDS = 15 * 60;

/** A session's lifetime, slid forward at most once a day by any use. */
export const SESSION_LIFETIME_SECONDS = 30 * DAY;

/** How often a session's expiry is slid forward, at most. */
export const SESSION_UPDATE_AGE_SECONDS = DAY;
