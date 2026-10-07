import React, { useEffect } from 'react';
import { Redirect } from 'expo-router';
import { openAuthSheet } from '@/lib/authSheet';

/**
 * `/register` lands on the home screen with the sign-in sheet raised on
 * its "Sign up" face — see `app/login.tsx`.
 */
export default function RegisterScreen() {
  useEffect(() => {
    openAuthSheet('register');
  }, []);
  return <Redirect href="/" />;
}
