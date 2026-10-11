import { Component } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { HealthResponse } from '@homelab/shared';
import { HlmButton } from '@ui/button';

@Component({
  selector: 'app-dashboard-page',
  imports: [HlmButton],
  template: `
    <h1 class="text-2xl font-semibold">Dashboard</h1>
    <section class="mt-6 flex items-center gap-4 rounded-lg border p-4">
      <span class="text-sm text-muted-foreground">Server</span>
      @if (health.isLoading()) {
        <span class="text-sm">Checking…</span>
      } @else if (health.error()) {
        <span class="text-sm text-destructive">Unreachable</span>
      } @else if (health.value(); as h) {
        <span class="text-sm">{{ h.status }} · v{{ h.version }} · up {{ h.uptimeSeconds }}s</span>
      }
      <button hlmBtn variant="outline" size="sm" class="ml-auto" (click)="health.reload()">
        Refresh
      </button>
    </section>
  `,
})
export class DashboardPage {
  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
}
