/**
 * Choose, for each outside service, the real client or its stand-in.
 *
 * Python counterparts: `service_provider.py` and `meta_service_provider.py`, which kept a module-level singleton for each and a
 * `reset_*` function for tests. Here the choice is made once, at start-up, and the result is passed to whoever needs it, so
 * there is nothing global to reset.
 *
 * The `MOCK_*` switches are refused outside `ENVIRONMENT=development` by the configuration itself (`config.ts`), so a stand-in
 * can never be chosen on a deployed service.
 */
import type { Env } from '../config';
import type { ErrorReporter } from '../errorReporter';
import type { Logger } from '../logger';
import { AnsariClientMock, AnsariClientReal, type AnsariClient } from './ansariClient';
import { AuthClientMock, AuthClientReal, type AuthClient } from './authClient';
import { MetaApiServiceMock, MetaApiServiceReal, type MetaApiService } from './metaApiService';

export type ServicesConfig = Pick<
  Env,
  | 'MOCK_ANSARI_CLIENT'
  | 'MOCK_AUTH_CLIENT'
  | 'MOCK_AUTH_TOKEN'
  | 'MOCK_META_API'
  | 'BACKEND_SERVER_URL'
  | 'AUTH_SERVER_URL'
  | 'AUTH_WHATSAPP_API_KEY'
  | 'META_API_URL'
  | 'META_ACCESS_TOKEN_FROM_SYS_USER'
  | 'ENVIRONMENT'
>;

export interface Services {
  ansariClient: AnsariClient;
  authClient: AuthClient;
  metaApi: MetaApiService;
}

export function createServices(config: ServicesConfig, logger: Logger, reportError: ErrorReporter): Services {
  const ansariClient = config.MOCK_ANSARI_CLIENT
    ? new AnsariClientMock({ logger })
    : new AnsariClientReal({ baseUrl: config.BACKEND_SERVER_URL, logger });

  const authClient = config.MOCK_AUTH_CLIENT
    ? new AuthClientMock(config.MOCK_AUTH_TOKEN ? { fixedToken: config.MOCK_AUTH_TOKEN } : {})
    : new AuthClientReal({ baseUrl: config.AUTH_SERVER_URL, apiKey: config.AUTH_WHATSAPP_API_KEY, logger });

  const metaApi = config.MOCK_META_API
    ? new MetaApiServiceMock({ logger })
    : new MetaApiServiceReal({
        apiUrl: config.META_API_URL,
        accessToken: config.META_ACCESS_TOKEN_FROM_SYS_USER,
        environment: config.ENVIRONMENT,
        logger,
        reportError,
      });

  return { ansariClient, authClient, metaApi };
}
