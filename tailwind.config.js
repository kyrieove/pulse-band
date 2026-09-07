/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        island: {
          // Pulse 2.0 令牌（pulse-ui-mockup/tokens.css）；bg 从半透明改为不透明 —— 新窗口不再是透明悬浮胶囊
          bg: '#0d0f14',
          surface: '#13161f',
          elevated: '#1a1e2b',
          subtle: '#222738',
          input: '#0a0c10',
          border: 'rgba(255, 255, 255, 0.12)',
          accent: '#38bdf8',
          claude: '#D97757',
          codex: '#10A37F',
          antigravity: '#4285F4',
          card: 'rgba(24, 27, 36, 0.75)'
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 10px rgba(56, 189, 248, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(56, 189, 248, 0.6)' },
        }
      }
    },
  },
  plugins: [],
}
