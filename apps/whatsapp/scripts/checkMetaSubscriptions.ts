/**
 * Operator tool: which Meta apps get this WhatsApp number's webhooks, and a way to change it.
 *
 * Python counterpart: `legacy/whatsapp/scripts/check_meta_subscriptions.py`. Same menu, same wording, same confirmations before
 * the two actions that change Meta's state.
 *
 * Run it with:   pnpm --filter ansari-whatsapp meta:subscriptions     (or `pnpm whatsapp meta:subscriptions` from the repo root)
 *
 * It reads `META_ACCESS_TOKEN_FROM_SYS_USER`, `META_MESSAGING_ACCOUNT_ID` and `META_API_VERSION` from `apps/whatsapp/.env` or the
 * environment, and asks for what is missing.
 *
 * A webhook only reaches the Meta apps that are SUBSCRIBED to the Messaging account (WABA) that owns the phone number. So when
 * "messages sent to the staging number do not arrive", the first question is whether the staging app is subscribed. Menu option 3
 * answers it and nothing here changes anything until you choose option 5 or 6 and type `yes`.
 *
 * Differences from Python:
 * - The access token is never printed. Python showed its first 20 and last 10 characters; now only that one is set and how long
 *   it is. The token is also taken out of any error text before it is shown.
 * - Before an unsubscribe the script matches the token's app to the subscribed apps by ID, not by name (two apps can share a name,
 *   and then Python would have gone ahead and removed the one the token belongs to without it being the one on screen).
 * - Every call to Meta has a 20 second limit (Python's had none).
 * - Real environment variables count even when no `.env` file exists (Python ignored them without a file).
 * - End of input (Ctrl+D, Ctrl+C, a closed pipe) quits cleanly instead of ending with a traceback.
 * - Python printed the times in "Token Details" in the machine's local time; so does this.
 */
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { pythonRepr } from '../src/utils/pythonRepr';
import {
  debugToken,
  getPhoneNumbers,
  getSubscribedApps,
  getWabaDetails,
  getWabaName,
  MetaCallError,
  planUnsubscribe,
  pythonShow,
  readSubscribedApps,
  readTokenApp,
  subscribeTokenApp,
  unsubscribeTokenApp,
  withoutToken,
  type FetchLike,
  type MetaContext,
} from './metaSubscriptions';
import { MISCELLANEOUS_INFO_LINES, PREREQUISITE_KNOWLEDGE_LINES } from './metaSubscriptionsText';
import { createTerminalIo, type Io } from './terminalIo';

const RULE = '='.repeat(60);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's `dict.get(key, default)` printed with `str()`: the default only when the key is missing, `None` for a null. */
function shown(source: Record<string, unknown>, key: string, missing: string): string {
  return Object.hasOwn(source, key) ? pythonShow(source[key]) : missing;
}

