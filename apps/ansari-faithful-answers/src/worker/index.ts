// Cloudflare Workers hosting: the same fetch application as Node, with bindings, console logging and the
// built card bundled at build time. Nothing here touches a filesystem or a process object.
import builtView from '../../dist/view.html';
import {createAnsariHttpCompleter} from '../server/ansari-client.js';
import {createFetchApp, type FetchApp} from '../server/fetch-app.js';
import {settingsFromEnv, type RuntimeEnv} from '../server/runtime-config.js';

// Bindings are fixed for the life of a deployed version, so the application is prepared once per isolate.
let app: FetchApp | undefined;

function applicationFor(env: RuntimeEnv): FetchApp {
  if (app) return app;
  const settings = settingsFromEnv(env);
  app = createFetchApp({
    completer: createAnsariHttpCompleter(settings.ansari),
    html: builtView,
    release: settings.release,
    allowedHosts: settings.allowedHosts,
    allowedOrigins: settings.allowedOrigins,
    enableJsonResponse: settings.enableJsonResponse,
    logger: record => console.log(JSON.stringify(record)),
  });
  return app;
}

export default {
  fetch: (request: Request, env: RuntimeEnv): Response | Promise<Response> => applicationFor(env).fetch(request),
};
