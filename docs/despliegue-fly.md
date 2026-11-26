# Despliegue en Fly.io

Desde noviembre de 2026 el ambiente de pruebas corre en **Fly.io** en vez de
Azure (Azure deshabilitó la suscripción de prueba y apagó todo). Es el mismo
contenedor «todo en uno» del `Dockerfile`, con la base **SQLite** y el secreto
de sesiones en un disco persistente. Una sola máquina en São Paulo (`gru`),
que se apaga sin uso y arranca sola con la primera visita (unos segundos).

| Qué           | Dónde                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| App           | `hajime-test` → https://hajime-test.fly.dev                                           |
| Configuración | `fly.toml` (raíz del repositorio)                                                     |
| Base de datos | `/data/hajime.db` en el volumen `hajime_data` (1 GB, con instantáneas diarias de Fly) |
| Secretos      | `HAJIME_ADMIN_PASSWORD` (clave inicial del admin; se usa solo si no hay usuarios)     |
| Dominio       | `hajime.lorboftherin.com` (CNAME en Cloudflare, nube gris; certificado de Fly)        |
| Costo         | ~3–5 USD/mes (máquina compartida 1 CPU / 1 GB + disco)                                |

## Operación con `flyctl`

```bash
curl -L https://fly.io/install.sh | sh        # instalar
fly auth login                                 # entrar (cuenta de Fly.io)
fly status -a hajime-test                      # estado de la máquina
fly logs -a hajime-test                        # registros en vivo
fly deploy --ha=false                          # desplegar lo que hay en el directorio
fly deploy --ha=false --image registry.fly.io/hajime-test:sha-XXXXXXX   # una imagen ya construida
fly ssh console -a hajime-test                 # consola dentro de la máquina
fly ssh console -a hajime-test -C "python -m app.seed admin --username admin --force"  # cambiar la clave del admin
fly volumes snapshots list hajime_data -a hajime-test   # respaldos del disco
```

`--ha=false` es obligatorio: el disco pertenece a una máquina; con dos, cada
una tendría su propia base.

## Despliegue automático desde GitHub

El job `deploy-fly` de `.github/workflows/ci.yml` sube la imagen SQLite que CI
ya construyó al registro de Fly y despliega. Solo necesita el secreto; las
variables son opcionales (por defecto la app `hajime-test` y la rama de
pruebas escrita en el workflow):

| Dónde                                                    | Nombre          | Valor                                                                                                                                                      |
| -------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings → Secrets and variables → Actions → **Secrets** | `FLY_API_TOKEN` | Token de despliegue: en https://fly.io/dashboard → _Tokens_ → _Create deploy token_ para la app `hajime-test`, o `fly tokens create deploy -a hajime-test` |
| → **Variables** (opcional)                               | `FLY_APP`       | Otra app de Fly (por defecto `hajime-test`)                                                                                                                |
| → **Variables** (opcional)                               | `FLY_BRANCH`    | Otra rama a desplegar en pruebas                                                                                                                           |

## Dominio propio

```bash
fly certs add hajime.lorboftherin.com -a hajime-test
fly certs show hajime.lorboftherin.com -a hajime-test   # qué registros DNS pide y el estado
```

En Cloudflare (lorboftherin.com → DNS): registro `hajime` tipo **CNAME** a
`hajime-test.fly.dev`, **nube gris** (DNS only), y el registro de verificación
`_acme-challenge.hajime` que muestre `fly certs show`. El certificado se emite
en minutos y se renueva solo.

## Clave inicial del admin

Al primer arranque, si no hay usuarios, se crea `admin` con la clave del
secreto `HAJIME_ADMIN_PASSWORD`. Cámbiala al entrar (menú de usuario →
Cambiar contraseña). Para fijar otra desde fuera:
`fly secrets set HAJIME_ADMIN_PASSWORD=... -a hajime-test` solo sirve antes
del primer arranque; después, usa `fly ssh console` con `app.seed admin --force`.

## Producción y escala: base en Neon (en espera)

Decisión de noviembre de 2026: se queda SQLite en el disco de Fly mientras la
app se use en torneos propios. Antes de abrirla a otros organizadores, o al
necesitar más de una máquina, la base pasa a **Neon** (Postgres administrado),
y Fly sigue corriendo la app.

| Qué se gana       | Respaldo continuo con restauración a cualquier minuto, copias de la base en segundos para ensayar, varias máquinas de la app a la vez, mismo proveedor que las otras apps                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qué hay que hacer | Driver de Postgres (`psycopg`) en `pyproject.toml` y lockfiles, CI con un servicio Postgres que corra pruebas y `alembic check`, migrar los datos de SQLite, `HAJIME_DATABASE_URL` como secreto de Fly, `--ha` según haga falta |
| Región            | Neon en São Paulo (`aws-sa-east-1`), junto a la máquina de Fly en `gru`                                                                                                                                                         |
| Cuidado           | En el plan gratis Neon suspende la base tras unos minutos sin uso (arranque < 1 s); la mesa lo tolera porque reenvía los eventos en cola                                                                                        |

Estimado: un día de trabajo. Lo específico de SQL Server en el código
(`with_variant(..., "mssql")`) no afecta a Postgres. Los scripts de Azure en
`infra/azure/` quedan como referencia histórica.
