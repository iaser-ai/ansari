export type HostThemeAppearance = 'light' | 'dark' | 'system';

export type HostColorTokens = {
  surface: string;
  backdrop: string;
  ink: string;
  secondary: string;
  line: string;
};

export type HostThemeContext = {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string | undefined> };
  containerDimensions?: {
    width?: number;
    maxWidth?: number;
    height?: number;
    maxHeight?: number;
  };
  deviceClass?: unknown;
  maxWidth?: unknown;
  maxHeight?: unknown;
  platform?: unknown;
  displayMode?: unknown;
};

export type ResolvedHostTheme = {
  appearance: HostThemeAppearance;
  tokens: HostColorTokens;
  tokenSource: 'host' | 'fallback';
  viewport: 'block' | 'card' | 'unknown';
  width?: number;
  height?: number;
  deviceClass?: string;
  hostAlreadyScales: boolean;
  rootScale: 1;
  missing: string[];
};

export type ThemeRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
};

/** Alexa visual-foundations card colors plus the selected answer-card ink. */
export const FALLBACK_TOKENS: Record<HostThemeAppearance, HostColorTokens> = {
  system: {
    surface: 'light-dark(#ffffff, #14191c)',
    backdrop: 'light-dark(#ffffff, #14191c)',
    ink: 'light-dark(#172235, #eef1f4)',
    secondary: 'light-dark(#556275, #b9c4cd)',
    line: 'light-dark(#d9e2e5, #607c70)',
  },
  light: {
    surface: '#ffffff',
    backdrop: '#ffffff',
    ink: '#172235',
    secondary: '#556275',
    line: '#d9e2e5',
  },
  dark: {
    surface: '#14191c',
    backdrop: '#14191c',
    ink: '#eef1f4',
    secondary: '#b9c4cd',
    line: '#607c70',
  },
};

const HOST_TOKEN_KEYS = {
  surface: '--color-background-primary',
  backdrop: '--color-background-secondary',
  ink: '--color-text-primary',
  secondary: '--color-text-secondary',
  line: '--color-border-primary',
} as const;

