import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: VITE_BASE is set to the live Domino /proxy/$PORT/ path so HMR scripts resolve.
// Build: base is './' so the static dist/ works behind any mount path.
export default defineConfig(({ command }) => {
  const isServe = command === 'serve';
  const base = isServe ? (process.env.VITE_BASE || '/') : './';
  const internalPort = parseInt(process.env.VITE_INTERNAL_PORT || '5174', 10);
  const flaskPort = process.env.VITE_API_PORT || '8501';

  return {
    plugins: [react()],
    base,
    server: {
      host: '0.0.0.0',
      port: internalPort,
      strictPort: true,
      allowedHosts: true,
      hmr: { clientPort: 443, protocol: 'wss' },
      proxy: { '/api': `http://localhost:${flaskPort}` },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
