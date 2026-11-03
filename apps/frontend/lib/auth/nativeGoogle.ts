import { generateNonce } from "@/lib/auth/crypto";

export interface SocialAuthResult {
  token: string;
  nonce: string;
}

/**
 * Initiates native Google Sign-In on Android (Credential Manager) and iOS (Google SDK)
 * using react-native-nitro-google-signin.
 * Returns null if the user cancelled the dialog.
 */
export async function startGoogleSignIn(): Promise<SocialAuthResult | null> {
  const { GoogleOneTapSignIn, isCancelledResponse, isSuccessResponse, statusCodes } =
    await import("react-native-nitro-google-signin");

  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || null;
  const nonce = generateNonce();

  GoogleOneTapSignIn.configure({
    webClientId,
    iosClientId,
    nonce,
  });

  try {
    const response = await GoogleOneTapSignIn.presentExplicitSignIn();

    if (isCancelledResponse(response)) {
      return null;
    }

    if (isSuccessResponse(response)) {
      return {
        token: response.data.idToken,
        nonce,
      };
    }

    return null;
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    if (code === statusCodes.SIGN_IN_CANCELLED || code === "SIGN_IN_CANCELLED") {
      return null;
    }
    throw error;
  }
}
