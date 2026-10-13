# App del celular

Hajime es **una sola app** para todos los dispositivos: la misma interfaz
Angular se usa en el navegador, se instala desde el navegador (PWA) y se
empaqueta con Capacitor para Android (y, más adelante, iPhone). No hay una
app «nativa» aparte que mantener.

## 1. Instalar desde el navegador (PWA): ya disponible

En el celular, abre la dirección de Hajime (por ejemplo,
https://hajime.lorboftherin.com) y:

- **Android (Chrome):** menú ⋮ → «Instalar aplicación» o «Agregar a la
  pantalla de inicio».
- **iPhone (Safari):** botón Compartir → «Agregar a pantalla de inicio».

Queda con el ícono de Hajime, abre a pantalla completa y **funciona sin
conexión**: la app se guarda en el dispositivo, las últimas lecturas de la API
sirven de respaldo durante 12 horas y la mesa guarda los eventos de un combate
hasta que vuelve la señal. Cuando hay una versión nueva, la app avisa y la
persona decide cuándo recargar (nunca en medio de un combate).

No requiere cuentas de desarrollador ni tiendas. Es la forma recomendada de
probar en torneos reales mientras se preparan las tiendas.

## 2. APK de Android para pruebas (sin Google Play)

Cada vez que se sube un cambio, GitHub compila un **APK de prueba**:

1. Entra a la corrida en GitHub → pestaña *Actions* → la corrida más reciente.
2. Abajo, en **Artifacts**, descarga `hajime-android-apk`. Dentro viene
   `hajime-<versión>.apk`.
3. Compártelo por WhatsApp o Drive. Quien lo instala debe aceptar el aviso de
   Android de «instalar apps de origen desconocido» (una sola vez).

Es una compilación de depuración firmada con la clave de prueba de Android:
sirve para probar, no para publicar en la tienda. **No se actualiza sola**:
cada versión nueva se vuelve a compartir e instalar (la PWA sí se actualiza).

La app apunta al servidor de pruebas (`environment.mobile.ts`). Si la
organización usa otro servidor, en la pantalla de ingreso se despliega
«Servidor» y se cambia la dirección; queda guardada en el dispositivo.

### Compilar en tu computadora

```bash
cd frontend
npm run build:mobile          # compila la interfaz apuntando al servidor
npx cap sync android          # la copia al proyecto Android
npx cap open android          # abre Android Studio (o: cd android && ./gradlew assembleDebug)
```

Requiere Android Studio (o el SDK de Android) y JDK 21. El proyecto Android
está en `frontend/android/` y se versiona; lo que genera `cap sync` no.

## Barra de estado y bordes de la pantalla (Android 15+ e iPhone)

Desde Android 15 las apps se dibujan **de borde a borde**: el contenido llega
hasta detrás de la barra de estado (hora, batería) y de la barra de gestos.
Capacitor 8 deja el WebView en pantalla completa e informa el alto de esas
barras en `--safe-area-inset-*` (y en `env(safe-area-inset-*)`); en teléfonos
con un WebView más antiguo agrega el margen por su cuenta, por eso el problema
solo se veía en algunos equipos.

La interfaz reserva ese espacio con las variables `--safe-top`, `--safe-bottom`,
`--safe-left` y `--safe-right` (`frontend/src/styles.scss`): la cabecera, la
barra lateral, la barra inferior, la mesa, el vivo público, la pantalla grande y
las páginas sueltas (ingreso, cuenta, perfil público) las usan. **Toda superficie
nueva pegada a un borde de la pantalla debe usarlas.** Para revisarlo sin un
teléfono: en las herramientas del navegador, vista de celular, agrega
`:root{--safe-area-inset-top:36px;--safe-area-inset-bottom:24px}` y comprueba
que nada quede bajo los primeros 36 px.

## 3. Publicar en las tiendas (pendiente)

| Paso | Qué hace falta |
| --- | --- |
| Google Play | Cuenta de desarrollador (25 USD, una vez). Con cuenta personal nueva, Google exige una prueba cerrada con unos 12 probadores durante 14 días antes de publicar. Firmar el APK/AAB con una clave propia (`keystore`) que se guarda como secreto del repositorio. |
| App Store | Apple Developer Program (99 USD al año), un Mac o un servicio en la nube para compilar (Codemagic, GitHub Actions con macOS), TestFlight para las pruebas. `npx cap add ios`. |
| Ambas | Política de privacidad publicada (Ley 29733, menores de edad), formularios de datos (Data safety / Privacy labels), capturas de pantalla, clasificación de contenido. La app se declara para adultos (competidores mayores, padres o apoderados y dojos), no como app infantil. **Borrar la cuenta desde la app** ya existe (menú de usuario → «Borrar mi cuenta»). |
| Cobros | Nada dentro de la app: la membresía se paga en la web (`docs/modelo-negocio.md`). |

Pendiente para después: notificaciones push nativas (Firebase; el camino está
en [`avisos-push.md`](avisos-push.md), «Camino a FCM». Mientras tanto la app
oculta la campana «Avisarme» y sugiere instalar Hajime desde el navegador, que
sí recibe avisos Web Push) y enlaces que
abran la app (por ejemplo, el enlace «en vivo» compartido por WhatsApp).

## Cómo está hecho

- `frontend/src/environments/`: `environment.ts` (web, API relativa) y
  `environment.mobile.ts` (app, API en el servidor). La configuración de
  compilación `mobile` de `angular.json` usa la segunda.
- `frontend/src/app/core/server.ts`: dirección de la API y servidor guardado
  en el dispositivo.
- `frontend/ngsw-config.json` y `core/update.service.ts`: service worker,
  caché de la API y aviso de versión nueva. En la app del celular el service
  worker se desactiva (la interfaz ya viene dentro de la app).
- `frontend/capacitor.config.ts` y `frontend/android/`: empaquetado.
  `core/mobile.service.ts` maneja el botón «atrás» de Android.
- `backend/app/config.py`: el CORS acepta los orígenes de Capacitor
  (`https://localhost`, `capacitor://localhost`) en `dev` y `test`. En `prod`
  hay que declararlos en `HAJIME_CORS_ORIGINS` (ver `docs/despliegue.md`).
