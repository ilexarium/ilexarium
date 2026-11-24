// The release gate in ship: a CI run on GitHub for exactly the released commit, passed with the
// install test — a push's run when there is one, else a run ship starts.
import { passCi } from './github-ci.mjs';

const SHA = '1111111111111111111111111111111111111111';
const run = (fields: Record<string, unknown>) => ({
  databaseId: 7,
  headSha: SHA,
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/x/y/actions/runs/7',
  event: 'workflow_dispatch',
  ...fields,
});
const jobs = (install: string | null) => ({
  jobs: [
    { name: 'Lint, format and unit tests', conclusion: 'success' },
    ...(install ? [{ name: 'Install test (Debian 13 container)', conclusion: install }] : []),
  ],
});

/**
 * A fake gh. `all`: the answer to `run list` without an event (the commit's runs); `dispatched`:
 * each `run list --event workflow_dispatch` in turn (the last one repeats); `views`: each
 * `run view` of a run's fields in turn; `jobsOf`: a run's jobs by id.
 */
function fakeGh({
  all = [],
  dispatched = [[]],
  views = [],
  jobsOf = {},
}: {
  all?: unknown[];
  dispatched?: unknown[][];
  views?: unknown[];
  jobsOf?: Record<number, unknown>;
}) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'list') {
      if (!args.includes('--event')) return JSON.stringify(all);
      return JSON.stringify(dispatched.length > 1 ? dispatched.shift() : dispatched[0]);
    }
    if (args[0] === 'run' && args[1] === 'view') {
      if (args.at(-1) === 'jobs') return JSON.stringify(jobsOf[Number(args[2])] ?? jobs(null));
      return JSON.stringify(views.shift());
    }
    return '';
  };
  const started = () => calls.some((c) => c[0] === 'workflow' && c[1] === 'run');
  return { gh, calls, started };
}
const options = { sha: SHA, sleep: async () => {}, log: () => {} };

describe('passCi', () => {
  describe('a run of the push already there', () => {
    it('passed with the install test: goes on without starting one', async () => {
      const { gh, started } = fakeGh({
        all: [run({ databaseId: 5, event: 'push' })],
        jobsOf: { 5: jobs('success') },
      });
      await expect(passCi({ ...options, gh })).resolves.toBeUndefined();
      expect(started()).toBe(false);
    });

    it('still running: waits for it, then goes on', async () => {
      const { gh, started } = fakeGh({
        all: [run({ databaseId: 5, event: 'push', status: 'in_progress', conclusion: null })],
        views: [run({ databaseId: 5, event: 'push' })],
        jobsOf: { 5: jobs('success') },
      });
      await expect(passCi({ ...options, gh })).resolves.toBeUndefined();
      expect(started()).toBe(false);
    });

    it('passed without the install test (an older push run): starts one', async () => {
      const { gh, started } = fakeGh({
        all: [run({ databaseId: 5, event: 'push' })],
        jobsOf: { 5: jobs(null) },
        dispatched: [[], [run({})]],
      });
      await expect(passCi({ ...options, gh })).resolves.toBeUndefined();
      expect(started()).toBe(true);
    });

    it('cancelled or failed: starts one, and that run decides', async () => {
      const { gh, started } = fakeGh({
        all: [
          run({ databaseId: 5, event: 'push', status: 'in_progress', conclusion: null }),
          run({ databaseId: 4, event: 'push', conclusion: 'failure' }),
        ],
        views: [run({ databaseId: 5, event: 'push', conclusion: 'cancelled' })],
        dispatched: [[], [run({ conclusion: 'failure' })]],
      });
      await expect(passCi({ ...options, gh })).rejects.toThrow(`CI failure at ${SHA}`);
      expect(started()).toBe(true);
    });

    it("a pull request's run doesn't count", async () => {
      const { gh, started } = fakeGh({
        all: [run({ databaseId: 5, event: 'pull_request' })],
        jobsOf: { 5: jobs('success') },
        dispatched: [[], [run({})]],
      });
      await passCi({ ...options, gh });
      expect(started()).toBe(true);
    });
  });

  describe('no run to use: ship starts one', () => {
    it('starts the workflow on main and passes once the new run succeeded', async () => {
      const { gh, calls } = fakeGh({
        dispatched: [
          [run({ databaseId: 3, conclusion: 'failure' })],
          [
            run({ databaseId: 3, conclusion: 'failure' }),
            run({ status: 'in_progress', conclusion: null }),
          ],
        ],
        views: [run({})],
      });
      await expect(passCi({ ...options, gh })).resolves.toBeUndefined();
      expect(calls).toContainEqual(['workflow', 'run', 'ci.yml', '--ref', 'main']);
      expect(calls.at(-1)).toEqual(['run', 'view', '7', '--json', expect.any(String)]);
    });

    it("doesn't take an earlier run of the same commit for the new one", async () => {
      const { gh } = fakeGh({
        dispatched: [
          [run({ conclusion: 'failure' })],
          [run({ conclusion: 'failure' })],
          [run({ conclusion: 'failure' }), run({ databaseId: 8, conclusion: 'failure' })],
        ],
      });
      await expect(passCi({ ...options, gh })).rejects.toThrow('CI failure');
    });

    it('refuses a run that failed', async () => {
      const { gh } = fakeGh({ dispatched: [[], [run({ conclusion: 'failure' })]] });
      await expect(passCi({ ...options, gh })).rejects.toThrow(`CI failure at ${SHA}`);
    });

    it('refuses a run of another commit (main moved on)', async () => {
      const other = '2222222222222222222222222222222222222222';
      const { gh } = fakeGh({ dispatched: [[], [run({ headSha: other })]] });
      await expect(passCi({ ...options, gh })).rejects.toThrow(`CI ran ${other}`);
    });

    it('gives up when no run appears', async () => {
      const { gh } = fakeGh({ dispatched: [[]] });
      await expect(passCi({ ...options, gh })).rejects.toThrow("didn't appear");
    });
  });
});
