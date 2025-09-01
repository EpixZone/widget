/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ['class'],
    content: [
        './index.html',
        './src/**/*.{vue,js,ts,jsx,tsx}',
        './lib/**/*.{vue,js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {
            colors: {
                yes: '#3fb68b',
                no: '#ff5353',
                info: '#00b2ff',
                main: 'var(--text-main)',
                secondary: 'var(--text-secondary)',
                active: 'var(--bg-active)',
                // Epix brand colors
                epix: {
                    primary: '#8A4BDB',
                    secondary: '#5954CD',
                    accent: '#69E9F5',
                    teal: '#31BDC6',
                    dark: '#0a0a0a',
                    gray: '#1a1a1a',
                    'gray-light': '#2a2a2a',
                }
            },
            backgroundImage: {
                'gradient-epix': 'linear-gradient(135deg, #8A4BDB 0%, #5954CD 50%, #31BDC6 100%)',
                'gradient-epix-dark': 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)',
            },
            boxShadow: {
                'epix': '0 4px 20px rgba(138, 75, 219, 0.15)',
                'epix-lg': '0 10px 40px rgba(138, 75, 219, 0.2)',
                'modern': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                'modern-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
            }
        },
    },
    plugins: [require('daisyui')],
    daisyui: {
        themes: [
            {
                light: {
                    ...require('daisyui/src/theming/themes')['[data-theme=light]'],
                    primary: '#8A4BDB',
                    secondary: '#5954CD',
                    accent: '#69E9F5',
                    neutral: '#1a1a1a',
                    'base-100': '#ffffff',
                    'base-200': '#f8f9fa',
                    'base-300': '#e9ecef',
                },
            },
            {
                dark: {
                    ...require('daisyui/src/theming/themes')['[data-theme=dark]'],
                    primary: '#8A4BDB',
                    secondary: '#5954CD',
                    accent: '#69E9F5',
                    neutral: '#ffffff',
                    'base-100': '#0a0a0a',
                    'base-200': '#1a1a1a',
                    'base-300': '#2a2a2a',
                    'base-content': '#ffffff',
                },
            },
        ],
    },
};
