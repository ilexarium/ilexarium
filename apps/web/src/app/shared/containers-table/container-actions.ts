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
  templateUrl: './container-actions.html',
})
export class ContainerActions {
  readonly name = input.required<string>();
  private readonly router = inject(Router);

  protected viewLogs(): void {
    void this.router.navigate(['/containers', this.name(), 'logs']);
  }
}
