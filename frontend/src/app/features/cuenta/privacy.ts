import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Enso, HajimeWord } from '../../shared/enso';

/**
 * Privacidad: qué datos se muestran y a quién (Ley 29733). Texto provisional,
 * pendiente de validación legal (docs/modelo-negocio.md, «Decisiones abiertas»).
 */
@Component({
  selector: 'app-privacy',
  imports: [RouterLink, Enso, HajimeWord],
  template: `
    <div class="page">
      <header class="top">
        <a i18n-aria-label="@@privacidad.hajime" class="brand" routerLink="/login" aria-label="Hajime"
          ><app-enso class="mark" /><app-hajime-word class="word"
        /></a>
      </header>
      <article class="card doc">
        <h1 i18n="@@privacidad.privacidad">Privacidad</h1>
        <div i18n="@@privacidad.texto-provisional-pendiente" class="alert warn" role="note">
          <strong>Texto provisional, pendiente de validación legal.</strong> Describe cómo funciona
          hoy Hajime; la política definitiva se publicará tras revisarla con un especialista en la
          Ley 29733.
        </div>

        <h2 i18n="@@privacidad.datos-guardamos">Qué datos guardamos</h2>
        <p i18n="@@privacidad.competidor-nombre-fecha">
          Del competidor: nombre, fecha de nacimiento, sexo, documento de identidad, dojo, grado,
          categorías, combates y resultados. De las cuentas: nombre visible, usuario, correo y
          contraseña (cifrada; nadie puede leerla).
        </p>

        <h2 i18n="@@privacidad.quien-ve">Quién ve qué</h2>
        <table class="table small">
          <thead>
            <tr>
              <th i18n="@@privacidad.quien">Quién</th>
              <th i18n="@@privacidad.ve">Qué ve</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td i18n="@@privacidad.publico-sin-cuenta">Público, sin cuenta</td>
              <td i18n="@@privacidad.resultados-llaves-medallero">
                Resultados, llaves, medallero y el perfil básico: nombre (abreviado si es menor, p.
                ej. «Diego R.»), dojo, medallas y torneos ya disputados.
              </td>
            </tr>
            <tr>
              <td i18n="@@privacidad.propia-persona-adulta-perfil">La propia persona adulta (perfil reclamado)</td>
              <td i18n="@@privacidad.historial-completo-combates">Su historial completo, combates, estadísticas e insignias.</td>
            </tr>
            <tr>
              <td i18n="@@privacidad.padre-madre-apoderado-perfil">Padre, madre o apoderado (perfil del menor reclamado y aprobado)</td>
              <td i18n="@@privacidad.historial-completo-menor-rivales">
                El historial completo del menor. De los rivales, solo el nombre abreviado y su dojo.
              </td>
            </tr>
            <tr>
              <td i18n="@@privacidad.dojo-competidor">El dojo del competidor</td>
              <td i18n="@@privacidad.resultados-competidores-cada">
                Los resultados de sus competidores en cada torneo y las solicitudes para reclamar
                sus perfiles.
              </td>
            </tr>
            <tr>
              <td i18n="@@privacidad.organizadores-administracion">Organizadores y administración</td>
              <td i18n="@@privacidad.datos-necesarios-para-organizar">
                Los datos necesarios para organizar el torneo, incluidos documento y fecha de
                nacimiento.
              </td>
            </tr>
          </tbody>
        </table>
        <p i18n="@@privacidad.documento-fecha-nacimiento-nunca">
          <strong>El documento y la fecha de nacimiento nunca se muestran</strong> fuera de la
          organización y del dojo. Ninguna cuenta, gratuita o de pago, da acceso a los datos de
          menores ajenos.
        </p>

        <h2 i18n="@@privacidad.menores-edad">Menores de edad</h2>
        <p i18n="@@privacidad.cuentas-son-adultos-perfil-menor">
          Las cuentas son de adultos. El perfil de un menor lo reclama su padre, madre o apoderado y
          lo aprueba su dojo o la organización. Al hacerlo, el adulto autoriza la publicación de los
          resultados deportivos del menor y el uso de sus datos en estadísticas. Esa autorización
          queda registrada.
        </p>

        <h2 i18n="@@privacidad.correo">Correo</h2>
        <p i18n="@@privacidad.usamos-correo-solo-para-cuenta">
          Usamos el correo solo para la cuenta: confirmarlo, recuperar la contraseña y avisar sobre
          las solicitudes de perfil. No lo mostramos a otras personas, salvo a quien revisa una
          solicitud tuya.
        </p>

        <h2 i18n="@@privacidad.avisos-dispositivo">Avisos en el dispositivo</h2>
        <p i18n="@@privacidad.si-activas-avisos-avisarme">
          Si activas los avisos («Avisarme»), guardamos la dirección de avisos de tu navegador y a
          quién sigues en ese dispositivo. Los favoritos de la página pública se borran al terminar
          el torneo. Los avisos usan el nombre abreviado de los menores, como la página pública, y
          puedes desactivarlos en «Avisos».
        </p>

        <h2 i18n="@@privacidad.tus-derechos">Tus derechos</h2>
        <p i18n="@@privacidad.puedes-borrar-cuenta-desde">
          Puedes borrar tu cuenta desde «Borrar mi cuenta». Para corregir o eliminar datos de un
          competidor (acceso, rectificación, cancelación u oposición), pídeselo a la organización
          del torneo o a tu dojo.
        </p>
      </article>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100vh;
      background: var(--washi);
    }
    .page {
      max-width: 820px;
      margin: 0 auto;
      padding: 1.25rem 1rem 3rem;
    }
    .top .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      color: var(--sumi);
      text-decoration: none;
      margin-bottom: 1.5rem;
      .mark {
        width: 2.2rem;
        height: 2.2rem;
      }
      .word {
        height: 1.5rem;
        margin-top: 0.4rem;
      }
    }
    .doc {
      h1 {
        font-family: var(--font-display);
        margin-top: 0;
      }
      h2 {
        font-size: var(--fs-20);
        margin: 1.5rem 0 0.5rem;
      }
      p {
        line-height: 1.65;
      }
    }
    .table td:first-child {
      font-weight: 600;
      white-space: normal;
      min-width: 10rem;
    }
  `,
})
export class PrivacyPage {}
