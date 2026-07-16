/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand tokens are CSS variables injected per-build in Base.astro
        // from the brand row's primary_color / secondary_color.
        brand: 'var(--brand)',
        'brand-2': 'var(--brand-2)',
        ink: 'var(--ink)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        heading: ['var(--font-heading)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
