# Acciones que solo puede hacer el dueño

El código, CI y los scripts ya están listos; esto requiere permisos de dueño
en GitHub o en Azure. Hacerlo en este orden. Cada paso dice cómo comprobar que
quedó bien.

## Urgente: reactivar la suscripción de Azure (pruebas caídas)

Desde el **25 de octubre de 2026** la app de pruebas no responde
(`ERR_CONNECTION_ABORTED` en https://hajime.lorboftherin.com y también en la
dirección directa `*.azurecontainerapps.io`). No es el dominio, el certificado
ni el código: la suscripción «Azure subscription 1» es una **prueba gratuita
(Free Trial) con límite de gasto** creada el 25‑09‑2026, y a los 30 días Azure
la **deshabilitó** (`state: Disabled`). Con la suscripción deshabilitada el
entorno de Container Apps queda suspendido (`ManagedClusterSuspended`), por
eso la conexión se corta antes del saludo TLS. La identidad de Claude
(`hajime-claude-code`, Colaborador) no puede reactivarla: solo el dueño de la
cuenta.

1. Portal de Azure → **Suscripciones** → «Azure subscription 1» → aviso
   «Tu suscripción está deshabilitada» → **Actualizar suscripción** (pasar a
   *Pago por uso*). Alternativa: **Configuración → Quitar límite de gasto**.
   El nivel gratuito de 12 meses (hasta 2027‑10‑25) se conserva; los recursos
   actuales de pruebas cuestan centavos al mes (base serverless gratuita,
   Container Apps dentro de la cuota gratis).
2. Esperar unos minutos y comprobar que la suscripción figura **Activa**:
   `az account show --query state` → `Enabled`.
3. Si al cabo de 10 minutos la app sigue sin responder, volver a aplicar la
   configuración (no borra nada):
   ```bash
   cd Hajime-Kumite-App/infra/azure
   bash crear-ambiente.sh test
   ```
   y, si el dominio no levanta, `bash conectar-dominio.sh test hajime.lorboftherin.com`.
   *Comprobar:* `curl -s https://hajime.lorboftherin.com/health` responde 200
   y la pantalla de ingreso carga.
4. Para no repetirlo: crear la alerta de gasto (`PRESUPUESTO_USD` en
   `crear-ambiente.sh` o portal → **Presupuestos**) y revisar el correo de
   facturación: Azure avisa antes de deshabilitar.

## GitHub

1. **Crear `main`** desde la rama integrada que se te indique (si no se indica
   otra, `claude/gracious-feynman-qtapgx`):
   GitHub → **Branches** → **New branch** → nombre `main`, origen esa rama.
   Luego **Settings → General → Default branch** → `main`.
   *Comprobar:* la pestaña **Actions** muestra una corrida de CI en `main` y,
   al terminar, existen las imágenes `:azure` y `:latest` en *Packages*.
2. **Proteger `main`:** **Settings → Rules → Rulesets → New branch ruleset**
   (o *Branches → Add classic branch protection rule*), destino `main`:
   - Require a pull request before merging (1 aprobación; con un solo
     colaborador, activar «Allow specified actors to bypass» solo para ti).
   - Require review from Code Owners.
   - Require status checks to pass: `backend`, `contratos`, `frontend`,
     `auditoria`, `docker` (aparecen después de la primera corrida).
   - Block force pushes y Restrict deletions.
   - Require linear history (se integra con *squash*).
3. **Actions → General:** *Workflow permissions* = **Read repository contents**
   (los workflows piden más permisos solo donde los necesitan).
4. **Imagen pública (recomendado):** tu perfil → **Packages** →
   `hajime-kumite-app` → *Package settings* → **Change visibility → Public**.
   La imagen no tiene secretos; así Azure no necesita ningún token. Si la dejas
   privada, crea un token *classic* con **solo `read:packages`** para el script.
5. **CodeQL:** en repositorios privados necesita *GitHub Code Security*
   (Settings → Code security). Si no lo tienes, el workflow CodeQL fallará al
   subir resultados: actívalo, o desactiva el workflow (Actions → CodeQL →
   «Disable workflow») hasta tenerlo. Dependabot funciona sin eso: activar en
   **Settings → Code security → Dependabot alerts / security updates**.
6. **Prettier:** el frontend ya está formateado y el job `formato` ya es
   obligatorio en CI; al proteger `main`, agrégalo (y `e2e`) a los checks
   requeridos.

## Azure: pruebas (actualizar lo que ya existe)

7. En Cloud Shell, con el repositorio al día (`git pull` en `main`):
   ```bash
   cd Hajime-Kumite-App/infra/azure
   bash crear-ambiente.sh test
   ```
   Ya no borra la app: la actualiza, crea el usuario `hajime_app`, el job
   `hajime-test-migrar` y las sondas, y borra la clave inicial del admin.
   *Comprobar:* termina con «Listo» y el dominio sigue funcionando.
8. Apuntar la publicación automática a `main` (reemplaza la credencial de la
   rama `claude/…`):
   ```bash
   bash conectar-github.sh test main
   ```
   En GitHub → Settings → Secrets and variables → Actions → **Variables**:
   `AZURE_TEST_BRANCH` = `main` (o borrarla: `main` es el valor por defecto).
   *Comprobar:* el siguiente push a `main` corre el job `deploy-test` en verde.

## Azure: producción

9. **Decidir el tamaño de la base** (`SQL_SKU`): `S0` (~$15/mes, por defecto,
   suficiente para los primeros torneos), `S1` (~$30, torneos grandes con
   muchas mesas) o `serverless` (paga por uso, sin autopausa). Se puede subir
   después con un comando (el script lo imprime).
