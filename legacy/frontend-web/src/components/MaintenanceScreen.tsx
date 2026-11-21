import React from 'react'
import { Text, View } from 'react-native'
import RootContainer from './RootContainer'
import RootImageBackground from './RootImageBackground'
import { LogoIcon } from './svg'

// Same screen and copy as legacy/frontend-app/src/components/MaintenanceScreen.tsx.
// Shown in place of the whole app when EXPO_PUBLIC_MAINTENANCE_MODE is on (see src/app/_layout.tsx).
const MaintenanceScreen: React.FC = () => {
  return (
    <RootContainer>
      <RootImageBackground>
        <View className='flex-1' testID='maintenance-screen'>
          <View className='w-full p-8 items-center justify-start gap-4'>
            <LogoIcon />
            <Text className='text-center text-white text-xl' style={{ fontFamily: 'Inter' }}>
              Ansari is currently under maintenance.
            </Text>
            <Text className='text-center text-white text-xl' style={{ fontFamily: 'Inter' }}>
              We are working hard to bring you the best experience possible.
            </Text>
            <Text className='text-center text-white text-xl' style={{ fontFamily: 'Inter' }}>
              Thank you for your patience!
            </Text>
          </View>
        </View>
      </RootImageBackground>
    </RootContainer>
  )
}

export default MaintenanceScreen
