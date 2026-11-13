import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every pair of theme tokens that carries text reaches WCAG AA (4.5:1), in light and dark.
 * Reads the tokens straight from `styles.css`, so a changed value is checked at once.
 */

/** Text token on background token. */
const TEXT_PAIRS: [text: string, background: string][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['primary-foreground', 'primary'],
  ['button-foreground', 'button'],
  ['secondary-foreground', 'secondary'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'sidebar'],
  ['accent-foreground', 'accent'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['destructive', 'destructive-muted'],
  ['success', 'background'],
  ['success', 'card'],
  ['success', 'success-muted'],
  ['warning', 'background'],
  ['warning', 'card'],
  ['warning', 'warning-muted'],
  ['info', 'background'],
  ['info', 'card'],
  // Status text and badges on muted areas (summary rows, history lists, the sign-in page).
  ['foreground', 'muted'],
  ['success', 'muted'],
  ['warning', 'muted'],
  ['destructive', 'muted'],
  ['info', 'muted'],
  ['info', 'info-muted'],
  // Counts on solid status colours (the alerts bell).
  ['background', 'warning'],
  ['background', 'destructive'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
];

const AA = 4.5;

/** Graphics that carry meaning (the dashboard's status lights) need 3:1 (WCAG 1.4.11). */
const GRAPHIC_PAIRS: [graphic: string, background: string][] = [
  ['light-ok', 'card'],
  ['light-warn', 'card'],
  ['light-fail', 'card'],
];
const GRAPHIC = 3;

function tokens(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} not found in styles.css`);
  const block = css.slice(start, css.indexOf('}', start));
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

/** `oklch(L C h)` → linear-light sRGB, clamped to the gamut. */
function oklchToLinearRgb(value: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`not a plain oklch() colour: ${value}`);
  const [l, c, h] = match.slice(1).map(Number);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

function luminance(value: string): number {
  const [r, g, b] = oklchToLinearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}

describe('theme tokens: contrast', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  const light = tokens(css, ':root');
  // Dark overrides some tokens; the rest come from light. The frame (sidebar, top bar) uses dark.
  const dark = new Map([...light, ...tokens(css, ':root.dark,\n.theme-frame')]);

  it('knows the conversion (black on white is 21:1)', () => {
    expect(contrast('oklch(0 0 0)', 'oklch(1 0 0)')).toBeCloseTo(21, 1);
  });

  for (const [theme, values] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    // The sidebar is part of the frame: dark in both themes, so it's checked with dark only.
    const pairs =
      theme === 'light'
        ? TEXT_PAIRS.filter((pair) => !pair.join().includes('sidebar'))
        : TEXT_PAIRS;
    it.each(pairs)(`${theme}: %s on %s reaches AA`, (text, background) => {
      const fg = values.get(text);
      const bg = values.get(background);
      expect(fg, `--${text}`).toBeDefined();
      expect(bg, `--${background}`).toBeDefined();
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(AA);
    });

    it.each(GRAPHIC_PAIRS)(`${theme}: %s on %s reaches 3:1`, (graphic, background) => {
      expect(contrast(values.get(graphic)!, values.get(background)!)).toBeGreaterThanOrEqual(
        GRAPHIC,
      );
    });
  }
});
