import { Component, input } from '@angular/core';
import { HlmCardImports } from '@ui/card';
import { APP_NAME } from '../../../core/page-title/page-title';
import { LarisMark } from '../../../shared/brand/laris-mark';

@Component({
  selector: 'app-auth-frame',
  imports: [HlmCardImports, LarisMark],
  host: { class: 'flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4' },
  templateUrl: './auth-frame.html',
})
export class AuthFrame {
  readonly heading = input.required<string>();
  readonly description = input.required<string>();
  protected readonly appName = APP_NAME;
}
