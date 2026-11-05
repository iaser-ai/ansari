# Configuration for ansari-whatsapp
"""Configuration and settings for the WhatsApp service."""

from functools import lru_cache

from pydantic import HttpUrl, SecretStr, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


MOCK_FLAGS = ("MOCK_ANSARI_CLIENT", "MOCK_AUTH_CLIENT", "MOCK_META_API")


class WhatsAppSettings(BaseSettings):
    """
    Settings for the WhatsApp service.

    IMPORTANT NOTE: Check `.env.examples` file for an explanation of each setting.

    Notes regarding how Pydantic Settings works:

    Field value precedence in Pydantic Settings (highest to lowest priority):

    1. CLI arguments (if cli_parse_args is enabled).
    2. Arguments passed to the Settings initializer.
    3. Environment variables.
    4. Variables from a dotenv (.env) file.
    5. Variables from the secrets directory.
    6. Default field values in the WhatsAppSettings model.

    E.g., if you set the variable `META_API_VERSION` in .env file to `v22.xyz`,
    it will override the default value of `v22.0` defined in the WhatsAppSettings model.

    For more details, refer to the Pydantic documentation:
    [https://docs.pydantic.dev/latest/concepts/pydantic_settings/#field-value-priority].

    """

    ########## Pydantic Settings Config ##########

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    ########## apps/api and apps/auth settings ##########

    BACKEND_SERVER_URL: str = "http://localhost:3000"  # apps/api (base URL, no path)
    AUTH_SERVER_URL: str = "http://localhost:3100"  # apps/auth (base URL, no path)
    AUTH_WHATSAPP_API_KEY: SecretStr  # Authenticates this service to apps/auth's /whatsapp endpoint

    ########### Meta Business API settings ###########

    META_API_VERSION: str = "v22.0"
    META_BUSINESS_PHONE_NUMBER_ID: SecretStr
    META_ACCESS_TOKEN_FROM_SYS_USER: SecretStr
    META_WEBHOOK_VERIFY_TOKEN: SecretStr
    # Used for verifying webhook signatures (X-Hub-Signature-256)
    META_ANSARI_APP_SECRET: SecretStr  # No default: a public default would let anyone forge signed webhooks
    # NOTE: We add a default value here, since we never set this in staging/production/etc. environments
    #   I.e., this token is only used for local development with zrok (check .env.example for more details)
    META_WEBHOOK_ZROK_SHARE_TOKEN: SecretStr = SecretStr("your_token")

    @property
    def META_API_URL(self) -> str:
        """
        Returns the Meta Graph API URL for sending WhatsApp messages.

        Format: https://graph.facebook.com/{version}/{phone-number-id}/messages
        """
        return f"https://graph.facebook.com/{self.META_API_VERSION}/{self.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value()}/messages"

    ########### ansari-whatsapp's settings ##########

    DEPLOYMENT_TYPE: str = Field(
        ...,
        description="Deployment environment type",
        pattern="^(local|development|staging|production)$",
    )

    # Meta webhook response behavior
    ALWAYS_RETURN_OK_TO_META: bool = True

    # CORS settings
    # NOTE: We usually don't need to set this, as the add_extra_origins validator
    #   will automatically add BACKEND_SERVER_URL and other origins as needed.
    ORIGINS: str | list[str] = ""

    # Chat settings
    # This service's own maintenance switch, independent of apps/api's MAINTENANCE_MODE
    WA_MAINTENANCE_MODE: bool = False
    WHATSAPP_CHAT_RETENTION_HOURS: int = 3
    WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS: int = 86400  # 1 day

    # Logging settings
    LOGGING_LEVEL: str = ""  # Empty means DEBUG when DEPLOYMENT_TYPE=local, otherwise INFO
    LOG_TEST_FILES_ONLY: bool = False

    # Service Provider settings
    SENTRY_DSN: HttpUrl | None = None
    MOCK_ANSARI_CLIENT: bool = False
    MOCK_AUTH_CLIENT: bool = False
    # A real JWT the mock auth client returns for every BSUID, so a mocked sign-in can talk to a real apps/api
    MOCK_AUTH_TOKEN: SecretStr | None = None
    MOCK_META_API: bool = False

    ########### Validators ###########

    @model_validator(mode="after")
    def refuse_mocks_outside_local(self):
        """Mocks answer with canned data (and MOCK_AUTH_TOKEN puts every user in one account), so only local may use them."""
        if self.DEPLOYMENT_TYPE == "local":
            return self
        enabled = [name for name in MOCK_FLAGS if getattr(self, name)]
        if self.MOCK_AUTH_TOKEN and self.MOCK_AUTH_TOKEN.get_secret_value():
            enabled.append("MOCK_AUTH_TOKEN")
        if enabled:
            raise ValueError(f"{', '.join(enabled)} only allowed when DEPLOYMENT_TYPE=local (got {self.DEPLOYMENT_TYPE})")
        return self

    @model_validator(mode="after")
    def default_logging_level(self):
        if not self.LOGGING_LEVEL:
            self.LOGGING_LEVEL = "DEBUG" if self.DEPLOYMENT_TYPE == "local" else "INFO"
        return self

    @field_validator("ORIGINS", mode="before")
    def parse_origins(cls, v):
        """Parse ORIGINS from a comma-separated string or list."""
        if isinstance(v, str):
            origins = [origin.strip() for origin in v.strip('"').split(",")]
        elif isinstance(v, list):
            origins = v
        else:
            raise ValueError(
                f"Invalid ORIGINS format: {v}. Expected a comma-separated string or a list.",
            )
        return origins

    @field_validator("ORIGINS", mode="after")
    def add_extra_origins(cls, v, info):
        """Add extra origins based on environment settings.

        Adds:
        1. In local mode: adds localhost and zrok origins
        2. In all environments: adds GitHub Actions testserver origin and WhatsApp Web
        """
        origins = v.copy()

        # Add BACKEND_SERVER_URL as an origin if it's not already present
        backend_url = info.data.get("BACKEND_SERVER_URL")
        if backend_url and backend_url not in origins:
            origins.append(backend_url)

        # Add local-specific origins when in local mode
        if info.data.get("DEPLOYMENT_TYPE") == "local":
            # Add zrok origin (i.e., the webhook (callback url)) that Meta will send messages to)
            zrok_token = info.data.get("META_WEBHOOK_ZROK_SHARE_TOKEN")
            token_value = zrok_token.get_secret_value()
            # NOTE: We don't add "https://" as Meta sends request in "host" header, not "origin",
            #   and so, a value in "host" header means it won't contain the "https://" prefix
            #   However, even if you don't explicitly remove the "https://" part,
            #   apparently FastAPI will still correctly recognize the host
            webhook_origin = f"{token_value}.share.zrok.io"
            if webhook_origin not in origins:
                origins.append(webhook_origin)

        # Make sure CI/CD of GitHub Actions is allowed in all environments
        if "testserver" not in origins:
            origins.append("testserver")

        # Always allow WhatsApp Web origin
        if "https://web.whatsapp.com" not in origins:
            origins.append("https://web.whatsapp.com")

        return origins


@lru_cache
def get_settings() -> WhatsAppSettings:
    """Get the application settings."""
    return WhatsAppSettings()
