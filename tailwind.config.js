/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    borderRadius: {
      none: '0px',
      sm: '0px',
      DEFAULT: '0px',
      md: '0px',
      lg: '0px',
      xl: '0px',
      '2xl': '0px',
      '3xl': '0px',
      full: '0px'
    },
    extend: {
      colors: {
        industrial: {
          bg: '#0f0f0f',
          panel: '#141414',
          raised: '#1a1a1a',
          border: '#333333',
          text: '#e5e5e5',
          muted: '#a3a3a3',
          dim: '#737373'
        }
      },
      animation: {
        shimmer: 'shimmer 2.2s ease-in-out infinite'
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(120%)' }
        }
      },
    }
  },
  plugins: []
}
