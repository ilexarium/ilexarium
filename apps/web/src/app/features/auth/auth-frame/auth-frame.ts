import { Component, input } from '@angular/core';
import { HlmCardImports } from '@ui/card';

/** The centred card the signed-out pages (login, setup) sit in. */
@Component({
  selector: 'app-auth-frame',
  imports: [HlmCardImports],
  host: { class: 'flex min-h-svh items-center justify-center bg-muted/40 p-4' },
  template: `
    <main hlmCard class="w-full max-w-sm">
      <div hlmCardHeader>
        <h1 hlmCardTitle class="text-xl">{{ heading() }}</h1>
        <p hlmCardDescription>{{ description() }}</p>
      </div>
      <div hlmCardContent><ng-content /></div>
    </main>
  `,
})
export class AuthFrame {
  readonly heading = input.required<string>();
  readonly description = input.required<string>();
}
