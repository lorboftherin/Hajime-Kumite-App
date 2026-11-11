# Publicar Hajime en Azure (paso a paso)

Guía para dejar Hajime en internet con su propia base de datos. Todo se hace
desde el navegador: no hace falta instalar nada. La lista corta de lo que solo
el dueño puede hacer está en [`acciones-del-duenio.md`](acciones-del-duenio.md).

```
Usuarios ──► Cloudflare (DNS) ──► Azure Container Apps (la app) ──► Azure SQL (los datos)
                                        ▲
GitHub: CI publica la imagen ───────────┘  pruebas: sola en cada cambio de main
                                           producción: a mano y con aprobación
```

| Ambiente | Dirección | Base de datos | App | Costo esperado |
| --- | --- | --- | --- | --- |
| **Pruebas (TEST)** | `https://hajime.lorboftherin.com` | Azure SQL gratis; se pausa sola sin uso | se apaga sin uso (0 réplicas) | ~$0 al mes |
| **Producción (PROD)** | el `.com` propio | Azure SQL **S0** (siempre en línea) | siempre encendida (1–3 réplicas) | ~$15 base + ~$15–40 app |

## Imágenes

CI publica en `ghcr.io/lorboftherin/hajime-kumite-app`:

| Etiqueta | Qué es | Uso |
| --- | --- | --- |
| `sha-1a2b3c4-azure` | cada commit que pasó CI (con driver de SQL Server) | lo que se despliega y se promueve |
| `azure` | lo último de `main` | imagen inicial de un ambiente nuevo |
| `0.2.0-azure`, `0.2-azure` | cada versión publicada (etiqueta `v0.2.0`) | producción por versión |
| `sha-…`, `latest`, `0.2.0` | variante con SQLite, sin driver | instalación local con Docker |

## 1. Cuenta de Azure (una vez)

1. Crea la cuenta en <https://azure.microsoft.com/es-es/pricing/purchase-options/azure-account>
   («Probar Azure gratis»). País: **Perú**. La tarjeta es solo para verificar.
2. La alerta de gasto se crea con el script (paso 3, `PRESUPUESTO_USD`) o a mano
   en el portal → **Presupuestos**. No es un pago: avisa por correo.
3. **La prueba gratuita dura 30 días.** Al vencer (o al agotar el crédito),
   Azure **deshabilita la suscripción** y suspende el entorno de Container
   Apps: la app deja de responder en el dominio y en la dirección directa con
   `ERR_CONNECTION_ABORTED` / «connection reset» antes del saludo TLS, y
   `az containerapp revision list` falla con `ManagedClusterSuspended … subscription
   has been disabled`. Se reconoce con `az account show --query state`
   (`Disabled`). Solo el dueño puede reactivarla: portal → Suscripciones →
   **Actualizar** a *Pago por uso* (ver `acciones-del-duenio.md`, sección
   «Urgente»). El nivel gratuito de 12 meses sigue vigente después.

## 2. Acceso a GitHub (el repositorio es privado)

Dos cosas distintas, con el mínimo permiso cada una:

- **Descargar los scripts (git clone):** token *fine-grained* en
  <https://github.com/settings/personal-access-tokens/new> → *Repository access*:
  solo `Hajime-Kumite-App` → *Permissions* → **Contents: Read-only**. Nada más.
  Vence en 30–90 días; se usa solo en Cloud Shell.
- **Descargar la imagen (Azure):** lo más simple y seguro es **hacer pública la
  imagen** (GitHub → tu perfil → *Packages* → `hajime-kumite-app` → *Package
  settings* → *Change visibility* → Public). La imagen no contiene secretos ni
  datos; así Azure no guarda ningún token. Si prefieres mantenerla privada:
  GHCR solo acepta tokens *classic*; crea uno con **solo `read:packages`**
  (sin `repo`) y dáselo al script cuando lo pida.

No compartas los tokens ni los pegues en ningún chat.

## 3. Crear (o actualizar) el ambiente de pruebas

1. Entra a <https://portal.azure.com> y abre **Cloud Shell** (ícono `>_` arriba a
   la derecha) en modo **Bash**.
2. Descarga los scripts y crea el ambiente:

   ```bash
   git clone https://github.com/lorboftherin/Hajime-Kumite-App.git
   cd Hajime-Kumite-App/infra/azure
   bash crear-ambiente.sh test
   ```

   `git clone` pide tu usuario de GitHub y, como contraseña, el token de
   *Contents: Read-only*. Si ya lo habías clonado: `git pull`.
3. La primera vez pide la clave inicial del usuario `admin` de Hajime y, si la
   imagen es privada, el usuario y el token `read:packages`. Tarda unos 10–15
   minutos: crea la base, el usuario de la app, el job de migraciones y la app,
   y espera a que responda sana. Al final imprime la dirección y **dos
   registros DNS**.

