import type { Template } from '@laris/shared';
import { composeFields, splitImage, variablesIn } from './compose-fields.js';

const context = { account: '1500:1500', timezone: 'Europe/Berlin' };
const kinds = (compose: string, env = '') =>
  Object.fromEntries(composeFields(compose, env, null, context).fields.map((f) => [f.key, f.kind]));

describe('variablesIn', () => {
  it('reads Compose’s forms, never $$', () => {
    expect(variablesIn('${A} ${B:-x y} ${C-z} ${D:?needed} ${E?} ${F:+alt} $G $$H $${I}')).toEqual([
      expect.objectContaining({ key: 'A', default: null, required: false }),
      expect.objectContaining({ key: 'B', default: 'x y', required: false }),
      expect.objectContaining({ key: 'C', default: 'z' }),
      expect.objectContaining({ key: 'D', required: true }),
      expect.objectContaining({ key: 'E', required: true }),
      expect.objectContaining({ key: 'F', default: null, required: false }),
      expect.objectContaining({ key: 'G' }),
    ]);
  });
});

describe('composeFields guesses each kind from where it is used', () => {
  it('ports: published, on one address, ranges; the address is text', () => {
    expect(
      kinds(`services:
  a:
    image: x:1
    ports:
      - '127.0.0.1:\${P}:80'
      - '\${IP}:\${Q}:81'
      - '\${R1}-\${R2}:90-91'
      - target: 80
        published: \${LONG}
        host_ip: \${LONG_IP}
`),
    ).toEqual({
      P: 'port',
      IP: 'text',
      Q: 'port',
      R1: 'port',
      R2: 'port',
      LONG: 'port',
      LONG_IP: 'text',
    });
  });

  it('folders: a bind mount’s source, a variable alone, below a variable; a named volume is text', () => {
    expect(
      kinds(`services:
  a:
    image: x:1
    volumes:
      - \${D}/sub:/data
      - ./\${REL}:/rel
      - named-\${SUFFIX}:/named
      - \${ALONE}:/alone
      - type: bind
        source: \${LONG}
        target: /long
`),
    ).toEqual({ D: 'folder', REL: 'folder', SUFFIX: 'text', ALONE: 'folder', LONG: 'folder' });
  });

  it('a version is an image’s tag; a secret by its name; the rest text', () => {
    const fields = composeFields(
      `services:
  a:
    image: ghcr.io/x/y:\${Y_VERSION}
    environment:
      DB_PASSWORD: \${DB_PASSWORD}
      API_KEY: \${API_KEY}
      TZ: \${TZ:-UTC}
      REQUIRED: \${NEEDED:?set it}
      PRICE: '$$5'
`,
      '',
      null,
      context,
    ).fields;
    expect(Object.fromEntries(fields.map((f) => [f.key, f.kind]))).toEqual({
      Y_VERSION: 'version',
      DB_PASSWORD: 'secret',
      API_KEY: 'secret',
      TZ: 'text',
      NEEDED: 'text',
    });
    expect(fields.find((f) => f.key === 'TZ')).toMatchObject({ value: 'UTC', default: 'UTC' });
    expect(fields.find((f) => f.key === 'NEEDED')?.required).toBe(true);
  });

  it('one variable used twice takes the more telling kind', () => {
    expect(
      kinds(`services:
  a:
    image: x:1
    environment:
      PORT: \${PORT}
    ports: ['\${PORT}:80']
`),
    ).toEqual({ PORT: 'port' });
  });

  it('values come from .env first', () => {
    const [field] = composeFields(
      'services:\n  a:\n    image: x:1\n    ports: ["${P:-80}:80"]\n',
      'P=8080\n',
      null,
      context,
    ).fields;
    expect(field).toMatchObject({ value: '8080', default: '80' });
  });

  it('a template says the kinds, fills @account and @timezone, makes generated secrets', () => {
    const template = {
      id: 'demo',
      fields: [
        { key: 'USER_ID', kind: 'text', default: '@account', advanced: true },
        { key: 'TZ', kind: 'text', default: '@timezone' },
        { key: 'DB_PASSWORD', kind: 'generated' },
        { key: 'PORT', kind: 'port', default: 8080 },
      ],
    } as unknown as Template;
    const compose =
      'services:\n  a:\n    image: x:1\n    user: "${USER_ID}"\n    environment: [ "TZ=${TZ}", "P=${DB_PASSWORD}" ]\n    ports: ["${PORT}:80"]\n';
    const fields = composeFields(compose, '', template, context).fields;
    expect(fields.map((f) => [f.key, f.kind, f.fromTemplate])).toEqual([
      ['USER_ID', 'text', true],
      ['TZ', 'text', true],
      ['DB_PASSWORD', 'generated', true],
      ['PORT', 'port', true],
    ]);
    expect(fields[0].value).toBe('1500:1500');
    expect(fields[1].value).toBe('Europe/Berlin');
    expect(fields[2].value).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Kept when .env has it.
    expect(composeFields(compose, 'DB_PASSWORD=kept\n', template, context).fields[2].value).toBe(
      'kept',
    );
  });

  it('says why a file can’t be read', () => {
    expect(composeFields('services: [', '', null, context).problem).toBeTruthy();
    expect(composeFields('- a list', '', null, context).problem).toBe('Not a Compose file');
  });
});

describe('splitImage', () => {
  it('the tag after the last ":" past the last "/" (a registry port is not one)', () => {
    expect(splitImage('registry:5000/x/y')).toEqual({
      image: 'registry:5000/x/y',
      tag: null,
      digest: null,
    });
    expect(splitImage('x/y:1.2@sha256:abc')).toEqual({
      image: 'x/y',
      tag: '1.2',
      digest: 'sha256:abc',
    });
  });
});
