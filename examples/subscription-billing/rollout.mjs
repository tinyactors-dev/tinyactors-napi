// How an operator rolls a new release of the charts out to a live
// population, as a program: deploy, move one canary, move each chart (the
// host loads the hibernated actors as its resident bound allows), then find
// who is still on the old release. Billing goes on throughout: renewals fall due, payments
// answer, customers change their plans.

/**
 * @param {import('./billing.mjs').Billing} billing
 * @param {object} options
 * @param {number} options.release the release to deploy (a key of RELEASES)
 * @param {string[]} options.charts the charts to move, one migration each,
 *   in this order
 * @param {string} [options.canary] the name of one actor to move first; the
 *   rollout stops if it does not move
 * @param {number} [options.timeoutMs] each migration's timeout on the
 *   host's clock: what it has not moved by then stays where it is
 * @param {number} [options.stepMs] how far the clock moves per round
 * @param {() => void} [options.during] called every round: the business
 *   that goes on while the rollout runs (customers' events, say)
 * @param {(line: string) => void} [options.log]
 */
export async function rollout(billing, { release, charts, canary, timeoutMs = 0, stepMs = 60_000, during, log = () => {} }) {
  const report = { release, segment: billing.deploy(release), canary: undefined, migrations: [], leftBehind: {} };
  log(`deployed release ${release} as segment ${report.segment}: new actors are of it from now on`);

  if (canary !== undefined) {
    const session = billing.session(canary);
    if (session === undefined) throw new Error(`no actor named ${canary}`);
    const migration = billing.migrate({ session, wake: true, timeout: timeoutMs });
    const result = await drive(billing, [migration], { stepMs, during });
    report.canary = { name: canary, session, result: result[0], release: await billing.releaseOf(session) };
    log(`canary ${canary}: ${result[0].migrated} moved, ${result[0].failed} failed, on release ${report.canary.release}`);
    if (report.canary.release !== release) {
      report.aborted = `the canary ${canary} did not move`;
      log(`stopped: ${report.aborted}`);
      return report;
    }
  }

  for (const chart of charts) {
    // migrate throws TA_ERROR_INVALID for a chart the host does not have
    const migration = billing.migrate({ chart, wake: true, timeout: timeoutMs });
    const [result] = await drive(billing, [migration], { stepMs, during });
    report.migrations.push({ chart, id: migration.id, moved: migration.moved.length, result });
    log(`${chart}: migration ${result.migration} moved ${result.migrated}, ${result.failed} failed, ` +
      `${result.pending.length} still pending at its timeout`);
  }

  report.leftBehind = await leftBehind(billing, release, charts);
  for (const chart of charts) log(`${chart}: ${report.leftBehind[chart].length} actors still on an older release`);
  return report;
}

/** The live actors of `charts` that are not on `release`, by chart: every
 * actor the host has, asked of it, so this counts the ones a migration's
 * `failed` names and the ones that came after it alike. */
export async function leftBehind(billing, release, charts) {
  const inventory = await billing.inventory();
  const result = {};
  for (const chart of charts) {
    result[chart] = Object.entries(inventory[chart] ?? {})
      .filter(([of]) => Number(of) !== release).flatMap(([, sessions]) => sessions);
  }
  return result;
}

/** Moves each of `sessions` with a migration of its own, all at once:
 * the second pass, for the actors a rollout left behind. */
export async function retry(billing, sessions, { timeoutMs = 0, stepMs = 60_000, during } = {}) {
  const migrations = sessions.map((session) => billing.migrate({ session, wake: true, timeout: timeoutMs }));
  return drive(billing, migrations, { stepMs, during });
}

/** Runs the business until every migration in `migrations` has ended:
 * each round moves the clock a step (renewals, dunning and payments go
 * on; the host loads the actors the migrations asked for as room allows).
 * Answers each migration's result. */
export async function drive(billing, migrations, { stepMs, during }) {
  while (migrations.some((migration) => migration.result === undefined)) {
    during?.();
    await billing.advance(stepMs);
  }
  return migrations.map((migration) => migration.result);
}
