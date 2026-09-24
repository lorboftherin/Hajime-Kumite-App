import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { DialogHost } from './shared/dialog-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DialogHost],
  template: `<router-outlet /><app-dialog-host />`,
})
export class App {
  constructor() {
    inject(AuthService).refreshMe();
  }
}
