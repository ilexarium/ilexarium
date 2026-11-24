// The release gate: `npm run ship` goes on only when a CI run on GitHub passed for the commit it
// releases, the install test included. Every push to main runs it, so a passing run of that push
// is usually there already (or still running: ship waits for it); otherwise ship starts one.

export const WORKFLOW = 'ci.yml';
const RUN_FIELDS = 'databaseId,headSha,status,conclusion,url,event';
const INSTALL_JOB = 'Install test';
// The events whose runs include the install test (a pull request's don't).
const GATE_EVENTS = new Set(['push', 'workflow_dispatch']);

// `gh(args)` runs the GitHub CLI and returns its output; `sleep(ms)` waits.
export async function passCi({ gh, sha, sleep, log = console.log, interval = 30_000 }) {
  const listed = (event) =>
    JSON.parse(
      gh([
        'run',
        'list',
        '--workflow',
        WORKFLOW,
        ...(event ? ['--event', event] : []),
        '--commit',
        sha,
        '--json',
        RUN_FIELDS,
        '--limit',
        '20',
      ]),
    );
  const view = (run, fields = RUN_FIELDS) =>
    JSON.parse(gh(['run', 'view', String(run.databaseId), '--json', fields]));
  const finished = async (run) => {
    while (run.status !== 'completed') {
      await sleep(interval);
      run = view(run);
    }
    return run;
  };
  // Passed, and the install test really ran in it (older push runs skipped it and still passed).
  const passedWithInstall = (run) =>
    run.headSha === sha &&
    run.conclusion === 'success' &&
    view(run, 'jobs').jobs.some(
      (job) => job.name.startsWith(INSTALL_JOB) && job.conclusion === 'success',
    );

  // Newest first, as gh lists them.
  const earlier = listed().filter((run) => GATE_EVENTS.has(run.event));
  const done = earlier.find((run) => run.status === 'completed' && passedWithInstall(run));
  if (done) {
    log(`CI passed for ${sha} already: ${done.url}`);
    return;
  }
  const running = earlier.find((run) => run.status !== 'completed');
  if (running) {
    log(`CI for ${sha} still running: ${running.url}`);
    if (passedWithInstall(await finished(running))) return;
    log('that run did not pass with the install test: starting a new one');
  }

  const known = new Set(listed('workflow_dispatch').map((run) => run.databaseId));
  gh(['workflow', 'run', WORKFLOW, '--ref', 'main']);
  let run;
  for (let tries = 0; !run; tries++) {
    if (tries === 20) throw new Error(`the ${WORKFLOW} run for ${sha} didn't appear on GitHub`);
    await sleep(3_000);
    run = listed('workflow_dispatch').find((candidate) => !known.has(candidate.databaseId));
  }
  log(`CI for ${sha}: ${run.url}`);
  run = await finished(run);
  // Main may have moved on between the push check and the start of the run.
  if (run.headSha !== sha) throw new Error(`CI ran ${run.headSha}, not ${sha}: ${run.url}`);
  if (run.conclusion !== 'success') throw new Error(`CI ${run.conclusion} at ${sha}: ${run.url}`);
}
