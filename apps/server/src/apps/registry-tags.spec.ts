import { RegistryTags, registryOf } from './registry-tags.js';

describe('registryOf', () => {
  it('Docker Hub’s names, other registries by their host', () => {
    expect(registryOf('nginx')).toEqual({ host: 'registry-1.docker.io', repository: 'library/nginx' });
    expect(registryOf('ollama/ollama:0.40')).toEqual({ host: 'registry-1.docker.io', repository: 'ollama/ollama' });
    expect(registryOf('docker.io/valkey/valkey:9')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'valkey/valkey',
    });
    expect(registryOf('ghcr.io/immich-app/immich-server:v3')).toEqual({
      host: 'ghcr.io',
      repository: 'immich-app/immich-server',
    });
  });

  it('nothing for a variable or something that is no image', () => {
    expect(registryOf('ghcr.io/x/${NAME}')).toBeNull();
    expect(registryOf('Has Spaces')).toBeNull();
  });
});

type Answer = { status: number; ok: boolean; headers: { get(n: string): string | null }; body: unknown };
const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  ok: status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  body,
});

class FakeRegistry extends RegistryTags {
  readonly asked: { url: string; token: string | null }[] = [];
  constructor(private readonly answers: Answer[]) {
    super();
  }
  protected override async get(url: string, token: string | null): Promise<never> {
    this.asked.push({ url, token });
    const next = this.answers.shift();
    if (!next) throw new Error('no more answers');
    return next as never;
  }
}

describe('RegistryTags', () => {
  it('asks anonymously, then with the token the registry names; follows its pages', async () => {
    const registry = new FakeRegistry([
      answer(401, null, {
        'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x/y:pull"',
      }),
      answer(200, { token: 't0k' }),
      answer(200, { tags: ['1.0', 'latest'] }, { link: '</v2/x/y/tags/list?last=latest&n=1000>; rel="next"' }),
      answer(200, { tags: ['2.0', '2.1-rc1'] }),
    ]);
    expect(await registry.versions('ghcr.io/x/y:1.0')).toEqual(['2.0', '1.0']);
    expect(registry.asked.map((a) => [a.url, a.token])).toEqual([
      ['https://ghcr.io/v2/x/y/tags/list?n=1000', null],
      ['https://ghcr.io/token?service=ghcr.io&scope=repository%3Ax%2Fy%3Apull', null],
      ['https://ghcr.io/v2/x/y/tags/list?n=1000', 't0k'],
      ['https://ghcr.io/v2/x/y/tags/list?last=latest&n=1000', 't0k'],
    ]);
  });

  it('a registry that wants a sign-in (no token for us), or fails: no list', async () => {
    expect(await new FakeRegistry([answer(401, null, { 'www-authenticate': 'Basic realm="x"' })]).versions('ghcr.io/a/b')).toBeNull();
    expect(await new FakeRegistry([answer(500, null)]).versions('ghcr.io/a/b')).toBeNull();
  });

  it('never follows a next page to another host, nor a token address that is not HTTPS', async () => {
    const other = new FakeRegistry([
      answer(200, { tags: ['1.0'] }, { link: '<https://evil.example/v2/x/tags/list>; rel="next"' }),
    ]);
    expect(await other.versions('ghcr.io/x/y')).toEqual(['1.0']);
    expect(other.asked).toHaveLength(1);
    const plain = new FakeRegistry([
      answer(401, null, { 'www-authenticate': 'Bearer realm="http://ghcr.io/token"' }),
    ]);
    expect(await plain.versions('ghcr.io/x/z')).toBeNull();
  });

  it('refuses a registry on this machine or the local network (checked after resolving)', async () => {
    expect(await new RegistryTags().versions('127.0.0.1:5000/x/y:1')).toBeNull();
    expect(await new RegistryTags().versions('192.168.1.10:5000/x/y:1')).toBeNull();
  });
});
