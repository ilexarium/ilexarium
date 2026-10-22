import { Pipe, type PipeTransform } from '@angular/core';
import { formatLogTime } from '../../../shared/format/format';

/** Pure: each line's time is formatted once, not on every batch. */
@Pipe({ name: 'logTime' })
export class LogTimePipe implements PipeTransform {
  transform(at: string): string {
    return formatLogTime(at);
  }
}