10. Crear el ambiente con alerta de gasto:
    ```bash
    SQL_SKU=S0 PRESUPUESTO_USD=60 PRESUPUESTO_CORREO=<tu correo> bash crear-ambiente.sh prod
    ```
    Opcionales: `APP_INSIGHTS=1` (monitoreo), `SQL_FIREWALL=salida` (base
    cerrada a todo salvo la app; ver docs/despliegue-azure.md).
11. Conectar GitHub con producción:
    ```bash
    bash conectar-github.sh prod
    ```
    y en GitHub → **Settings → Environments → New environment** `prod`:
    - **Required reviewers:** tú.
    - **Deployment branches and tags:** *Selected* → `main` y la regla de
      etiquetas `v*`.
    - **Environment variables:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
      `AZURE_SUBSCRIPTION_ID` con los valores que imprimió el script (van en el
      entorno, NO en las variables del repositorio).
12. Dominio de producción: registros DNS que imprimió `crear-ambiente.sh prod`
    y `bash conectar-dominio.sh prod <dominio>`.
13. **Primera versión:** con todo integrado en `main`,
    `git tag v0.2.0 && git push origin v0.2.0` (o GitHub → Releases → *Draft a
    new release* → etiqueta nueva `v0.2.0` sobre `main`). El workflow Release
    publica `:0.2.0-azure`, el APK y las notas.
14. **Primer despliegue:** Actions → **Desplegar a producción** → `0.2.0` →
    aprobar. *Comprobar:* el resumen muestra la URL y la versión de la API.
15. **Ensayo de restauración** antes del primer torneo real:
    `bash restaurar-prueba.sh prod` y `bash respaldar.sh prod`.

## Cuando se decida cobrar

Hoy los cobros están **apagados por decisión tuya** (`HAJIME_PAYMENTS_ENABLED`
sin definir o en `false`): no hay nada que hacer aquí hasta que decidas
cobrar. Mientras tanto no configures `HAJIME_BILLING_MODE=enforced` (se ignora
y deja un aviso en el log). Detalle y pasos de prueba en [cobros.md](cobros.md).

1. **Elegir pasarela** (Mercado Pago o Culqi), crear la cuenta de empresa y
   obtener las credenciales de prueba y de producción.
2. **Registrar la URL de avisos** en el panel de la pasarela
   (`https://<dominio>/api/v1/payments/webhook/mercadopago` o `/culqi`) y copiar
   la clave secreta (Mercado Pago) o poner una contraseña de autenticación
   básica (Culqi).
3. (Culqi, mensual) **Crear los planes** en CulqiPanel con los mismos precios.
4. **Proveedor de comprobantes (OSE/PSE):** contratar Nubefact, dar de alta
   las series de boleta y factura y copiar la ruta y el token de la API.
5. **Cargar los secretos** en el Container App (TEST con credenciales de
   prueba; producción con las reales): `HAJIME_MP_ACCESS_TOKEN`,
   `HAJIME_MP_WEBHOOK_SECRET` o `HAJIME_CULQI_SECRET_KEY`,
   `HAJIME_CULQI_PUBLIC_KEY`, `HAJIME_CULQI_WEBHOOK_SECRET`,
   `HAJIME_NUBEFACT_URL`, `HAJIME_NUBEFACT_TOKEN`; y las variables
   `HAJIME_PAYMENT_PROVIDER`, `HAJIME_INVOICING_PROVIDER`, `HAJIME_PUBLIC_URL`.
6. **Decidir** precios finales, días de prueba y si se activa el cupón
   `PRIMER-TORNEO`.
7. **Encender los cobros:** `HAJIME_PAYMENTS_ENABLED=true` (primero en TEST y,
   probado, en producción) y luego `HAJIME_BILLING_MODE=enforced`.
   *Comprobar:* `GET /api/v1/billing/config` responde `"payments_enabled": true`
   y aparece el menú «Pagos» para el Admin.

## Más adelante

- **Activar los avisos push** (`docs/avisos-push.md`): generar las claves una
  sola vez con `python -m app.seed vapid-keys` (en tu máquina o en Cloud Shell
  con el backend instalado) y cargarlas en cada ambiente: `HAJIME_VAPID_PUBLIC_KEY`
  y `HAJIME_VAPID_SUBJECT` como variables, `HAJIME_VAPID_PRIVATE_KEY` como
  **secreto** del Container App (y en Key Vault). Usa claves distintas en
  pruebas y producción y no las cambies después: cambiarlas invalida todas las
  suscripciones. *Comprobar:* `GET /api/v1/push/config` responde
  `enabled: true`, y en Chrome la campana de `/t/<slug>` pide permiso y llega
  un «te toca» al empezar combates.
- **Avisos en la app de Android:** necesitan un proyecto de Firebase y
  `google-services.json` (camino en `docs/avisos-push.md`, «Camino a FCM»).
- **App de Android en Google Play:** hoy CI y los releases generan un APK de
  depuración. Para la tienda hará falta una llave de firma (keystore) guardada
  como secreto del entorno `prod` y un paso que firme un AAB de release.
- **Separar permisos de la base:** hoy `hajime_app` puede cambiar el esquema
  (`db_ddladmin`) porque la app podía migrar al arrancar. Cuando todas las
  versiones en uso migren solo con el job, crear un usuario `hajime_migrar` con
  `db_ddladmin` para el job y dejar a `hajime_app` solo lectura y escritura.
