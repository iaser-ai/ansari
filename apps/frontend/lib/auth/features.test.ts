import { afterEach, describe, expect, it } from "vitest";
import { isSocialAuthEnabled } from "./features";

describe("isSocialAuthEnabled", () => {
  const originalEnableSocialAuth = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
  const originalEnableSocialLogin = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN;
  const originalFeatureSocialAuth = process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;
  const originalSocialAuth = process.env.EXPO_PUBLIC_SOCIAL_AUTH;
  const originalMockAuth = process.env.EXPO_PUBLIC_MOCK_AUTH;

  afterEach(() => {
    if (originalEnableSocialAuth !== undefined) {
      process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = originalEnableSocialAuth;
    } else {
      delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    }

    if (originalEnableSocialLogin !== undefined) {
      process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = originalEnableSocialLogin;
    } else {
      delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN;
    }

    if (originalFeatureSocialAuth !== undefined) {
      process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH = originalFeatureSocialAuth;
    } else {
      delete process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;
    }

    if (originalSocialAuth !== undefined) {
      process.env.EXPO_PUBLIC_SOCIAL_AUTH = originalSocialAuth;
    } else {
      delete process.env.EXPO_PUBLIC_SOCIAL_AUTH;
    }

    if (originalMockAuth !== undefined) {
      process.env.EXPO_PUBLIC_MOCK_AUTH = originalMockAuth;
    } else {
      delete process.env.EXPO_PUBLIC_MOCK_AUTH;
    }
  });

  it("returns false by default when no flag is set", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN;
    delete process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;
    delete process.env.EXPO_PUBLIC_SOCIAL_AUTH;
    delete process.env.EXPO_PUBLIC_MOCK_AUTH;
    expect(isSocialAuthEnabled()).toBe(false);
  });

  it("returns true when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=true (with whitespace/case trimming)", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = " TRUE ";
    expect(isSocialAuthEnabled()).toBe(true);
  });

  it("returns true when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=1", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = "1";
    expect(isSocialAuthEnabled()).toBe(true);
  });

  it("returns true when EXPO_PUBLIC_MOCK_AUTH=true", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    process.env.EXPO_PUBLIC_MOCK_AUTH = "true";
    expect(isSocialAuthEnabled()).toBe(true);
  });

  it("returns false when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=false", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = "false";
    delete process.env.EXPO_PUBLIC_MOCK_AUTH;
    expect(isSocialAuthEnabled()).toBe(false);
  });

  it("recognizes alternative naming EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN=true", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = "true";
    expect(isSocialAuthEnabled()).toBe(true);
  });
});
