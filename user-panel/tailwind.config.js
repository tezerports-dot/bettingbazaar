// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        gold: {
          primary: '#D4AF37',
          light: '#F5C77A',
          muted: '#8A7018',
          glow: 'rgba(212, 175, 55, 0.5)',
        },
        delhi: '#E53935',
        bombay: '#1E88E5',
      },
      animation: {
        'spin-slow':            'spin 8s linear infinite',
        'bounce-slight':        'bounce 2s infinite',
        'winner-border':        'winner-border-pulse 1.2s ease-in-out infinite',
        'winner-shimmer':       'winner-shimmer-sweep 1.8s ease-in-out infinite',
        'winner-glow':          'winner-inner-glow 1s ease-in-out infinite',
        'winner-text':          'winner-text-breathe 0.9s ease-in-out infinite',
      }
    },
  },
  plugins: [
    function({ addUtilities }) {
      addUtilities({
        '.perspective-800':       { perspective: '800px' },
        '.perspective-1200':      { perspective: '1200px' },
        '.perspective-2000':      { perspective: '2000px' },
        '.transform-style-3d':    { transformStyle: 'preserve-3d' },
        '.backface-hidden':       { backfaceVisibility: 'hidden' },
        '.backface-visible':      { backfaceVisibility: 'visible' },
        '.rotate-y-180':          { transform: 'rotateY(180deg)' },
        '.translate-z-0':         { transform: 'translateZ(0)' },
        '.translate-z-4':         { transform: 'translateZ(1rem)' },
        '.translate-z-8':         { transform: 'translateZ(2rem)' },
        '.will-change-transform': { willChange: 'transform' },
        '.glass': {
          background: 'rgba(15, 20, 35, 0.55)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: '1px solid rgba(212, 175, 55, 0.18)',
        },
        '.glass-gold': {
          background: 'rgba(20, 15, 5, 0.65)',
          backdropFilter: 'blur(24px) saturate(200%)',
          WebkitBackdropFilter: 'blur(24px) saturate(200%)',
          border: '1px solid rgba(212, 175, 55, 0.3)',
          boxShadow: '0 8px 32px rgba(212,175,55,0.12), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(212,175,55,0.2)',
        },
      });
    },
  ],
}