**Se puede repetir sin miedo.** Si la app ya existe, la actualiza (variables,
sondas de salud, escala) y **conserva** su dominio, certificado, imagen y
secretos; no pide la clave del admin otra vez. Para cambiar la clave de la base
y la de sesiones (todos vuelven a entrar): `bash crear-ambiente.sh test --rotar-secretos`.

Qué deja configurado:

- **Usuario propio de la app en la base** (`hajime_app`, con permisos de
  lectura, escritura y cambios de esquema). El administrador del servidor solo
  lo usan los scripts y su clave no se guarda en ningún lado.
- **Job de migraciones** `hajime-test-migrar`: el mismo contenedor con el
  comando `python -m app.prepare` (se cambia con `COMANDO_MIGRACION="…"`). La
  app arranca con `HAJIME_AUTO_CREATE_SCHEMA=false`: el esquema lo cambia solo
  el job, una vez, antes de cada versión.
- **Sondas de salud:** arranque y vida en `/health/live`, disponibilidad en
  `/health/ready` (base conectada y migrada). Una revisión que no queda lista
  no recibe tráfico.
- **Clave inicial del admin:** se borra de la app en cuanto arranca sana (el
  usuario `admin` ya quedó creado en la base).

## 4. Registros en Cloudflare

En <https://dash.cloudflare.com> → **lorboftherin.com** → **DNS** → **Registros** →
**Agregar registro**, crea los dos que imprimió el script:

| Tipo | Nombre | Contenido | Proxy |
| --- | --- | --- | --- |
| CNAME | `hajime` | `hajime-test.<…>.azurecontainerapps.io` | **Solo DNS** (nube gris) |
| TXT | `asuid.hajime` | código de verificación | — |

## 5. Conectar el dominio y el certificado HTTPS

De vuelta en Cloud Shell:

```bash
bash conectar-dominio.sh test hajime.lorboftherin.com
```

Si falla, hazlo desde el portal: tu app **hajime-test** → **Dominios
personalizados** → **Agregar dominio personalizado** → **Certificado
administrado** → escribe `hajime.lorboftherin.com` → **Validar** → **Agregar**.

La primera visita del día puede tardar cerca de un minuto (se despiertan la
app y la base gratuita).

## 6. Publicación automática en pruebas

Para que cada cambio que entra a `main` se publique solo en pruebas:

```bash
bash conectar-github.sh test main
```

Copia los 4 valores que imprime en GitHub → **Settings** → **Secrets and
variables** → **Actions** → pestaña **Variables** → **New repository variable**.
No son claves secretas: GitHub se identifica ante Azure sin contraseñas (OIDC) y
solo puede tocar el grupo `hajime-test`, y solo desde la rama `main`.

Cada push a `main`: CI prueba, publica `sha-xxxxxxx-azure`, corre las
migraciones con el job y crea una revisión nueva de `hajime-test`
(`infra/azure/promover.sh`).

## 7. Producción

### Crear el ambiente (una vez)

```bash
cd Hajime-Kumite-App/infra/azure && git pull
PRESUPUESTO_USD=60 PRESUPUESTO_CORREO=tu@correo.com bash crear-ambiente.sh prod
bash conectar-github.sh prod
```

Decisiones (variables antes del comando):

| Variable | Por defecto | Opciones |
| --- | --- | --- |
| `SQL_SKU` | `S0` (10 DTU, 250 GB, ~$15/mes, siempre en línea) | `S1` (~$30, más holgura en torneos grandes), `Basic` (~$5, 2 GB, 7 días de respaldo), `serverless` (paga por uso, **sin** autopausa) |
| `SQL_FIREWALL` | `azure` (acepta conexiones desde servicios de Azure) | `salida`: solo las IP de salida de la app; más estricto, pero si Azure cambia esas IP hay que volver a correr el script |
| `APP_INSIGHTS` | no | `1`: crea Application Insights y pasa `APPLICATIONINSIGHTS_CONNECTION_STRING` a la app |
| `PRESUPUESTO_USD` + `PRESUPUESTO_CORREO` | no | aviso al 80 % del gasto real y al 100 % del previsto |

Producción además queda con: mínimo 1 réplica (sin arranque en frío), base sin
autopausa, respaldos a cualquier punto de los **últimos 14 días** y retención
larga: **semanales por 8 semanas y mensuales por 12 meses**.

`conectar-github.sh prod` crea una identidad distinta de la de pruebas que solo
funciona desde el **entorno `prod` de GitHub**. Sigue las instrucciones que
imprime: crear el entorno `prod` con **aprobación obligatoria** y cargar sus 3
variables ahí (no en las del repositorio).

