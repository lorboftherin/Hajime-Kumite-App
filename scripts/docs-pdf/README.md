# PDF de la documentación

Genera `docs/pdf/Hajime-Manual-de-usuario.pdf` y `docs/pdf/Hajime-Documento-tecnico.pdf`
a partir de `docs/manual-de-usuario.md` y `docs/documento-tecnico.md`, con la marca
Hajime (portada, índice, diagramas Mermaid, capturas y número de página).

```bash
cd frontend && npm ci            # trae Playwright y su Chromium
cd ../scripts/docs-pdf && npm ci
npm run todo                     # o: npm run manual / npm run tecnico
```

Si Playwright no encuentra su Chromium, indica uno con `HAJIME_E2E_CHROMIUM=/ruta/a/chrome`.
Regenera los PDF cada vez que cambie el manual o el documento técnico.
