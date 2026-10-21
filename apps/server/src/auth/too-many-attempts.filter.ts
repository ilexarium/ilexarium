import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { TooManyAttemptsException } from './login-throttle.service.js';

/** The `Retry-After` header, so the form can say how long to wait. */
@Catch(TooManyAttemptsException)
export class TooManyAttemptsFilter implements ExceptionFilter {
  catch(exception: TooManyAttemptsException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .setHeader('Retry-After', String(exception.retryAfterSeconds))
      .json(exception.getResponse());
  }
}
