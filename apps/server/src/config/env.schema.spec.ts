import { validateEnv } from './env.schema.js';

const base = { DATABASE_URL: 'postgresql://laris:secret-pw@127.0.0.1:5432/laris' };

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      TRUST_PROXY: false,
      PORT: 3000,
      SETUP_TOKEN_FILE: '.dev/setup-token',
      DOCKER_HOST: 'tcp://127.0.0.1:2375',
      ALERTS_WATCH: 'on',
    });
  });

  it('accepts the Docker proxy over tcp:// or http://, or its own socket under /run/laris/', () => {
    for (const url of [
      'tcp://127.0.0.1:2375',
      'http://docker-proxy:2375',
      'unix:///run/laris/proxy/docker.sock',
      'unix:///run/laris/docker-proxy.sock',
    ]) {
      expect(validateEnv({ ...base, DOCKER_HOST: url }).DOCKER_HOST, url).toBe(url);
    }
  });

  it('never Docker’s own socket, or any other socket path', () => {
    for (const url of [
      'unix:///var/run/docker.sock',
      'unix:///run/docker.sock',
      'unix:///run/laris/../docker.sock',
      'unix:///run/laris/proxy/../../docker.sock',
      'unix:///run/laris/a/b/docker.sock',
      'unix:///run/laris/docker.sock/../x.sock',
      'unix://run/laris/docker.sock',
      '/var/run/docker.sock',
      'ssh://host',
      'npipe:////./pipe/docker_engine',
    ]) {
      expect(() => validateEnv({ ...base, DOCKER_HOST: url }), url).toThrow(/DOCKER_HOST/);
    }
  });

  it('starts the installed helper, or one at another plain absolute path', () => {
    expect(validateEnv(base).LINUX_HELPER).toBe('/opt/laris/libexec/laris-helper.mts');
    const path = '/home/dev/laris/system/wrappers/laris-helper.mts';
    expect(validateEnv({ ...base, LINUX_HELPER: path }).LINUX_HELPER).toBe(path);
  });

  it('never a helper path SSH would read as more than one (spaces, quotes, “;”, “..”)', () => {
    for (const path of [
      'laris-helper.mts',
      '/opt/laris helper.mts',
      '/opt/x;id',
      "/opt/x'y",
      '/opt/$(id)',
      '/opt/../tmp/x',
      '/opt/x\nid',
    ]) {
      expect(() => validateEnv({ ...base, LINUX_HELPER: path }), path).toThrow();
    }
  });

  it('uses the production setup-token path in production', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).SETUP_TOKEN_FILE).toBe(
      '/var/lib/laris/app/setup-token',
    );
  });

  it('uses development paths and the direct executor outside production', () => {
    expect(validateEnv(base)).toMatchObject({
      MASTER_KEY_FILE: '.dev/master.key',
      WRAPPER_CONFIG_FILE: '.dev/wrappers.json',
      EXECUTOR_MODE: 'direct',
    });
  });

  it('listens only on loopback in production unless told otherwise', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).HOST).toBe('127.0.0.1');
    expect(validateEnv(base).HOST).toBeUndefined();
    expect(validateEnv({ ...base, NODE_ENV: 'production', HOST: '::1' }).HOST).toBe('::1');
    expect(() => validateEnv({ ...base, HOST: 'example.com' })).toThrow(/HOST/);
  });

  it('uses the installed files and sudo in production', () => {
    expect(validateEnv({ ...base, NODE_ENV: 'production' })).toMatchObject({
      MASTER_KEY_FILE: '/etc/laris/master.key',
      WRAPPER_CONFIG_FILE: '/etc/laris/wrappers.json',
      EXECUTOR_MODE: 'sudo',
      SSH_PORT: 22,
      SSH_HOST_KEYS: '/etc/ssh',
    });
  });

  it('never runs the wrapper without sudo in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', EXECUTOR_MODE: 'direct' })).toThrow(
      /EXECUTOR_MODE/,
    );
  });

  it('keeps an explicit setup-token path', () => {
    expect(validateEnv({ ...base, SETUP_TOKEN_FILE: '/tmp/token' }).SETUP_TOKEN_FILE).toBe(
      '/tmp/token',
    );
  });

  it('requires a postgresql DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('never puts the database password in the error', () => {
    try {
      validateEnv({ ...base, PORT: 'not-a-port' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-pw');
    }
  });

  it('coerces and bounds PORT', () => {
    expect(validateEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  describe('TRUST_PROXY', () => {
    it.each([
      ['false', false],
      ['', false],
      ['loopback', ['loopback']],
      ['192.168.1.10', ['192.168.1.10']],
      ['loopback, 10.0.0.0/8, fd00::/8', ['loopback', '10.0.0.0/8', 'fd00::/8']],
    ])('accepts %j', (value, expected) => {
      expect(validateEnv({ ...base, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
    });

    it.each(['true', 'TRUE', '*'])('rejects %j (trust every client)', (value) => {
      expect(() => validateEnv({ ...base, TRUST_PROXY: value })).toThrow(/fake their IP/);
    });

    it.each(['yes', '300.1.1.1', 'example.com', '10.0.0.0/33'])('rejects %j', (value) => {
      expect(() => validateEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    });
  });
});
