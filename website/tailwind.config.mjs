/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        teal: {
          50:  '#f0fdfd',
          100: '#ccfafa',
          200: '#99f2f2',
          300: '#5de4e4',
          400: '#26cece',
          500: '#00a3a3',
          600: '#008888',
          700: '#006b6b',
          800: '#005353',
          900: '#003d3d',
          950: '#002424',
        },
      },
      fontFamily: {
        sans: [
          'Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"',
          'Roboto', 'Helvetica', 'Arial', 'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"', '"Fira Code"', '"Cascadia Code"',
          'Menlo', 'Consolas', 'monospace',
        ],
      },
      typography: ({ theme }) => ({
        DEFAULT: {
          css: {
            '--tw-prose-body': theme('colors.gray[700]'),
            '--tw-prose-headings': theme('colors.gray[900]'),
            '--tw-prose-lead': theme('colors.gray[600]'),
            '--tw-prose-links': theme('colors.teal[600]'),
            '--tw-prose-bold': theme('colors.gray[900]'),
            '--tw-prose-counters': theme('colors.gray[500]'),
            '--tw-prose-bullets': theme('colors.teal[400]'),
            '--tw-prose-hr': theme('colors.gray[200]'),
            '--tw-prose-quotes': theme('colors.gray[900]'),
            '--tw-prose-quote-borders': theme('colors.teal[300]'),
            '--tw-prose-captions': theme('colors.gray[500]'),
            '--tw-prose-code': theme('colors.teal[700]'),
            '--tw-prose-pre-code': theme('colors.gray[100]'),
            '--tw-prose-pre-bg': theme('colors.gray[900]'),
            '--tw-prose-th-borders': theme('colors.gray[300]'),
            '--tw-prose-td-borders': theme('colors.gray[200]'),
            // dark
            '--tw-prose-invert-body': theme('colors.gray[300]'),
            '--tw-prose-invert-headings': theme('colors.white'),
            '--tw-prose-invert-links': theme('colors.teal[400]'),
            '--tw-prose-invert-code': theme('colors.teal[300]'),
            '--tw-prose-invert-pre-code': theme('colors.gray[300]'),
            '--tw-prose-invert-pre-bg': 'rgb(0 0 0 / 50%)',
            '--tw-prose-invert-th-borders': theme('colors.gray[600]'),
            '--tw-prose-invert-td-borders': theme('colors.gray[700]'),
            maxWidth: 'none',
            a: {
              fontWeight: '500',
              textDecoration: 'underline',
              textDecorationColor: theme('colors.teal[300]'),
              textUnderlineOffset: '3px',
              '&:hover': { textDecorationColor: theme('colors.teal[500]') },
            },
            'code::before': { content: 'none' },
            'code::after':  { content: 'none' },
            code: {
              fontWeight: '500',
              backgroundColor: theme('colors.gray[100]'),
              borderRadius: theme('borderRadius.sm'),
              padding: '0.15em 0.35em',
              fontSize: '0.875em',
            },
          },
        },
        invert: {
          css: {
            code: {
              backgroundColor: theme('colors.gray[800]'),
            },
          },
        },
      }),
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
