# Welcome to your HeroUI Native app 👋

This is an [Expo](https://expo.dev) project preconfigured with
[HeroUI Native](https://heroui.com/docs/native), [Uniwind](https://docs.uniwind.dev)
(Tailwind CSS for React Native), and [Expo Router](https://docs.expo.dev/router/introduction).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## What's preconfigured

- **HeroUI Native** (`heroui-native`) wrapped in `HeroUINativeProvider` and `GestureHandlerRootView` in `src/app/_layout.tsx`
- **Uniwind** + **Tailwind CSS** wired through `metro.config.js` and `src/global.css`
- All HeroUI Native mandatory peer dependencies: `react-native-reanimated`, `react-native-gesture-handler`, `react-native-worklets`, `react-native-safe-area-context`, `react-native-svg`, `react-native-screens`
- `@gorhom/bottom-sheet` for bottom-sheet UIs
- TypeScript with `strict: true` and `@/*` path alias to `./src/*`
- React Compiler enabled

## Learn more

- [HeroUI Native components](https://heroui.com/docs/native) — full component reference
- [Expo documentation](https://docs.expo.dev/) — Expo fundamentals and guides
- [Uniwind documentation](https://docs.uniwind.dev) — Tailwind for React Native
- [Expo Router](https://docs.expo.dev/router/introduction) — file-based routing
