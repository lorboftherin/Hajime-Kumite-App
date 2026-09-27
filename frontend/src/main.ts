import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { cargarIdioma } from './app/core/i18n/idioma';

// Las traducciones se cargan ANTES de arrancar: los textos con $localize se
// resuelven al crear cada componente (docs/idiomas.md). Si fallan, sigue en español.
cargarIdioma()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
