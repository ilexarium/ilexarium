import { withImageTag } from './image-tag.js';

const compose = `# my notes
services:
  web:
    # pinned for now
    image: nginx:1.25@sha256:${'a'.repeat(64)}   # trailing
    ports: ['8080:80']
  db:
    image: postgres:16
`;

describe('withImageTag', () => {
  it('changes one service’s tag, keeping comments and the rest; the old digest goes', () => {
    const changed = withImageTag(compose, 'web', '1.27')!;
    expect(changed).toContain('# my notes');
    expect(changed).toContain('# pinned for now');
    expect(changed).toContain('image: nginx:1.27');
    expect(changed).not.toContain('sha256');
    expect(changed).toContain('image: postgres:16');
  });

  it('a new digest stays with its tag', () => {
    expect(withImageTag(compose, 'db', `16@sha256:${'b'.repeat(64)}`)).toContain(
      `image: postgres:16@sha256:${'b'.repeat(64)}`,
    );
  });

  it('null for a service without an image line, or a file that can’t be read', () => {
    expect(withImageTag(compose, 'cache', '1')).toBeNull();
    expect(withImageTag('services: [', 'web', '1')).toBeNull();
  });
});
