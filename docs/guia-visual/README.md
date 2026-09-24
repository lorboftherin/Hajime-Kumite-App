# Guía visual de Hajime

Página que explica qué está construido y cómo se usa, con las capturas de
`docs/screenshots/`. Publicada en: https://claude.ai/artifact/QV3ehfhdY15sMz7D1VQ8Mc

Para regenerarla tras renovar las capturas:

```bash
cd docs/guia-visual
../../backend/.venv/bin/pip install pymupdf   # una vez
../../backend/.venv/bin/python build.py       # crea guia-hajime.html e img/
```

- `guia.template.html`: diseño y textos de la página.
- `build.py`: pasos del recorrido y galería; convierte las capturas a JPEG.
- `pins.json`: anotaciones de la mesa (posición en % sobre cada captura).