/** Python's `if value:` for what Meta sends: not null, false, 0, an empty string, list or object. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Python's `str(datetime.fromtimestamp(seconds))` in the machine's local time: `2026-11-11 05:00:00`. */
export function formatLocalTime(seconds: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new TypeError(`a timestamp must be a number, got ${pythonRepr(seconds)}`);
  const date = new Date(Math.floor(seconds) * 1000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Print what went wrong with a call to Meta (Python: `HTTP Error: ...` and `Response: ...`, or `Error: ...`). */
function printCallError(io: Io, error: unknown, accessToken: string, indent = ''): void {
  if (error instanceof MetaCallError && error.status !== undefined) {
    io.print(`\n${indent}HTTP Error: ${error.message}`);
    io.print(`${indent}   Response: ${error.detail ?? ''}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    io.print(`\n${indent}Error: ${withoutToken(message, accessToken)}`);
  }
}

function heading(io: Io, title: string): void {
  io.print(`\n${RULE}`);
  io.print(title);
  io.print(RULE);
}

// ---------------------------------------------------------------------------------------------------------------------
// The menu options
// ---------------------------------------------------------------------------------------------------------------------

export async function showWabaDetails(io: Io, context: MetaContext): Promise<void> {
  heading(io, 'FETCHING WABA DETAILS');
  try {
    const data = await getWabaDetails(context);
    const source = isRecord(data) ? data : {};
    io.print('\nWABA Details:');
    io.print(`   ID: ${shown(source, 'id', 'N/A')}`);
    io.print(`   Name: ${shown(source, 'name', 'N/A')}`);
    io.print(`   Timezone: ${shown(source, 'timezone_id', 'N/A')}`);
    io.print(`   Namespace: ${shown(source, 'message_template_namespace', 'N/A')}`);
    io.print(`   Review Status: ${shown(source, 'account_review_status', 'N/A')}`);
  } catch (error) {
    printCallError(io, error, context.accessToken);
  }
}

const TOKEN_HANDLED_KEYS = new Set([
  'app_id',
  'application',
  'type',
  'is_valid',
  'issued_at',
  'expires_at',
  'data_access_expires_at',
  'user_id',
  'profile_id',
  'scopes',
  'granular_scopes',
  'metadata',
  'error',
]);

export async function showTokenDetails(io: Io, context: MetaContext): Promise<void> {
  heading(io, 'VIEWING ACCESS TOKEN DETAILS');
  try {
    const result = await debugToken(context);
    if (isRecord(result) && Object.hasOwn(result, 'data')) {
      const data = isRecord(result.data) ? result.data : {};
      io.print('\nAccess Token Details:');
      io.print(`   App ID: ${shown(data, 'app_id', 'N/A')}`);
      io.print(`   Application: ${shown(data, 'application', 'N/A')}`);
      io.print(`   Type: ${shown(data, 'type', 'N/A')}`);
      io.print(`   Is Valid: ${shown(data, 'is_valid', 'N/A')}`);

      const issuedAt = data.issued_at;
      if (truthy(issuedAt)) io.print(`   Issued At: ${formatLocalTime(issuedAt as number)} (${pythonShow(issuedAt)})`);
      else io.print('   Issued At: N/A');

      const expiresAt = Object.hasOwn(data, 'expires_at') ? data.expires_at : 0;
      if (expiresAt === 0) io.print('   Expires At: Never (permanent token)');
      else io.print(`   Expires At: ${formatLocalTime(expiresAt as number)} (${pythonShow(expiresAt)})`);

      const accessExpires = data.data_access_expires_at;
      if (truthy(accessExpires)) io.print(`   Data Access Expires At: ${formatLocalTime(accessExpires as number)} (${pythonShow(accessExpires)})`);

      if (Object.hasOwn(data, 'user_id')) io.print(`   User ID: ${pythonShow(data.user_id)}`);
      if (Object.hasOwn(data, 'profile_id')) io.print(`   Profile ID: ${pythonShow(data.profile_id)}`);

      const scopes = Object.hasOwn(data, 'scopes') ? data.scopes : [];
      if (truthy(scopes) && Array.isArray(scopes)) {
        io.print(`   Permissions/Scopes (${scopes.length}):`);
        for (const scope of scopes) io.print(`      - ${pythonShow(scope)}`);
      } else {
        io.print('   Permissions/Scopes: None (may be an app token)');
      }

      const granular = Object.hasOwn(data, 'granular_scopes') ? data.granular_scopes : [];
      if (truthy(granular) && Array.isArray(granular)) {
        io.print(`   Granular Scopes (${granular.length}):`);
        for (const scope of granular) {
          if (isRecord(scope)) {
            io.print(`      - ${shown(scope, 'scope', 'N/A')}: ${Object.hasOwn(scope, 'target_ids') ? pythonShow(scope.target_ids) : '[]'}`);
          } else {
            io.print(`      - ${pythonShow(scope)}`);
          }
        }
      }

      const metadata = data.metadata;
      if (truthy(metadata)) {
        io.print('   Metadata:');
        if (isRecord(metadata)) {
          for (const [key, value] of Object.entries(metadata)) io.print(`      ${key}: ${pythonShow(value)}`);
        } else {
          io.print(`      ${pythonShow(metadata)}`);
        }
      }

      if (Object.hasOwn(data, 'error')) io.print(`   Error: ${pythonShow(data.error)}`);

      const additional = Object.entries(data).filter(([key]) => !TOKEN_HANDLED_KEYS.has(key));
      if (additional.length > 0) {
        io.print('   Additional Fields:');
        for (const [key, value] of additional) io.print(`      ${key}: ${pythonShow(value)}`);
      }
    }
  } catch (error) {
    printCallError(io, error, context.accessToken);
    if (error instanceof MetaCallError && error.status !== undefined) {
      io.print('\n   Note: debug_token may not work on development/test apps.');
      io.print('   Try checking your token at: https://developers.facebook.com/tools/debug/accesstoken/');
    }
  }
}

export async function showSubscribedApps(io: Io, context: MetaContext): Promise<void> {
  heading(io, 'CHECKING SUBSCRIBED APPS');
  try {
    const data = await getSubscribedApps(context);
    io.print('\nSuccessfully retrieved subscribed apps');
    if (isRecord(data) && Object.hasOwn(data, 'data') && Array.isArray(data.data)) {
      const apps = readSubscribedApps(data);
      if (apps.length === 0) {
        io.print('\nWARNING: No apps are subscribed to this WABA!');
        io.print("   This means webhooks won't be delivered to your app.");
      } else {
        const names = apps.flatMap((app) => (app.name === undefined ? [] : [app.name]));
        io.print(`\nFound ${apps.length} subscribed app(s) to the WABA: ${names.join(', ')}`);
        for (const app of apps) {
          io.print('\n   App Details:');
          for (const [key, value] of Object.entries(app.fields)) io.print(`      ${key}: ${pythonShow(value)}`);
        }
      }
    }
  } catch (error) {
    printCallError(io, error, context.accessToken);
  }
}

export async function showPhoneNumbers(io: Io, context: MetaContext): Promise<void> {
  heading(io, 'LISTING PHONE NUMBERS');
  try {
    const data = await getPhoneNumbers(context);
    io.print(`\nSuccessfully retrieved phone numbers for WABA: ${context.wabaId}`);
    if (isRecord(data) && Object.hasOwn(data, 'data') && Array.isArray(data.data)) {
      io.print(`\nFound ${data.data.length} phone number(s):`);
      for (const entry of data.data) {
        const phone = isRecord(entry) ? entry : {};
        io.print(`\n   Phone Number ID: ${shown(phone, 'id', 'None')}`);
        io.print(`   Display Name: ${shown(phone, 'display_phone_number', 'N/A')}`);
        io.print(`   Verified Name: ${shown(phone, 'verified_name', 'N/A')}`);
        io.print(`   Quality Rating: ${shown(phone, 'quality_rating', 'N/A')}`);
        io.print(`   Status: ${shown(phone, 'code_verification_status', 'N/A')}`);
      }
    } else {
      io.print('\nNo phone numbers found for this WABA');
    }
  } catch (error) {
    printCallError(io, error, context.accessToken);
  }
}

/** Python's `input(...).strip().lower() == "yes"`. */
async function confirmed(io: Io, prompt: string): Promise<boolean> {
  const answer = await io.ask(prompt);
  return (answer ?? '').trim().toLowerCase() === 'yes';
}

/** Subscribe the token's app. Returns whether Meta accepted it, so the caller can show the new list. */
export async function subscribe(io: Io, context: MetaContext): Promise<boolean> {
  heading(io, 'SUBSCRIBING WABA TO APP');
  io.print('\nThis will subscribe your WABA to the app associated with your access token.');
  io.print("   Webhooks from this WABA will be sent to this app's webhook URL.");
  if (!(await confirmed(io, '\n   Do you want to proceed? (yes/no): '))) {
    io.print('   Subscription cancelled.');
    return false;
  }
  try {
    const data = await subscribeTokenApp(context);
    io.print('\nSuccessfully subscribed WABA to app!');
    if (isRecord(data) && truthy(data.success)) io.print('   Status: Subscription active');
    return true;
  } catch (error) {
    printCallError(io, error, context.accessToken);
    return false;
  }
}

/**
 * Unsubscribe the token's app, in the six steps Python printed. Nothing is changed unless the token's app (matched by ID) is among
 * the subscribed apps AND the operator types `yes`. Returns whether Meta accepted the removal.
 */
export async function unsubscribe(io: Io, context: MetaContext): Promise<boolean> {
  heading(io, 'UNSUBSCRIBING WABA FROM APP');

  io.print("\n→ Step 1: Identifying your access token's app...");
  let tokenApp;
  try {
    tokenApp = readTokenApp(await debugToken(context));
  } catch (error) {
    io.print(`   ERROR: Failed to get token details: ${withoutToken(error instanceof Error ? error.message : String(error), context.accessToken)}`);
    return false;
  }
  if (tokenApp === undefined) {
    io.print('   ERROR: Unable to debug access token.');
    return false;
  }
  io.print(`   Your access token is associated with: ${tokenApp.name ?? 'Unknown'} (ID: ${tokenApp.id ?? 'Unknown'})`);

  io.print('\n→ Step 2: Getting WABA details...');
  let wabaName = `WABA ${context.wabaId}`;
  try {
    const answer = await getWabaName(context);
    if (isRecord(answer)) wabaName = Object.hasOwn(answer, 'name') ? pythonShow(answer.name) : wabaName;
    io.print(`   WABA Name: ${wabaName}`);
  } catch (error) {
    io.print(`   Warning: Could not get WABA name: ${withoutToken(error instanceof Error ? error.message : String(error), context.accessToken)}`);
    wabaName = `WABA ${context.wabaId}`;
  }

  io.print('\n→ Step 3: Checking currently subscribed apps...');
  let subscribed;
  try {
    subscribed = readSubscribedApps(await getSubscribedApps(context));
  } catch (error) {
    io.print(`   ERROR: Failed to get subscribed apps: ${withoutToken(error instanceof Error ? error.message : String(error), context.accessToken)}`);
    return false;
  }
  const plan = planUnsubscribe(tokenApp, subscribed);
  if (plan.kind === 'nothing_subscribed') {
    io.print('   No apps are currently subscribed to this WABA.');
    io.print('\n   Nothing to unsubscribe. Exiting.');
    return false;
  }
  const subscribedNames = subscribed.flatMap((app) => (app.name === undefined ? [] : [app.name]));
  io.print(`   Currently subscribed apps: ${subscribedNames.length > 0 ? subscribedNames.join(', ') : 'None found'}`);

  io.print('\n→ Step 4: Verifying subscription match...');
  if (plan.kind === 'token_app_not_subscribed') {
    io.print("\n   WARNING: Your access token's app is NOT in the subscribed list!");
    io.print('\n   Details:');
    io.print(`      * Your token is for: ${tokenApp.name ?? 'Unknown'} (ID: ${tokenApp.id ?? 'Unknown'})`);
    io.print(`      * WABA '${wabaName}' is subscribed to: ${subscribedNames.join(', ')}`);
    io.print('\n   Cannot proceed with unsubscription.');
    io.print('\n   → Solution: Change your access token to one bound to an app in the subscribed list.');
    io.print('      Apps you need a token for:');
    for (const name of subscribedNames) io.print(`         - ${name}`);
    return false;
  }

  const tokenAppName = tokenApp.name ?? 'Unknown';
  io.print(`\n   Match found: ${tokenAppName} app is subscribed to ${wabaName} WABA`);
  io.print('\n→ Step 5: Confirming unsubscription...');
  io.print(`\n   WARNING: This will unsubscribe '${tokenAppName}' from '${wabaName}'`);
  io.print(`      * Webhooks will STOP being sent to ${tokenAppName}'s webhook URL`);
  const otherNames = plan.others.flatMap((app) => (app.name === undefined ? [] : [app.name]));
  io.print(`      * Other subscribed apps will remain unaffected: ${otherNames.join(', ')}`);

  if (!(await confirmed(io, '\n   Are you sure you want to proceed? (yes/no): '))) {
    io.print('   Unsubscription cancelled.');
    return false;
  }

  io.print('\n→ Step 6: Performing unsubscription...');
  try {
    const data = await unsubscribeTokenApp(context);
    io.print(`\n   Successfully unsubscribed '${tokenAppName}' from '${wabaName}'!`);
    if (isRecord(data) && truthy(data.success)) io.print('   Status: Subscription removed');
    return true;
  } catch (error) {
    printCallError(io, error, context.accessToken, '   ');
    return false;
  }
}

export function showLines(io: Io, lines: readonly string[]): void {
  for (const line of lines) io.print(line);
}

export async function showPrerequisiteKnowledge(io: Io): Promise<void> {
  showLines(io, PREREQUISITE_KNOWLEDGE_LINES);
  await io.ask('\nPress Enter to return to menu...');
}

export async function showMiscellaneousInfo(io: Io): Promise<void> {
  showLines(io, MISCELLANEOUS_INFO_LINES);
  await io.ask('\nPress Enter to return to menu...');
}

// ---------------------------------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------------------------------

/** The WABA's and the token's app's names for the box above the menu. A failed call leaves `Unknown`, as in Python. */
export async function currentContext(context: MetaContext): Promise<{ wabaName: string; appName: string }> {
  let wabaName = 'Unknown';
  let appName = 'Unknown';
  try {
    const answer = await getWabaName(context);
    if (isRecord(answer)) wabaName = Object.hasOwn(answer, 'name') ? pythonShow(answer.name) : 'Unknown (probably invalid WABA ID)';
  } catch {
    // keep "Unknown"
  }
  try {
    const answer = await debugToken(context);
    if (isRecord(answer) && isRecord(answer.data)) {
      appName = Object.hasOwn(answer.data, 'application') ? pythonShow(answer.data.application) : 'Unknown (probably invalid token)';
    }
  } catch {
    // keep "Unknown"
  }
  return { wabaName, appName };
}

const CHOICES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Show the menu and return the chosen option. End of input is a choice to quit (`9`). */
export async function askMenuChoice(io: Io, context: MetaContext): Promise<string> {
  const { wabaName, appName } = await currentContext(context);
  io.print(`\n${RULE}`);
  io.print('CURRENT CONTEXT');
  io.print(RULE);
  io.print(`   WABA: ${wabaName}`);
  io.print(`   App: ${appName}`);
  io.print(RULE);
  io.print('AVAILABLE ACTIONS');
  io.print(RULE);
  io.print('\n0. 📚 Show prerequisite knowledge (understand the big picture)');
  io.print('1. View WABA details');
  io.print('2. View access token details for debugging');
  io.print('3. Check apps subscribed to the WABA');
  io.print('4. List phone numbers registered to the WABA');
  io.print('5. Subscribe WABA to app (enable webhooks)');
  io.print('6. Unsubscribe WABA from app (disable webhooks)');
  io.print('7. Run all checks (view everything)');
  io.print("8. Miscellaneous info (e.g., what is 'WA DevX Webhook Events 1P App' in option 3's list?)");
  io.print('9. Exit');

  for (;;) {
    const answer = await io.ask('\nEnter your choice (0-9): ');
    if (answer === null) {
      io.print('\n\nInterrupted by user. Exiting...');
      return '9';
    }
    const choice = answer.trim();
    if (CHOICES.includes(choice)) return choice;
    io.print('   Invalid choice. Please enter a number between 0 and 9.');
  }
}

export interface ScriptOptions {
  /** Usually `process.env` (after `.env` was loaded into it). */
  env: Record<string, string | undefined>;
  /** Whether a `.env` file was found; only changes what the script says when nothing is set. */
  envFileFound: boolean;
  /** Only tests pass it. */
  fetch?: FetchLike;
}

const goodbye = (io: Io) => {
  io.print(`\n${RULE}`);
  io.print('Done! Exiting...');
  io.print(RULE);
};

/** The whole script. Returns when the operator quits. */
export async function runScript(io: Io, options: ScriptOptions): Promise<void> {
  io.print(RULE);
  io.print('WhatsApp Business Account Subscription Manager');
  io.print(RULE);

  let accessToken = options.env.META_ACCESS_TOKEN_FROM_SYS_USER ?? '';
  let wabaId = options.env.META_MESSAGING_ACCOUNT_ID ?? '';
  const version = options.env.META_API_VERSION || 'v26.0';

  if (!options.envFileFound && accessToken === '' && wabaId === '') {
    io.print('\n   No .env file found in the current directory');
    io.print('   You can either:');
    io.print('      1. Create a .env file with META_ACCESS_TOKEN_FROM_SYS_USER and META_MESSAGING_ACCOUNT_ID');
    io.print("      2. Enter the values manually now (they won't be saved)");
    if (!(await confirmed(io, '\n   Enter values manually? (yes/no): '))) {
      io.print('\n   Please create a .env file and try again.');
      io.print('\n   Example .env file:');
      io.print('      META_ACCESS_TOKEN_FROM_SYS_USER=your_token_here');
      io.print('      META_MESSAGING_ACCOUNT_ID=your_id_here');
      return;
    }
  }

  if (accessToken === '') {
    io.print('\n→ Access Token Configuration');
    io.print('   You can find your token at:');
    io.print('      1. Go to business.facebook.com → Business Settings → System Users');
    io.print('      2. Select your System User → Generate New Token');
    io.print('      3. Select your app and required permissions');
    io.print('      4. Copy the generated token');
    accessToken = ((await io.askHidden('\n   Enter your META_ACCESS_TOKEN_FROM_SYS_USER (typing is hidden): ')) ?? '').trim();
    if (accessToken === '') {
      io.print('\n   ERROR: Access token is required. Exiting...');
      return;
    }
  }

  if (wabaId === '') {
    io.print('\n→ WABA ID Configuration');
    io.print('   Get it from https://developers.facebook.com/apps/ → your app → WhatsApp → API Setup');
    io.print("   Look for 'WhatsApp Business Account ID' (called 'Messaging account ID' in Meta's newer docs).");
    io.print("   Step-by-step: the last bullet of '7. USEFUL RESOURCES' in this script (menu option 0).");
    io.print('   Tip: save it as META_MESSAGING_ACCOUNT_ID in .env so you are not asked next time.');
    wabaId = ((await io.ask('\n   Enter your WABA ID: ')) ?? '').trim();
    if (wabaId === '') {
      io.print('\n   ERROR: WABA ID is required. Exiting...');
      return;
    }
  }

  const context: MetaContext = { accessToken, wabaId, version, ...(options.fetch ? { fetch: options.fetch } : {}) };

  io.print('\nConfiguration:');
  io.print(`   WABA ID: ${wabaId}`);
  io.print(`   Access Token: set (${[...accessToken].length} characters, never shown)`);

  for (;;) {
    const choice = await askMenuChoice(io, context);

    if (choice === '0') {
      await showPrerequisiteKnowledge(io);
    } else if (choice === '1') {
      await showWabaDetails(io, context);
    } else if (choice === '2') {
      await showTokenDetails(io, context);
    } else if (choice === '3') {
      await showSubscribedApps(io, context);
    } else if (choice === '4') {
      await showPhoneNumbers(io, context);
    } else if (choice === '5') {
      if (await subscribe(io, context)) {
        io.print('\n   → Verifying subscription...');
        await showSubscribedApps(io, context);
      }
    } else if (choice === '6') {
      if (await unsubscribe(io, context)) {
        io.print('\n   → Verifying unsubscription...');
        await showSubscribedApps(io, context);
      }
    } else if (choice === '7') {
      await showWabaDetails(io, context);
      await showTokenDetails(io, context);
      await showSubscribedApps(io, context);
      await showPhoneNumbers(io, context);
    } else if (choice === '8') {
      await showMiscellaneousInfo(io);
    } else if (choice === '9') {
      goodbye(io);
      return;
    }

    if (choice !== '8') {
      const next = await io.ask("\n   Press Enter to return to menu (or 'q' to quit): ");
      if (next === null || next.trim().toLowerCase() === 'q') {
        goodbye(io);
        return;
      }
    }
  }
}

// Run only when started directly (`tsx scripts/checkMetaSubscriptions.ts`), not when a test imports this file
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const loaded = loadDotenv({ quiet: true });
  const io = createTerminalIo();
  try {
    await runScript(io, { env: process.env, envFileFound: loaded.error === undefined });
  } finally {
    io.close();
  }
}