/** Numeric host colors can be checked without a DOM or browser dependency. */
function luminance(color: string): number | undefined {
  const hex = /^#([a-f\d]{6})$/i.exec(color.trim());
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color.trim());
  const channels = hex ? [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) :
    rgb ? rgb.slice(1).map(Number) : undefined;
  if (!channels || channels.some(c => c > 255)) return undefined;
  return channels.map(c => {
    const v = c / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}

function contrast(foreground: string, background: string): number | undefined {
  const a = luminance(foreground), b = luminance(background);
  return a === undefined || b === undefined ? undefined : (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function asDeviceClass(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function pickDimension(
  context: HostThemeContext | undefined,
  fixed: 'width' | 'height',
  max: 'maxWidth' | 'maxHeight',
  extra: 'maxWidth' | 'maxHeight',
): number | undefined {
  const box = context?.containerDimensions;
  return asFiniteNumber(box?.[fixed]) ?? asFiniteNumber(box?.[max]) ?? asFiniteNumber(context?.[extra]);
}

/**
 * Map host context onto presentation tokens. Theme never enters answer data.
 * Root scale stays 1: Alexa already CSS-scales the iframe (do not apply 1.6).
 */
export function resolveHostTheme(context?: HostThemeContext | null): ResolvedHostTheme {
  const appearance: HostThemeAppearance =
    context?.theme === 'light' || context?.theme === 'dark' ? context.theme : 'system';
  const variables = context?.styles?.variables;
  const fallback = FALLBACK_TOKENS[appearance];
  const tokens: HostColorTokens = { ...fallback };
  let usedHostToken = false;
  (Object.keys(HOST_TOKEN_KEYS) as Array<keyof typeof HOST_TOKEN_KEYS>).forEach((token) => {
    const hostValue = variables?.[HOST_TOKEN_KEYS[token]];
    if (typeof hostValue === 'string' && hostValue.trim() !== '') {
      tokens[token] = hostValue;
      usedHostToken = true;
    }
  });

  // Some hosts supply a muted UI gray below 4.5:1. The attribution is
  // reading text, so retain the host surface while choosing legible ink.
  const secondaryContrast = contrast(tokens.secondary, tokens.surface);
  if (secondaryContrast !== undefined && secondaryContrast < 4.5) {
    const fallbackContrast = contrast(fallback.secondary, tokens.surface);
    tokens.secondary = fallbackContrast !== undefined && fallbackContrast >= 4.5 ? fallback.secondary : tokens.ink;
  }

  const width = pickDimension(context ?? undefined, 'width', 'maxWidth', 'maxWidth');
  const height = pickDimension(context ?? undefined, 'height', 'maxHeight', 'maxHeight');
  const viewport: ResolvedHostTheme['viewport'] =
    width !== undefined && height !== undefined ? (width >= height ? 'block' : 'card') : 'unknown';
  const deviceClass = asDeviceClass(context?.deviceClass);
  const missing: string[] = [];
  if (appearance === 'system') missing.push('theme');
  if (!usedHostToken) missing.push('styles.variables');
  if (viewport === 'unknown') missing.push('containerDimensions');
  if (!deviceClass) missing.push('deviceClass');

  return {
    appearance,
    tokens,
    tokenSource: usedHostToken ? 'host' : 'fallback',
    viewport,
    width,
    height,
    deviceClass,
    hostAlreadyScales: Boolean(deviceClass),
    rootScale: 1,
    missing,
  };
}

export function applyResolvedTheme(root: ThemeRoot, resolved: ResolvedHostTheme): void {
  if (resolved.appearance === 'system') {
    root.removeAttribute('data-theme');
    root.style.setProperty('color-scheme', 'light dark');
  } else {
    root.setAttribute('data-theme', resolved.appearance);
    root.style.setProperty('color-scheme', resolved.appearance);
  }

  if (resolved.appearance === 'system') {
    root.style.removeProperty('--ansari-light-art');
    root.style.removeProperty('--ansari-dark-art');
  } else {
    root.style.setProperty('--ansari-light-art', resolved.appearance === 'light' ? 'block' : 'none');
    root.style.setProperty('--ansari-dark-art', resolved.appearance === 'dark' ? 'block' : 'none');
  }

  root.setAttribute('data-token-source', resolved.tokenSource);
  root.setAttribute('data-viewport', resolved.viewport);
  root.setAttribute('data-root-scale', '1');
  root.setAttribute('data-host-scale', resolved.hostAlreadyScales ? 'host' : 'none');
  if (resolved.deviceClass) {
    root.setAttribute('data-device-class', resolved.deviceClass);
  } else {
    root.removeAttribute('data-device-class');
  }

  root.style.setProperty('--ansari-surface', resolved.tokens.surface);
  root.style.setProperty('--ansari-backdrop', resolved.tokens.backdrop);
  root.style.setProperty('--ansari-ink', resolved.tokens.ink);
  root.style.setProperty('--ansari-secondary', resolved.tokens.secondary);
  root.style.setProperty('--ansari-line', resolved.tokens.line);
}

/** How the reader meets the host; the stack decides it (`readingProfile`), the application maps it. */
export type ReadingProfile = 'device' | 'desktop';

export function applyHostTheme(root: ThemeRoot, context: HostThemeContext | null | undefined, hostName: string | undefined, profile: ReadingProfile): ResolvedHostTheme {
  const resolved = resolveHostTheme(context);
  applyResolvedTheme(root, resolved);
  // Width alone does not establish viewing distance: Codex can open wide panels, so the stack's
  // reading profile (a device host, an Echo Show device class or a mobile platform) decides.
  const deviceReading = profile === 'device';
  root.style.setProperty('--ansari-wide-reading-scale', deviceReading ? '1.6' : '1');
  root.setAttribute('data-reading-profile', profile);
  if (hostName) root.setAttribute('data-host-name', hostName);
  else root.removeAttribute('data-host-name');
  const variables = context?.styles?.variables;
  if (variables) {
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string' && value.trim() !== '') {
        root.style.setProperty(name, value);
      }
    }
  }
  return resolved;
}
