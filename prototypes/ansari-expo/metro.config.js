const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// The Replit-sourced pages import the vendored API client's runtime under
// its original package name rather than the `@/vendor/...` path this repo's
// own code uses (see lib/api/, lib/auth/). Metro would otherwise try to
// resolve it as a real node_modules package, so it's pointed at the vendored
// copy explicitly (mirrors the tsconfig.json `paths` entry, which is what
// TypeScript itself reads).
config.resolver.extraNodeModules = {
  '@workspace/api-client-react': path.resolve(__dirname, 'vendor/api-client-react'),
};

module.exports = config;
