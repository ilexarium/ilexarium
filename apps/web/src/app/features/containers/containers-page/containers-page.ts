import {
  afterNextRender,
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  Injector,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { HlmButton } from '@ui/button';
import { ContainersTable } from '../containers-table/containers-table';
import { FreeSpace } from '../free-space/free-space';
import { ContainersPageStore } from './containers-page-store';

@Component({
  selector: 'laris-containers-page',
  imports: [ContainersTable, FreeSpace, HlmButton, PluralPipe, RouterLink, TranslatePipe],
  providers: [ContainersPageStore],
  templateUrl: './containers-page.html',
})
export class ContainersPage {
  protected readonly store = inject(ContainersPageStore);
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment);
  private readonly cardShown = computed(() => this.store.cleanup() !== null);

  constructor() {
    // `#free-space` (the disk-full alert, the dashboard): the card appears only once its data
    // is in, after the router's own anchor scrolling would have looked for it.
    const document = inject(DOCUMENT);
    const injector = inject(Injector);
    effect(() => {
      if (this.fragment() !== 'free-space' || !this.cardShown()) return;
      afterNextRender(() => document.getElementById('free-space')?.scrollIntoView(), { injector });
    });
  }
}
