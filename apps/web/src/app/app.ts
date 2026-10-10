import { Component } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterOutlet } from '@angular/router';
import type { HealthResponse } from '@homelab/shared';
import { HlmButton } from '@ui/button';

@Component({
  imports: [RouterOutlet, HlmButton],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
}
