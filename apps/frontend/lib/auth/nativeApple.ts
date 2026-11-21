import { generateNonce, sha256Hex } from "@/lib/auth/crypto";

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

/**
 * Initiates native Apple Sign-In on iOS using expo-apple-authentication.
 * Returns null if the user cancelled the dialog.
 */
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

  const AppleAuthentication = await import("expo-apple-authentication");

  const isAvailable = await AppleAuthentication.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Apple Sign-In is not available on this device.");
  }

  const nonce = generateNonce();
  const hashedNonce = await sha256Hex(nonce);

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      throw new Error("Apple Sign-In did not return an identity token.");
    }

    const firstName = credential.fullName?.givenName || undefined;
    const lastName = credential.fullName?.familyName || undefined;
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
      token: credential.identityToken,
      nonce,
      user,
    };
  } catch (error: unknown) {
    const code = (error as { code?: string | number })?.code;
    if (code === "ERR_REQUEST_CANCELED" || code === 1001 || code === "1001") {
      return null;
    }
    throw error;
  }
}
