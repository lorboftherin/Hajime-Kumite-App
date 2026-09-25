# Publicar Hajime en Azure (paso a paso)

Guía para dejar Hajime en internet con su propia base de datos. Todo se hace
desde el navegador: no hace falta instalar nada.

```
Usuarios ──► Cloudflare (DNS y HTTPS) ──► Azure Container Apps (la app) ──► Azure SQL (los datos)
```

| Ambiente | Dirección | Base de datos | Costo esperado |
| --- | --- | --- | --- |
| **Pruebas (TEST)** | `https://hajime.lorboftherin.com` | Azure SQL gratis; se pausa sola sin uso | ~$0 al mes |
| **Producción (PROD)** | el `.com` propio (cuando se registre) | Azure SQL; siempre en línea | ~$30–80 al mes al lanzar |

## 1. Cuenta de Azure (una vez)

1. Crea la cuenta en <https://azure.microsoft.com/es-es/pricing/purchase-options/azure-account>
   («Probar Azure gratis»). País: **Perú**. La tarjeta es solo para verificar.
2. Opcional pero recomendado: en el portal busca **Presupuestos** y crea una
   alerta de $10 al mes. No es un pago: te avisa por correo si el gasto se acerca.

## 2. Token de GitHub

El repositorio es privado: Azure necesita un token de GitHub para descargar el
código y la imagen de la app.

1. <https://github.com/settings/tokens> → **Generate new token (classic)**.
2. Nombre: `azure-hajime`; permisos: **repo** y **read:packages**; vencimiento: 1 año.
3. Copia el token (empieza con `ghp_`): se usa en el paso 3 y no se vuelve a mostrar.
   No lo compartas ni lo pegues en ningún chat.

## 3. Crear el ambiente de pruebas

1. Entra a <https://portal.azure.com> y abre **Cloud Shell** (ícono `>_` arriba a
   la derecha) en modo **Bash**.
2. Descarga los scripts y crea el ambiente:

   ```bash
   git clone -b claude/gracious-feynman-qtapgx https://github.com/lorboftherin/Hajime-Kumite-App.git
   cd Hajime-Kumite-App/infra/azure
   bash crear-ambiente.sh test
   ```

   `git clone` pide tu usuario de GitHub y, como contraseña, el token del paso 2.
3. El script pide la clave que quieras para el usuario `admin` de Hajime, tu
   usuario de GitHub y otra vez el token.
   Tarda unos 10 minutos y al final imprime la dirección de la app y **dos
   registros DNS**.

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

Listo: <https://hajime.lorboftherin.com>. La primera visita del día puede tardar
cerca de un minuto (se despiertan la app y la base gratuita).

## 6. Publicación automática desde GitHub (opcional)

Para que cada cambio aprobado se publique solo en pruebas:

```bash
bash conectar-github.sh test claude/gracious-feynman-qtapgx
```

Copia los 4 valores que imprime en GitHub → **Settings** → **Secrets and
variables** → **Actions** → pestaña **Variables** → **New repository variable**.
No son claves secretas: GitHub se identifica ante Azure sin contraseñas (OIDC) y
solo puede tocar el grupo `hajime-test`.

## Producción (más adelante)

Igual que pruebas, con `bash crear-ambiente.sh prod`: la app queda siempre
encendida y la base sigue en línea aunque se agote la oferta gratuita (cobra el
excedente). El dominio será el `.com` propio. Antes de datos reales: revisar
`docs/modelo-negocio.md` (validación legal) y el checklist de `docs/despliegue.md`.

## Qué guarda Azure y dónde

- **Grupo de recursos `hajime-test`:** todo el ambiente. Borrarlo elimina todo
  (útil para empezar de cero en pruebas).
- **Secretos de la app** (conexión a la base, clave de sesiones, clave inicial
  del admin): en la configuración de la app, nunca en el código.
- **Backups:** Azure SQL guarda copias automáticas y permite restaurar a
  cualquier momento de los últimos 7 días.
