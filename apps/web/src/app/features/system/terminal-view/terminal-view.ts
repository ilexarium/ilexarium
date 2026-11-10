import {
  afterNextRender,
  Component,
  DestroyRef,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowLeft,
  lucideArrowRight,
  lucideArrowUp,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { TerminalSize } from '../terminal.model';
import { loadTerminalFonts } from './terminal-fonts';
import {
  DARK,
  KEYS,
  LIGHT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from './terminal-view.constants';

/** A key typed with Ctrl as the terminal sends it (Ctrl+C: \x03), or null if it has none. */
export function controlCharacter(key: string): string | null {
  if (key.length !== 1 || !/[a-z@[\\\]^_]/i.test(key)) return null;
  return String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f);
}

/**
 * The terminal itself (xterm.js): shows what the page writes, sends what's typed out through
 * `data`, fits its box and reports its size (`ready` once, then `resized`). Text only, always
 * left to right; a key bar on phones (Esc, Tab, Ctrl, arrows). Presentational.
 */
@Component({
  selector: 'ilex-terminal-view',
  imports: [HlmButton, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideArrowDown, lucideArrowLeft, lucideArrowRight, lucideArrowUp })],
  templateUrl: './terminal-view.html',
  styleUrl: './terminal-view.css',
  // xterm builds its own DOM: its stylesheet must reach it unscoped.
  encapsulation: ViewEncapsulation.None,
  host: { class: 'flex min-h-0 flex-1 flex-col gap-2' },
})
export class TerminalView {
  readonly dark = input(false);
  readonly ready = output<TerminalSize>();
  readonly resized = output<TerminalSize>();
  readonly data = output<string>();

  protected readonly keys = KEYS;
  /** The next key is sent with Ctrl (the phone key bar). */
  protected readonly ctrl = signal(false);
  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');
  private terminal: Terminal | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const document = inject(DOCUMENT);
    let destroyed = false;
    destroyRef.onDestroy(() => (destroyed = true));
    afterNextRender(async () => {
      await loadTerminalFonts(document);
      if (destroyed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        fontWeightBold: 600,
        scrollback: 5000,
        theme: this.dark() ? DARK : LIGHT,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(this.box().nativeElement);
      fit.fit();
      terminal.onData((data) => this.send(data));
      terminal.onResize(({ cols, rows }) => this.resized.emit({ cols, rows }));
      // Fitting changes the box's contents: on the next frame, not inside the observer's callback.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fit.fit());
      });
      observer.observe(this.box().nativeElement);
      this.terminal = terminal;
      terminal.focus();
      this.ready.emit({ cols: terminal.cols, rows: terminal.rows });
      destroyRef.onDestroy(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        terminal.dispose();
      });
    });
    effect(() => {
      const theme = this.dark() ? DARK : LIGHT;
      if (this.terminal) this.terminal.options.theme = theme;
    });
  }

  focus(): void {
    this.terminal?.focus();
  }

  /** The shell's output. */
  write(bytes: Uint8Array): void {
    this.terminal?.write(bytes);
  }

  protected key(sequence: string): void {
    this.data.emit(sequence);
    this.terminal?.focus();
  }

  protected toggleCtrl(): void {
    this.ctrl.update((on) => !on);
    this.terminal?.focus();
  }

  /** Typed text — with Ctrl from the key bar, as its control character. */
  private send(data: string): void {
    const control = this.ctrl() ? controlCharacter(data) : null;
    if (control) this.ctrl.set(false);
    this.data.emit(control ?? data);
  }
}
