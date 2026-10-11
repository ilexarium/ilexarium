import { Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis, lucideScrollText } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';

/**
 * A container's actions: a "⋯" button opening a menu. View logs for now; later actions (restart,
 * …) go here. Items are buttons, not links — the menu handles Enter itself and would cancel a
 * link's navigation.
 */
@Component({
  selector: 'app-container-actions',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon],
  providers: [provideIcons({ lucideEllipsis, lucideScrollText })],
  template: `
    <button
      hlmBtn
      variant="ghost"
      size="icon"
      [hlmDropdownMenuTrigger]="menu"
      align="end"
      [attr.aria-label]="'Actions for ' + name()"
    >
      <ng-icon name="lucideEllipsis" aria-hidden="true" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-44">
        <button hlmDropdownMenuItem (triggered)="viewLogs()">
          <ng-icon name="lucideScrollText" aria-hidden="true" />
          View logs
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class ContainerActions {
  readonly name = input.required<string>();
  private readonly router = inject(Router);

  protected viewLogs(): void {
    void this.router.navigate(['/containers', this.name(), 'logs']);
  }
}
