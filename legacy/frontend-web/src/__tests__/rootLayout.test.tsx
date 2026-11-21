import React from 'react'
import { act, create, ReactTestRenderer } from 'react-test-renderer'
import { Text } from 'react-native'
// jest.mock calls below are hoisted above this import. The flag is read on every render, so one
// import serves every case.
import RootLayout from '@/app/_layout'

// The root layout's runtime dependencies that are not under test, replaced with inert stand-ins.
jest.mock('@/global.css', () => ({}))
jest.mock('@sentry/react-native', () => ({
  reactNavigationIntegration: () => ({ registerNavigationContainer: jest.fn() }),
  browserReplayIntegration: jest.fn(),
  mobileReplayIntegration: jest.fn(),
  init: jest.fn(),
  wrap: (component: unknown) => component,
}))
jest.mock('@sentry/core', () => ({ captureConsoleIntegration: jest.fn() }))
// eslint-disable-next-line camelcase
jest.mock('@expo-google-fonts/inter', () => ({ useFonts: () => [true], Inter_400Regular: 'Inter' }))
jest.mock('react-native-keyboard-controller', () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}))
// jest-expo runs the native variants (RootContainer.tsx wraps GestureHandlerRootView); the .web
// variants are exercised by the Docker build in the PR.
jest.mock('react-native-gesture-handler', () => {
  const { View } = jest.requireActual('react-native')
  return { GestureHandlerRootView: View }
})
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}))
jest.mock('react-redux', () => ({ Provider: ({ children }: { children: React.ReactNode }) => children }))
jest.mock('react-i18next', () => ({ I18nextProvider: ({ children }: { children: React.ReactNode }) => children }))
jest.mock('@/i18n', () => ({ i18n: { language: 'en', dir: () => 'ltr' } }))
jest.mock('@/components', () => {
  const { Text: MockText } = jest.requireActual('react-native')
  return { LoadingScreen: () => <MockText testID='loading-screen'>loading</MockText> }
})
jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual('react-native')
  return {
    Stack: () => <MockText testID='app-stack'>app</MockText>,
    useNavigationContainerRef: () => ({ current: null }),
  }
})
const mockInitStore = jest.fn()
// The app's own requests go through expo/fetch (src/services/ApiService.ts); spy on it as well as global fetch.
const mockExpoFetch = jest.fn()
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)
jest.mock('@/store', () => ({ initStore: () => mockInitStore() }))

// babel-preset-expo inlines process.env.EXPO_PUBLIC_* at transform time, so a test cannot set the
// variable at runtime; the flag is driven through getEnv instead, parsed by the real parser.
let mockMaintenanceValue: string | undefined
jest.mock('@/utils/getEnv', () => {
  const actual = jest.requireActual('@/utils/getEnv')
  return {
    __esModule: true,
    parseMaintenanceMode: actual.parseMaintenanceMode,
    default: (key: string) =>
      key === 'MAINTENANCE_MODE' ? actual.parseMaintenanceMode(mockMaintenanceValue) : actual.default(key),
  }
})

const MAINTENANCE_COPY = [
  'Ansari is currently under maintenance.',
  'We are working hard to bring you the best experience possible.',
  'Thank you for your patience!',
]

const renderLayout = async (value: string | undefined) => {
  mockMaintenanceValue = value
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(<RootLayout />)
  })
  return tree
}

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''))

const byTestId = (tree: ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => node.props.testID === testID && typeof node.type === 'string')

describe('RootLayout maintenance mode', () => {
  const fetchSpy = jest.fn()

  beforeEach(() => {
    mockInitStore.mockReset()
    mockInitStore.mockResolvedValue({ getState: () => ({}), subscribe: () => () => undefined, dispatch: jest.fn() })
    fetchSpy.mockReset()
    mockExpoFetch.mockReset()
    global.fetch = fetchSpy as unknown as typeof fetch
  })

  it.each(['true', 'True', '1'])(
    'MAINTENANCE_MODE=%p renders the maintenance screen in place of the app',
    async (value) => {
      const tree = await renderLayout(value)

      expect(byTestId(tree, 'maintenance-screen')).toHaveLength(1)
      expect(texts(tree)).toEqual(MAINTENANCE_COPY)
      expect(byTestId(tree, 'app-stack')).toHaveLength(0)
      // The store is never built (initStore fetches /users/me) and no request is made at all.
      expect(mockInitStore).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(mockExpoFetch).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, '', 'false', 'False', '0', 'yes'])(
    'MAINTENANCE_MODE=%p renders the normal app',
    async (value) => {
      const tree = await renderLayout(value)

      expect(byTestId(tree, 'maintenance-screen')).toHaveLength(0)
      expect(byTestId(tree, 'app-stack')).toHaveLength(1)
      expect(texts(tree)).not.toEqual(expect.arrayContaining([MAINTENANCE_COPY[0]]))
      expect(mockInitStore).toHaveBeenCalledTimes(1)
    },
  )
})
