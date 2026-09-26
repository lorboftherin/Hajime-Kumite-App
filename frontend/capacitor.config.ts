import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App del celular: la misma interfaz Angular empaquetada con Capacitor.
 * Se compila con `npm run build:mobile` y luego `npx cap sync android`.
 */
const config: CapacitorConfig = {
  appId: 'com.hajime.torneos',
  appName: 'Hajime',
  webDir: 'dist/hajime-mobile/browser',
  android: {
    allowMixedContent: false,
  },
  server: {
    // Con esquema https el WebView trata a la app como sitio seguro (cámara, portapapeles…).
    androidScheme: 'https',
  },
};

export default config;
