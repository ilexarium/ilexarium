import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ApiErrorResponse, FieldError } from '@laris/shared';
import type { z } from 'zod';
import { isZodDto } from './zod-dto.js';

/** Issue properties that are never sent back: `input` holds what the user typed (maybe a password). */
const OMITTED_ISSUE_KEYS = new Set(['code', 'path', 'message', 'input']);

function toFieldError(issue: z.core.$ZodIssue): FieldError {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    if (OMITTED_ISSUE_KEYS.has(key)) continue;
    params[key] = value instanceof RegExp ? value.source : value;
  }
  return {
    field: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
    ...(Object.keys(params).length > 0 && { params }),
  };
}

export function toValidationErrorResponse(error: z.ZodError): ApiErrorResponse {
  return { message: 'Validation failed', errors: error.issues.map(toFieldError) };
}

/**
 * Global pipe: validates every `@Body()`, `@Query()` and `@Param()` whose type is a `zodDto`
 * class and hands the controller the **parsed** value. Other parameters pass through untouched.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, { metatype }: ArgumentMetadata): unknown {
    if (!isZodDto(metatype)) return value;
    const result = metatype.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException(toValidationErrorResponse(result.error));
  }
}
