// @vitest-environment jsdom
/**
 * Why no list on the web asks to dismiss the keyboard 'on-drag' (#202).
 *
 * react-native-web cannot see a drag. Given `keyboardDismissMode` of
 * 'on-drag' it dismisses on every scroll event instead — including one
 * the app makes itself, like a thread keeping its newest lines in view
 * as the keyboard makes room. That blurred the composer the reader had
 * just tapped, so the keyboard needed a second tap to stay up.
 *
 * This pins the library's behaviour, not the app's: if a release of
 * react-native-web starts telling a drag from a scroll, the first test
 * fails and 'on-drag' can come back on the web.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScrollView, TextInput } from 'react-native';

afterEach(cleanup);

function scrollWhileTyping(mode: 'on-drag' | 'none') {
  render(
    <>
      <ScrollView testID="list" keyboardDismissMode={mode}>
        <></>
      </ScrollView>
      <TextInput testID="composer" />
    </>,
  );
  const composer = screen.getByTestId('composer');
  composer.focus();
  expect(document.activeElement).toBe(composer);
  // A scroll the page made, not a finger: no touch precedes it.
  fireEvent.scroll(screen.getByTestId('list'));
  return document.activeElement === composer;
}

describe("react-native-web's keyboardDismissMode", () => {
  it("'on-drag' blurs the focused field on a scroll no finger made", () => {
    expect(scrollWhileTyping('on-drag')).toBe(false);
  });

  it("'none' leaves the field focused", () => {
    expect(scrollWhileTyping('none')).toBe(true);
  });
});
