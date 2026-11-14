# PR #372 re-review (iteration 6): the second external review's fixes

A second external review (security architect's reviewer, over 0798cfce..b9391cc7) returned REQUEST_CHANGES with eleven required fixes plus one coverage item. The fix is commit 1f936578, plus main's mcp dev PORT change in 41c787d6. Please confirm each item, and review the fix diff for regressions:
1. LEGACY_PREFIXES['ansari-mcp'] = [] (the MCP window is closed; the bare ansari_mcp_ prefix is refused).
2. The legacy flag is a parameter of the pure builders (acceptedKeyPrefixesFor, scanningPatternFor, legacyScanningPatternsFor). Both states are tested, and the runbook's post-window table is asserted against scanningPatternFor(s, false). WhatsApp tests use a labelled key by default.
3. Source-scan 6 covers RAILWAY_* names in apps/api, apps/auth, packages/auth and apps/mcp/src, with planted lines, near-misses and an exact allowlist (apps/mcp RAILWAY_GIT_COMMIT_SHA, #377). apps/mcp/src is an ansari-api#test turbo input, negative-tested by hash.
4. apps/api sentry.server.config.ts environment test.
5. Runbook accepted residual: the label binds key to auth, not api to auth.
6. The WhatsApp exchange's keyVerified() is after the owner and prefix gates; a spy test proves it doesn't fire for refused prefixes.
7. One environment knob: removed from the route options; createApp passes it.
8. service-keys.ts validates ENVIRONMENT before scriptRecorder/Sentry.init; no hardcoded 'development'.
9. The apps/api test key is ansari_mcp_staging_.
10. Docs: named after the LEGACY frontend's EXPO_PUBLIC_ENVIRONMENT.
11. leak-scan includes LEGACY_PREFIXES; boot-check uses delete for NEXT_PHASE.
12. Spawned NODE_ENV=production boot probes for both services (apps/auth and apps/api scripts/probes/environment-boot-probe.ts).
