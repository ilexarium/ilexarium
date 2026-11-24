import { Component, inject } from '@angular/core';
import { UpdatesStore } from '../../core/updates/updates-store';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { BackupsStore } from '../../core/backups/backups-store';
import { LinuxSessionStore } from '../../core/linux/linux-session-store';
import { MonitoringStore } from '../../core/monitoring/monitoring-store';
import { RealtimeService } from '../../core/realtime/realtime-service';
import { AppSidebar } from '../app-sidebar/app-sidebar';
import { SignInPrompt } from '../sign-in-prompt/sign-in-prompt';
import { SudoDialog } from '../sudo-dialog/sudo-dialog';
import { TopBar } from '../top-bar/top-bar';
import { UploadsPanel } from '../uploads-panel/uploads-panel';

/**
 * The signed-in layout: sidebar, then the top bar over the routed page, and the sudo password
 * prompt any page's action may need, and the uploads panel (uploads go on from page to page). Opens the WebSocket and follows the backups' status and the
 * alerts for the whole session (the navigation's badge, the bell, the dashboard).
 */
@Component({
  selector: 'ilex-shell',
  imports: [
    RouterOutlet,
    HlmSidebarImports,
    AppSidebar,
    SignInPrompt,
    SudoDialog,
    TopBar,
    UploadsPanel,
  ],
  templateUrl: './shell.html',
})
export class Shell {
  constructor() {
    // Signed in from here on: open the app's WebSocket (closed again on sign-out).
    inject(RealtimeService).connect();
    // Closed with the socket on sign-out; the store resets itself then.
    inject(BackupsStore).watch();
    // The open alerts: the bell in the top bar, the dashboard notice.
    inject(AlertsStore).watch();
    // Ilexarium's own updates: the badge, the dashboard's line, the reload after an update.
    inject(UpdatesStore).watch();
    // The machine's kernel, for the top bar's status.
    inject(MonitoringStore).loadHost();
    // A Linux session still open (a reload): the top bar shows it.
    inject(LinuxSessionStore).check();
  }
}
