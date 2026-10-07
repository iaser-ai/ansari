// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@expo/vector-icons', () => ({
  Feather: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

import { SearchField } from '@/components/SearchField';

afterEach(cleanup);

function renderField(value: string, onClear?: () => void) {
  render(
    <SearchField
      size="compact"
      value={value}
      onChangeText={() => {}}
      placeholder="Search"
      accessibilityLabel="Search questions"
      onClear={onClear}
    />,
  );
}

describe('SearchField clear affordance (issue #235)', () => {
  it('shows a clear button once there is something to clear', () => {
    const onClear = vi.fn();
    renderField('wudu', onClear);
    const clear = screen.getByLabelText('Clear search');
    expect(screen.getByTestId('icon-x-circle')).toBeTruthy();
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('hides the clear button while the field is empty', () => {
    renderField('', vi.fn());
    expect(screen.queryByLabelText('Clear search')).toBeNull();
  });

  it('offers no clear button when the caller does not wire one', () => {
    renderField('wudu');
    expect(screen.queryByLabelText('Clear search')).toBeNull();
  });
});
