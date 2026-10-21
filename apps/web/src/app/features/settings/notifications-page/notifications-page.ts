import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSkeleton } from '@ui/skeleton';
import { EmailForm } from '../email-form/email-form';
import { NtfyForm } from '../ntfy-form/ntfy-form';
import { NotificationsPageStore } from './notifications-page-store';

/**
 * Settings → Notifications (docs/plans/health_alerts.md): alerts by email and by ntfy, each
 * switched on or off, with a test button each and the last delivery problem.
 */
@Component({
  selector: 'laris-notifications-page',
  imports: [EmailForm, HlmSkeleton, NtfyForm, TranslatePipe],
  providers: [NotificationsPageStore],
  templateUrl: './notifications-page.html',
})
export class NotificationsPage {
  protected readonly store = inject(NotificationsPageStore);
}
