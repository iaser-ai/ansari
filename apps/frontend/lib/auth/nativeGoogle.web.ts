import { generateNonce } from "@/lib/auth/crypto";

export interface SocialAuthResult {
  token: string;
  nonce: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            nonce?: string;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          prompt: (
            notification?: (notification: {
              isNotDisplayed: () => boolean;
              isSkippedMoment: () => boolean;
              isDismissedMoment: () => boolean;
              getDismissedReason: () => string;
            }) => void
          ) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: "standard" | "icon";
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with";
              shape?: "rectangular" | "pill" | "circle" | "square";
              logo_alignment?: "left" | "center";
              width?: number | string;
              locale?: string;
            }
          ) => void;
          cancel: () => void;
        };
      };
    };
  }
}

let googleScriptLoading: Promise<void> | null = null;

export function loadGoogleGsiScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptLoading) return googleScriptLoading;

  googleScriptLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", (e) => reject(e));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(script);
  });

  return googleScriptLoading;
}

/**
 * Initializes GIS and opens One Tap / prompt on web, returning the ID token or null on cancel.
 */
export async function startGoogleSignIn(): Promise<SocialAuthResult | null> {
  if (typeof window === "undefined") {
    throw new Error("Google Sign-In on web requires a browser environment.");
  }

  await loadGoogleGsiScript();

  if (!window.google?.accounts?.id) {
    throw new Error("Google Identity Services not available.");
  }

  const clientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";
  const nonce = generateNonce();

  return new Promise<SocialAuthResult | null>((resolve, reject) => {
    try {
      window.google!.accounts.id.initialize({
        client_id: clientId,
        nonce,
        callback: (response) => {
          if (response.credential) {
            resolve({
              token: response.credential,
              nonce,
            });
          } else {
            resolve(null);
          }
        },
      });

      window.google!.accounts.id.prompt((notification) => {
        if (notification.isDismissedMoment() || notification.isSkippedMoment()) {
          resolve(null);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
