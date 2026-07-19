/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand tokens are CSS variables injected per-build in Base.astro
        // from the brand row's primary_color / secondary_color; the rest are
        // defined in src/styles/tokens.css.
        brand: 'var(--brand)',
        'brand-2': 'var(--brand-2)',
        accent: 'var(--accent)',
        ink: 'var(--ink)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        line: 'var(--line)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        heading: ['var(--font-heading)', 'system-ui', 'sans-serif'],
        // Spec-data face (--font-mono is set by brand stylesheets that use it,
        // e.g. tape-king; the fallback keeps other brands on the UA mono stack).
        mono: ['var(--font-mono, ui-monospace)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        'token-sm': 'var(--radius-sm)',
        'token-md': 'var(--radius-md)',
        'token-lg': 'var(--radius-lg)',
      },
      boxShadow: {
        'token-1': 'var(--shadow-1)',
        'token-2': 'var(--shadow-2)',
        'token-3': 'var(--shadow-3)',
      },
    },
  },
  plugins: [],
};
