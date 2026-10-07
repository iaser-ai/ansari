import React from 'react';
import { Platform } from 'react-native';
import Head from 'expo-router/head';
import { TERMS } from '@/constants/legal';
import { LegalPage } from '@/components/LegalPage';

export default function TermsScreen() {
  return (
    <>
      {Platform.OS === 'web' && (
        <Head>
          <title>Terms of Service · Ansari</title>
          <meta
            name="description"
            content="The terms on which Ansari, an AI assistant for learning about Islam, is offered."
          />
        </Head>
      )}
      <LegalPage doc={TERMS} barTitle="Terms" />
    </>
  );
}
