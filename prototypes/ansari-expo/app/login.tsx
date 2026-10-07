import React, { useEffect } from 'react';
import { Redirect } from 'expo-router';
import { openAuthSheet } from '@/lib/authSheet';

/**
 * `/login` is kept as a way in — an old link, a bookmark, a browser's
 * history — but signing in is a sheet over the app now, not a page of
 * its own (`AuthSheet`). So the link lands on the home screen with that
 * sheet raised on its "Log in" face.
 */
export default function LoginScreen() {
  useEffect(() => {
    openAuthSheet('login');
  }, []);
  return <Redirect href="/" />;
}
