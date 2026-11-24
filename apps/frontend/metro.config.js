const { getDefaultConfig } = require("expo/metro-config");

// Uniwind is installed but NOT wired into Metro. Its Metro wrapper
// (`withUniwindConfig` from "uniwind/metro") redirects every `react-native`
// import to its own re-export shim, and that shim (checked through uniwind
// 1.14.0, the latest on 2026-11-24) does not forward React Native 0.88's new
// exports such as `AssetRegistry`. expo-asset 58 imports `AssetRegistry` from
// "react-native", so with the wrapper every @expo/vector-icons font fails to
// load on native (#428). Nothing in the app uses Uniwind (the UI is
// StyleSheet-only); `gen:types` still generates its types. Re-wiring it is
// #264's call, once upstream forwards the new exports.
module.exports = getDefaultConfig(__dirname);
