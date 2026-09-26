# Acciones que solo puede hacer el dueño

El código, CI y los scripts ya están listos; esto requiere permisos de dueño
en GitHub o en Azure. Hacerlo en este orden. Cada paso dice cómo comprobar que
quedó bien.

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
6. **Prettier:** cuando el paso de formateo final entre a `main` y
   `npm run format:check` pase, quitar `continue-on-error: true` del job
   `formato` en `.github/workflows/ci.yml` y agregarlo a los checks obligatorios.

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

## Más adelante

- **App de Android en Google Play:** hoy CI y los releases generan un APK de
  depuración. Para la tienda hará falta una llave de firma (keystore) guardada
  como secreto del entorno `prod` y un paso que firme un AAB de release.
- **Separar permisos de la base:** hoy `hajime_app` puede cambiar el esquema
  (`db_ddladmin`) porque la app podía migrar al arrancar. Cuando todas las
  versiones en uso migren solo con el job, crear un usuario `hajime_migrar` con
  `db_ddladmin` para el job y dejar a `hajime_app` solo lectura y escritura.
