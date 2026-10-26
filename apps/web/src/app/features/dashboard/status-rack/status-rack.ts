import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { HostInfo } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideHardDrive, lucideLayoutGrid, lucideServer } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { LIGHT_CLASSES, LIGHT_WORD_CLASSES, RACK_ICONS } from '../dashboard.constants';
import type { RackUnit } from '../dashboard.model';
import { TextPipe } from '../text-pipe';

/**
 * The status rack, built like Laris's logo: three short units (apps, backups, space), each with
 * its light at the end, over a long one for the server itself. What goes in the L's corner (the
 * metric tiles) is projected.
 */
@Component({
  selector: 'laris-status-rack',
  imports: [NgIcon, RouterLink, TextPipe, TranslatePipe],
  providers: [provideIcons({ lucideArchive, lucideHardDrive, lucideLayoutGrid, lucideServer })],
  host: { class: 'block' },
  templateUrl: './status-rack.html',
})
export class StatusRack {
  readonly units = input.required<RackUnit[]>();
  readonly host = input.required<HostInfo>();
  readonly uptimeSeconds = input.required<number>();
  readonly memoryBytes = input.required<number>();
  /** The realtime connection is up: the server's light pulses with each sample. */
  readonly live = input.required<boolean>();

  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly icons = RACK_ICONS;
  protected readonly lightClasses = LIGHT_CLASSES;
  protected readonly wordClasses = LIGHT_WORD_CLASSES;

  protected readonly details = computed(() => {
    const { os, arch, cpuCores } = this.host();
    return [
      os,
      arch,
      this.translator.plural('dashboard.rack.server.cores', cpuCores),
      this.translator.t('dashboard.rack.server.memory', {
        size: this.formatter.bytes(this.memoryBytes()),
      }),
    ].join(' · ');
  });

  protected readonly uptime = computed(() =>
    this.translator.t('dashboard.rack.server.up', {
      duration: this.formatter.duration(this.uptimeSeconds()),
    }),
  );
}
