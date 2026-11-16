import { afterEach, describe, expect, it } from "vitest";
import { isSocialAuthEnabled } from "./features";

describe("isSocialAuthEnabled", () => {
  const originalEnableSocialAuth = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
  const originalEnableSocialLogin = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN;
  const originalFeatureSocialAuth = process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;

  afterEach(() => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = originalEnableSocialAuth;
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = originalEnableSocialLogin;
    process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH = originalFeatureSocialAuth;
  });

  it("returns false by default when no flag is set", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN;
    delete process.env.EXPO_PUBLIC_FEATURE_SOCIAL_AUTH;
    expect(isSocialAuthEnabled()).toBe(false);
  });

  it("returns true when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=true", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = "true";
    expect(isSocialAuthEnabled()).toBe(true);
  });

  it("returns true when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=1", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = "1";
    expect(isSocialAuthEnabled()).toBe(true);
  });

  it("returns false when EXPO_PUBLIC_ENABLE_SOCIAL_AUTH=false", () => {
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH = "false";
    expect(isSocialAuthEnabled()).toBe(false);
  });

  it("recognizes alternative naming EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN=true", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_AUTH;
    process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = "true";
    expect(isSocialAuthEnabled()).toBe(true);
  });
});
