import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideLock } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmTableImports } from '@ui/table';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import { ServiceActions } from '../service-actions/service-actions';
import type { ServiceActionRequest, ServiceRow } from '../system-services.model';

/** The services: a table on wide screens, cards on phones. UI only: intent goes out. */
@Component({
  selector: 'ilex-service-list',
  imports: [HlmTableImports, NgIcon, NgTemplateOutlet, ServiceActions, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideLoaderCircle, lucideLock })],
  templateUrl: './service-list.html',
})
export class ServiceList {
  readonly rows = input.required<ServiceRow[]>();
  readonly action = output<ServiceActionRequest>();
  readonly open = output<string>();
}
