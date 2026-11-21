import { generateNonce } from "@/lib/auth/crypto";

export interface SocialAuthResult {
  token: string;
  nonce: string;
  user?: {
    name?: {
      firstName?: string;
      lastName?: string;
    };
  };
}

declare global {
  interface Window {
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
          nonce: string;
        }) => void;
        signIn: () => Promise<{
          authorization: {
            id_token: string;
            code?: string;
          };
          user?: {
            name?: {
              firstName?: string;
              lastName?: string;
            };
            email?: string;
          };
        }>;
      };
    };
  }
}

let appleScriptLoading: Promise<void> | null = null;

function loadAppleScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.AppleID?.auth) return Promise.resolve();
  if (appleScriptLoading) return appleScriptLoading;

  appleScriptLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="appleauth"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", (e) => reject(e));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/auth.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Apple Sign-In SDK"));
    document.head.appendChild(script);
  });

  return appleScriptLoading;
}

export async function startAppleSignIn(): Promise<SocialAuthResult | null> {
  const mockMode = process.env.EXPO_PUBLIC_MOCK_AUTH;
  if (mockMode === "cancel") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return null;
  }
  if (
    mockMode === "true" ||
    mockMode === "1" ||
    mockMode === "error" ||
    mockMode === "network-error"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      token: "mock-apple-id-token",
      nonce: generateNonce(),
      user: {
        name: {
          firstName: "Apple",
          lastName: "Tester",
        },
      },
    };
  }

  if (typeof window === "undefined") {
    throw new Error("Apple Sign-In on web requires a browser environment.");
  }

  await loadAppleScript();

  if (!window.AppleID?.auth) {
    throw new Error("Apple Sign-In SDK not initialized.");
  }

  const clientId = process.env.EXPO_PUBLIC_APPLE_CLIENT_ID || "ai.askansari.web";
  const nonce = generateNonce();

  window.AppleID.auth.init({
    clientId,
    scope: "name email",
    redirectURI: window.location.origin,
    usePopup: true,
    nonce,
  });

  try {
    const response = await window.AppleID.auth.signIn();
    if (!response.authorization?.id_token) {
      throw new Error("Apple Sign-In did not return an identity token.");
    }

    const firstName = response.user?.name?.firstName || undefined;
    const lastName = response.user?.name?.lastName || undefined;
    const user =
      firstName || lastName
        ? {
            name: {
              firstName,
              lastName,
            },
          }
        : undefined;

    return {
      token: response.authorization.id_token,
      nonce,
      user,
    };
  } catch (error: unknown) {
    const errStr = String(error).toLowerCase();
    const errObj = error as { error?: string };
    if (
      errObj?.error === "popup_closed_by_user" ||
      errStr.includes("popup_closed") ||
      errStr.includes("cancel")
    ) {
      return null;
    }
    throw error;
  }
}
