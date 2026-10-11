import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { RealtimeService } from '../../core/realtime/realtime-service';
import { AppSidebar } from '../app-sidebar/app-sidebar';
import { TopBar } from '../top-bar/top-bar';

/** The signed-in layout: sidebar, then the top bar over the routed page. Opens the WebSocket. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, HlmSidebarImports, AppSidebar, TopBar],
  templateUrl: './shell.html',
})
export class Shell {
  constructor() {
    // Signed in from here on: open the app's WebSocket (closed again on sign-out).
    inject(RealtimeService).connect();
  }
}
