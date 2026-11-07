## Qué cambia y por qué

<!-- Una o dos frases. Enlaza el issue o la sección del plan si existe. -->

## Cómo se probó

<!-- Pruebas automáticas nuevas, pasos manuales, capturas si cambia la interfaz. -->

## Lista de control

- [ ] CI en verde (backend, contratos, frontend, auditoría, Docker).
- [ ] Si cambió el modelo: migración de Alembic **compatible hacia atrás**,
      `sql/001_schema.sql` regenerado.
- [ ] Si cambió la API: `docs/openapi.json` regenerado; clientes con eventos en
      cola (mesa sin red) siguen funcionando.
- [ ] Si toca la mesa: probado con la red cortada y al volver.
- [ ] `CHANGELOG.md` → `## [Sin publicar]` actualizado.
- [ ] Sin secretos ni datos reales en el código, las pruebas o las capturas.
- [ ] Textos, comentarios y commits en español.

## Despliegue

<!-- ¿Necesita algo además de la imagen? (variable nueva, paso manual en Azure,
     migración larga, orden especial). Si no, «nada especial». -->
