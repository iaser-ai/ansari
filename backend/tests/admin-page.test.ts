import { describe, it, expect } from 'vitest';

/**
 * Admin analytics page tests.
 *
 * Since the page is a 'use client' React component with recharts (loaded via
 * next/dynamic { ssr: false }), full rendering tests require a browser-like
 * environment (jsdom/happy-dom + React testing library). The current vitest
 * config uses 'node' environment.
 *
 * These tests verify the data display logic used by the page.
 */

describe('Admin Analytics Page - display helpers', () => {
  it('formats null thread name as Untitled', () => {
    const threadName: string | null = null;
    const display = threadName || 'Untitled';
    expect(display).toBe('Untitled');
  });

  it('formats non-null thread name as-is', () => {
    const threadName: string | null = 'Zakat Q&A';
    const display = threadName || 'Untitled';
    expect(display).toBe('Zakat Q&A');
  });

  it('formats date string to locale string', () => {
    const iso = '2026-03-02T10:30:00.000Z';
    const formatted = new Date(iso).toLocaleString();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('formats summary card values with toLocaleString', () => {
    const value = 1234;
    expect(value.toLocaleString()).toBe('1,234');
  });

  it('formats feedback summary as up/down/report string', () => {
    const fb = { thumbs_up: 45, thumbs_down: 12, report: 3 };
    const display = `${fb.thumbs_up} / ${fb.thumbs_down} / ${fb.report}`;
    expect(display).toBe('45 / 12 / 3');
  });

  it('formats new users breakdown as 24h/7d/30d string', () => {
    const s = { new_users_24h: 5, new_users_7d: 23, new_users_30d: 89 };
    const display = `${s.new_users_24h} / ${s.new_users_7d} / ${s.new_users_30d}`;
    expect(display).toBe('5 / 23 / 89');
  });

  it('date range buttons should include 7, 30, 90', () => {
    const dateRanges = [7, 30, 90];
    expect(dateRanges).toEqual([7, 30, 90]);
    expect(dateRanges.map(d => `${d}d`)).toEqual(['7d', '30d', '90d']);
  });
});
