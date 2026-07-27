import colors from 'tailwindcss/colors';

/** Helper: a Tailwind colour backed by a themeable RGB-channel CSS var,
 *  so opacity modifiers (e.g. bg-gold-500/20) keep working across themes. */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Global default border colour (used by `* { @apply border-border }`)
        border: v('--c-border'),

        // Command Center semantic tokens (theme-aware).
        surface: v('--c-surface'),
        'surface-2': v('--c-surface-2'),
        // Convenience solid tokens (no opacity modifiers needed on these).
        hover: 'var(--hover)',
        active: 'var(--active)',
        input: 'var(--input)',
        track: 'var(--track)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
        risk: 'var(--risk)',
        neutral: 'var(--neutral)',
        'gold-ink': 'var(--gold-ink)',

        primary: {
          50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc',
          400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1',
          800: '#075985', 900: '#0c4a6e',
        },

        // Gold accent — flips gold-400/500/600 to the design's ink/gold/deep.
        gold: {
          400: v('--c-gold-ink'),
          500: v('--c-gold'),
          600: v('--c-gold-deep'),
        },

        // Neutral surfaces — remapped to the design's bg/surface/border scale.
        dark: {
          900: v('--c-bg'),        // page background
          800: v('--c-surface'),   // cards
          700: v('--c-border'),    // chips / dividers / hover
          600: v('--c-border-2'),  // input borders
        },

        // Text greys become theme-aware; 700/800/900 keep Tailwind defaults
        // (used as toggle tracks / opaque fills that must stay dark).
        gray: {
          ...colors.gray,
          100: v('--c-text'),
          200: v('--c-text'),
          300: v('--c-text-2'),
          400: v('--c-text-2'),
          500: v('--c-muted'),
          600: v('--c-muted'),
        },
      },
      fontFamily: {
        sans: ['Manrope', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
