import type { z } from 'zod';

/** A DTO class that carries the Zod schema the global `ZodValidationPipe` validates it with. */
export interface ZodDtoClass<TSchema extends z.ZodType = z.ZodType> {
  new (): z.output<TSchema>;
  readonly schema: TSchema;
}
