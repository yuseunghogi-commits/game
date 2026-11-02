import { defineConfig } from 'vite';

// Tauri 데스크톱 셸과 함께 쓰는 설정 (dev 서버 포트 고정, Windows WebView2 대상)
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
