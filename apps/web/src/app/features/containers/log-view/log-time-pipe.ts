import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Formatter } from '../../../shared/format/formatter';

/** Pure: each line's time is formatted once, not on every batch. */
@Pipe({ name: 'logTime' })
export class LogTimePipe implements PipeTransform {
  private readonly formatter = inject(Formatter);

  transform(at: string): string {
    return this.formatter.logTime(at);
  }
}
