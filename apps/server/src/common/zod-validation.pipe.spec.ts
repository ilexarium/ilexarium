import { BadRequestException } from '@nestjs/common';
import { apiErrorResponseSchema, loginRequestSchema } from '@laris/shared';
import { z } from 'zod';
import { isZodDto, zodDto } from './zod-dto.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

class LoginDto extends zodDto(loginRequestSchema) {}
class PlainDto {}

const pipe = new ZodValidationPipe();
const asBody = (metatype: unknown) => ({ type: 'body' as const, metatype: metatype as never });

function rejectionOf(value: unknown, metatype: unknown = LoginDto) {
  try {
    pipe.transform(value, asBody(metatype));
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error('expected the pipe to reject');
}

describe('zodDto', () => {
  it('carries its schema and is recognised', () => {
    expect(LoginDto.schema).toBe(loginRequestSchema);
    expect(isZodDto(LoginDto)).toBe(true);
  });

  it('does not recognise other classes and values', () => {
    for (const value of [PlainDto, String, Object, undefined, null, 'LoginDto']) {
      expect(isZodDto(value)).toBe(false);
    }
  });
});

describe('ZodValidationPipe', () => {
  it('returns the parsed value, not the raw input', () => {
    expect(pipe.transform({ username: ' Owner ', password: 'x' }, asBody(LoginDto))).toEqual({
      username: 'owner',
      password: 'x',
    });
  });

  it('passes non-zodDto parameters through untouched', () => {
    const value = { anything: true };
    expect(pipe.transform(value, asBody(PlainDto))).toBe(value);
    expect(pipe.transform('42', asBody(String))).toBe('42');
  });

  it('rejects with the shared API error shape and field errors', () => {
    const response = rejectionOf({ username: '', password: 'x' });
    expect(apiErrorResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({
      message: 'Validation failed',
      errors: [{ field: 'username', code: 'too_small', params: { minimum: 1 } }],
    });
  });

  it('never echoes submitted values', () => {
    const secret = 'correct-horse-battery-staple'.repeat(10); // over the max length
    const response = rejectionOf({ username: 'owner', password: secret, extra: secret });
    expect(JSON.stringify(response)).not.toContain('correct-horse');
  });

  it('reports unknown fields by name', () => {
    const response = rejectionOf({ username: 'owner', password: 'x', admin: true });
    expect(response).toMatchObject({
      errors: [{ code: 'unrecognized_keys', params: { keys: ['admin'] } }],
    });
  });

  it('serialises regex parameters as their source', () => {
    class PatternDto extends zodDto(z.object({ code: z.string().regex(/^[a-z]+$/) })) {}
    const response = rejectionOf({ code: '123' }, PatternDto);
    expect(JSON.stringify(response)).toContain('^[a-z]+$');
  });

  it('rejects a missing body', () => {
    expect(rejectionOf(undefined)).toMatchObject({ message: 'Validation failed' });
  });
});
