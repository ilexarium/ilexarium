import type { z } from 'zod';

/** A DTO class that carries the Zod schema the global `ZodValidationPipe` validates it with. */
export interface ZodDtoClass<TSchema extends z.ZodType = z.ZodType> {
  new (): z.output<TSchema>;
  readonly schema: TSchema;
}

/**
 * Turns a shared Zod schema into a DTO class for controller parameters:
 *
 * ```ts
 * export class LoginDto extends zodDto(loginRequestSchema) {}
 * login(@Body() body: LoginDto) { … } // validated and typed as the schema's output
 * ```
 */
export function zodDto<TSchema extends z.ZodType>(schema: TSchema): ZodDtoClass<TSchema> {
  class ZodDto {
    static readonly schema = schema;
  }
  return ZodDto as unknown as ZodDtoClass<TSchema>;
}

export function isZodDto(metatype: unknown): metatype is ZodDtoClass {
  if (typeof metatype !== 'function' || !('schema' in metatype)) return false;
  const { schema } = metatype as { schema: unknown };
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}
