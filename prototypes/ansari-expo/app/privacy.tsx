import React from 'react';
import { Platform } from 'react-native';
import Head from 'expo-router/head';
import { PRIVACY } from '@/constants/legal';
import { LegalPage } from '@/components/LegalPage';

export default function PrivacyScreen() {
  return (
    <>
      {Platform.OS === 'web' && (
        <Head>
          <title>Privacy Policy · Ansari</title>
          <meta
            name="description"
            content="How Ansari collects, uses, and discloses your information."
          />
        </Head>
      )}
      <LegalPage doc={PRIVACY} barTitle="Privacy" />
    </>
  );
}
