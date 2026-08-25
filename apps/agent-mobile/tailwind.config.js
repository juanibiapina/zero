/** @type {import('tailwindcss').Config} */
// NativeWind v4 uses Tailwind CSS v3 (the mobile app pins its own tailwindcss@3,
// separate from the web packages on Tailwind 4). `nativewind/preset` maps the
// Tailwind theme onto React Native styles. Keep design tokens here so screens
// and components share one source of truth.
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Zero brand blue (matches the splash background in app.json).
        primary: '#208AEF',
      },
    },
  },
  plugins: [],
};
