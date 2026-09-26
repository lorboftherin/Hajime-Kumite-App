// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
      // Estilo: `Array<T>` y `T[]` conviven en el código; no aporta seguridad.
      '@typescript-eslint/array-type': 'off',
      // `error: () => {}` en subscribe es intencional: el interceptor ya muestra
      // el error y el componente no tiene nada más que hacer.
      '@typescript-eslint/no-empty-function': 'off',
      // Deuda conocida (respuestas de la API sin tipar en pocos lugares): se
      // avisa sin bloquear CI; tipar al tocar cada archivo.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // `nav.tabs[inkTabs]` es una directiva de estilo sobre el <nav> de pestañas;
    // renombrarla a app* no aporta y obliga a tocar todas las plantillas.
    files: ['src/app/shared/ink-tabs.ts'],
    rules: { '@angular-eslint/directive-selector': 'off' },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // Los diálogos enfocan su primer campo a propósito (la mesa se opera con teclado).
      '@angular-eslint/template/no-autofocus': 'off',
      // Deuda de accesibilidad (fondos de modal y filas clicables sin teclado):
      // se avisa sin bloquear CI hasta corregirla.
      '@angular-eslint/template/interactive-supports-focus': 'warn',
      '@angular-eslint/template/click-events-have-key-events': 'warn',
    },
  },
]);
