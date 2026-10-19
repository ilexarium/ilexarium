import { describe, expect, it } from 'vitest';
import { AI_LIMITS, chatSendSchema, isHfIdPart, modelNameSchema } from './ai.js';
import { VALIDATION_LIMITS } from './auth.js';

describe('modelNameSchema', () => {
  it.each([
    'llama3.2:3b',
    'smollm2:135m',
    'qwen2.5',
    'library/llama3.2:latest',
    'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M',
    'huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF',
  ])('accepts %s', (name) => expect(modelNameSchema.safeParse(name).success).toBe(true));

  it.each([
    ['empty', ''],
    ['a space', 'llama 3'],
    ['a path out', '../etc:1'],
    ['dots inside', 'a/../b'],
    ['a leading slash', '/llama3'],
    ['too many parts', 'a/b/c/d'],
    ['a URL', 'https://example.com/x'],
    ['shell characters', 'llama3;rm'],
    ['another registry host', 'registry.example.com/library/llama3:1b'],
    ['a host on the home network', '192.168.1.10/x/y:1'],
    ['localhost as a host', 'localhost/x/y'],
    ['too long', 'a'.repeat(AI_LIMITS.modelNameMax + 1)],
  ])('refuses %s', (_, name) => expect(modelNameSchema.safeParse(name).success).toBe(false));
});

describe('isHfIdPart', () => {
  it('accepts owners and repositories as Hugging Face names them', () => {
    expect(isHfIdPart('bartowski')).toBe(true);
    expect(isHfIdPart('SmolLM2-135M-Instruct-GGUF')).toBe(true);
  });

  it.each(['', '..', 'a..b', '.hidden', 'a/b', 'a b', 'a?b', 'x'.repeat(97)])(
    'refuses %j',
    (part) => expect(isHfIdPart(part)).toBe(false),
  );
});

describe('chatSendSchema', () => {
  const send = (content: string) =>
    chatSendSchema.safeParse({ chatId: null, model: 'llama3.2:3b', content });

  it('takes a message up to the limit, trimmed', () => {
    expect(send(' hi ').data?.content).toBe('hi');
    expect(send('x'.repeat(AI_LIMITS.messageMax)).success).toBe(true);
  });

  it('refuses an empty or too long message, with words the form can show', () => {
    expect(send('   ').error?.issues[0].message).toBe('validation.messageRequired');
    expect(send('x'.repeat(AI_LIMITS.messageMax + 1)).error?.issues[0].message).toBe(
      'validation.messageTooLong',
    );
  });

  it('has the limit the form words come from', () => {
    expect(VALIDATION_LIMITS.messageMax).toBe(AI_LIMITS.messageMax);
  });
});
