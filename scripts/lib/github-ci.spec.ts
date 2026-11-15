// The release gate in ship: a CI run on GitHub for exactly the released commit, and passed.
import { passCi } from './github-ci.mjs';

const SHA = '1111111111111111111111111111111111111111';
const run = (fields: Record<string, unknown>) => ({
  databaseId: 7,
  headSha: SHA,
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/x/y/actions/runs/7',
  ...fields,
});

// A fake gh: `list` answers each `run list` in turn (the last one repeats), `views` each `run view`.
function fakeGh(list: unknown[][], views: unknown[] = []) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(list.shift() ?? []);
    if (args[0] === 'run' && args[1] === 'view') return JSON.stringify(views.shift());
    return '';
  };
  return { gh, calls };
}
const options = { sha: SHA, sleep: async () => {}, log: () => {} };

describe('passCi', () => {
  it('starts the workflow on main and passes once the new run succeeded', async () => {
    const { gh, calls } = fakeGh(
      [
        [run({ databaseId: 3 })],
        [run({ databaseId: 3 }), run({ status: 'in_progress', conclusion: null })],
      ],
      [run({})],
    );
    await expect(passCi({ ...options, gh })).resolves.toBeUndefined();
    expect(calls).toContainEqual(['workflow', 'run', 'ci.yml', '--ref', 'main']);
    expect(calls.at(-1)).toEqual(['run', 'view', '7', '--json', expect.any(String)]);
  });

  it("doesn't take an earlier run of the same commit for the new one", async () => {
    const { gh } = fakeGh([
      [run({})],
      [run({})],
      [run({}), run({ databaseId: 8, conclusion: 'failure' })],
    ]);
    await expect(passCi({ ...options, gh })).rejects.toThrow('CI failure');
  });

  it('refuses a run that failed', async () => {
    const { gh } = fakeGh([[], [run({ conclusion: 'failure' })]]);
    await expect(passCi({ ...options, gh })).rejects.toThrow(`CI failure at ${SHA}`);
  });

  it('refuses a run of another commit (main moved on)', async () => {
    const other = '2222222222222222222222222222222222222222';
    const { gh } = fakeGh([[], [run({ headSha: other })]]);
    await expect(passCi({ ...options, gh })).rejects.toThrow(`CI ran ${other}`);
  });

  it('gives up when no run appears', async () => {
    const { gh } = fakeGh([[]]);
    await expect(passCi({ ...options, gh })).rejects.toThrow("didn't appear");
  });
});
