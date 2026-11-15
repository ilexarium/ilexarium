// The release gate: `npm run ship` starts the CI workflow on GitHub for the commit it releases
// (every job, the install test included) and goes on only when that run passed.

export const WORKFLOW = 'ci.yml';
const RUN_FIELDS = 'databaseId,headSha,status,conclusion,url';

// `gh(args)` runs the GitHub CLI and returns its output; `sleep(ms)` waits.
export async function passCi({ gh, sha, sleep, log = console.log, interval = 30_000 }) {
  const listed = () =>
    JSON.parse(
      gh([
        'run',
        'list',
        '--workflow',
        WORKFLOW,
        '--event',
        'workflow_dispatch',
        '--commit',
        sha,
        '--json',
        RUN_FIELDS,
        '--limit',
        '20',
      ]),
    );
  const known = new Set(listed().map((run) => run.databaseId));
  gh(['workflow', 'run', WORKFLOW, '--ref', 'main']);

  let run;
  for (let tries = 0; !run; tries++) {
    if (tries === 20) throw new Error(`the ${WORKFLOW} run for ${sha} didn't appear on GitHub`);
    await sleep(3_000);
    run = listed().find((candidate) => !known.has(candidate.databaseId));
  }
  log(`CI for ${sha}: ${run.url}`);

  while (run.status !== 'completed') {
    await sleep(interval);
    run = JSON.parse(gh(['run', 'view', String(run.databaseId), '--json', RUN_FIELDS]));
  }
  // Main may have moved on between the push check and the start of the run.
  if (run.headSha !== sha) throw new Error(`CI ran ${run.headSha}, not ${sha}: ${run.url}`);
  if (run.conclusion !== 'success') throw new Error(`CI ${run.conclusion} at ${sha}: ${run.url}`);
}