Luego conecta el dominio propio igual que en los pasos 4 y 5, con
`bash conectar-dominio.sh prod <dominio>`.

### Promover una versión

Producción **nunca** construye nada: recibe la misma imagen que ya pasó CI y
estuvo en pruebas.

1. GitHub → **Actions** → **Desplegar a producción** → **Run workflow**.
2. En «Qué desplegar» escribe el SHA corto que está en pruebas (lo muestra el
   resumen de CI: `sha-1a2b3c4-azure` → `1a2b3c4`) o una versión publicada
   (`0.2.0`).
3. Apruebas el despliegue (entorno `prod`). El workflow comprueba que la imagen
   exista, corre las migraciones con `hajime-prod-migrar`, crea la revisión
   nueva, espera `/health/ready` y hace una prueba de humo. **Si algo falla,
   vuelve solo a la revisión anterior.**

Lo mismo a mano, desde Cloud Shell: `bash promover.sh prod 1a2b3c4`.

### Volver atrás (rollback)

```bash
bash rollback.sh prod                            # lista las 10 últimas revisiones y vuelve a la anterior
bash rollback.sh prod hajime-prod--v0-2-0-101500  # o a una en particular
```

Vuelve la **app** (imagen, variables y escala de esa revisión) en uno o dos
minutos. **No vuelve la base:** por eso cada migración debe ser compatible con
la versión anterior (ver `CONTRIBUTING.md`). Si hiciera falta volver los datos,
ver «Respaldos».

## 8. Respaldos

Azure SQL guarda copias automáticas: cualquier punto de los últimos 7 días en
pruebas y 14 en producción, más las semanales y mensuales de producción.
Además, antes de cada torneo real:

```bash
bash respaldar.sh prod          # exporta un .bacpac a la cuenta hajimeprodbk… y lista los últimos
bash respaldar.sh prod --listar # solo lista
```

Los `.bacpac` quedan en una cuenta de almacenamiento propia del ambiente (la
crea el script) y se borran solos a los 180 días (`RETENCION_DIAS`). Para
descargar uno, el script imprime el comando.

**Ensayo de restauración** (una vez por temporada, y siempre antes del primer
torneo real): restaura la base de hace una hora en una base temporal, cuenta
usuarios, torneos y combates, informa cuánto tardó y la borra.

```bash
bash restaurar-prueba.sh prod        # hace 60 minutos
bash restaurar-prueba.sh prod 1440   # hace 24 horas
```

Restaurar de verdad (desastre): en el portal → base `hajime` → **Restaurar** →
punto en el tiempo → nombre nuevo (p. ej. `hajime-restaurada`); luego cambiar
el secreto `db-url` de la app para que apunte a esa base (o renombrarlas) y
reiniciar la revisión. Desde un `.bacpac`: `az sql db import`.

## Usuario de la base a mano (solo si el script avisó que no hay sqlcmd)

Cloud Shell trae `sqlcmd`, así que normalmente no hace falta. Si el script
avisó que la app usa el administrador: en el portal → base `hajime` → **Editor
de consultas** (entra con el administrador) y ejecuta, con una clave larga:

```sql
CREATE USER [hajime_app] WITH PASSWORD = N'<clave-larga-sin-comillas>';
ALTER ROLE db_datareader ADD MEMBER [hajime_app];
ALTER ROLE db_datawriter ADD MEMBER [hajime_app];
ALTER ROLE db_ddladmin ADD MEMBER [hajime_app];
```

y cambia el secreto `db-url` de la app y del job por
`mssql+pyodbc://hajime_app:<clave>@<servidor>.database.windows.net:1433/hajime?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no`.

## Qué guarda Azure y dónde

- **Grupo de recursos `hajime-<amb>`:** todo el ambiente. Borrarlo elimina todo
  (útil para empezar de cero en pruebas; **nunca** en producción).
- **Secretos de la app y del job** (conexión a la base, clave de sesiones,
  conexión de Application Insights): en su configuración, nunca en el código.
  La clave inicial del admin se borra tras el primer arranque.
- **Revisiones:** cada despliegue crea una (`hajime-prod--sha-1a2b3c4-…`); las
  anteriores quedan para el rollback.
- **Respaldos:** automáticos de Azure SQL y `.bacpac` en `hajime<amb>bk…`.

## Dejar que Claude Code corra comandos de Azure

`bash infra/azure/conectar-claude.sh` crea una identidad de aplicación con
permiso de Colaborador solo sobre los grupos `hajime-test` y `hajime-prod`, y
muestra cuatro variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_CLIENT_SECRET`) para pegar en el entorno de
Claude Code (claude.ai/code → botón de la nube → engranaje → *Environment
variables*), junto con los dominios que hay que permitir en *Network access*.
El secreto vence al año; se revoca con `az ad app delete`.
