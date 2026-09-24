import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { ThemeService } from './core/theme.service';
import { DialogHost } from './shared/dialog-host';
import { SessionGuard } from './shared/session-guard';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DialogHost, SessionGuard],
  template: `<router-outlet /><app-dialog-host /><app-session-guard />`,
})
export class App {
  constructor() {
    inject(ThemeService);
    inject(AuthService).refreshMe();
  }
}
