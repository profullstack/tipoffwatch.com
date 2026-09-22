/**
 * Notice when a dependency has stopped answering the client this process uses.
 *
 * Ported from genrewatch (PR #23), which added it after 2026-09-07: every page on
 * that site hung forever while the container stayed up, Postgres stayed healthy
 * and Railway reported the service Online. The web process had run for about 29
 * hours; in that time its Bun `SQL` pool lost every slot it had. A query issued
 * from a request queued for a connection that was never going to arrive, and
 * Bun's pool has no queue deadline -- `connectionTimeout` bounds opening a socket,
 * not waiting for a free one -- so the request never failed and never answered.
 * `/healthz`, robots.txt and the 402 the crawler wall serves all answered in
 * milliseconds, because none of them touch the database.
 *
 * That combination is the dangerous part. Every liveness signal a Railway
 * deployment has was green: the process was alive and sleeping, the accept queue
 * was empty, Postgres held four connections and no locks. Only requests through
 * the app's own pool hung. Railway's `healthcheckPath` gates a new deploy and is
 * never re-run, so nothing was ever going to restart it. It took a person
 * noticing the site was down.
 *
 * So the probe MUST go through the same client the requests use. A separate
 * connection is exactly the thing that stayed healthy for 29 hours while readers
 * got nothing, and a watchdog built on one would have reported everything fine.
 *
 * **This site has now lost the same bet twice, on the other dependency.** On
 * 2026-09-13 and again on 2026-09-22, Redis went away and the web process never
 * came back: `/healthz` answered 200 in 50ms while `/` returned nothing for
 * minutes, and only redeploying the service recovered it -- restarting Redis
 * alone did not, because the wedge is on this side of the socket. Both times a
 * person had to notice. That is why `startWorkers`/the page cache get a watchdog
 * here too, not just the pool.
 *
 * What it does when it decides the client is gone is exit. That reads as drastic
 * for a web server, and it is the cheapest correct move here: the failure is
 * process-local state that no request can repair, a restart demonstrably clears
 * it (both outages ended with one), and Railway replaces the container in about a
 * minute. Hanging forever is not the safer option -- it is the outage.
 */

/** Enough consecutive failures that a blip cannot trigger a restart. */
const DEFAULT_FAILURES = 3;

/**
 * @param {object} o
 * @param {(signal: AbortSignal) => Promise<unknown>} o.probe
 *   Runs a trivial command on the shared client. Given a signal, but a client that
 *   has stopped issuing connections will not observe it -- the timeout below is
 *   what actually bounds the wait.
 * @param {string} [o.subject] what is being watched, for the log and the give-up
 *   reason: "the database pool", "redis". Defaults to the pool, which is what
 *   genrewatch's copy watches, so the two stay diffable.
 * @param {number} [o.intervalMs] gap between probes
 * @param {number} [o.timeoutMs] how long one probe may take before it counts as a failure
 * @param {number} [o.failures] consecutive failures before giving up
 * @param {(reason: string) => void} [o.onGiveUp] what to do when the client is declared gone
 * @param {Console} [o.log]
 * @returns {{ stop: () => void, check: () => Promise<boolean> }}
 */
export function startDbWatchdog({
  probe,
  subject = 'the database pool',
  intervalMs = 30_000,
  timeoutMs = 10_000,
  failures = DEFAULT_FAILURES,
  // Non-zero: this is a crash, not a drain. Railway restarts it either way, but a
  // clean exit in the deploy log would read as the app choosing to stop.
  onGiveUp = () => process.exit(1),
  log = console,
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('the watchdog needs a probe');

  let consecutive = 0;
  let stopped = false;
  let timer = null;

  /**
   * One probe. Resolves true if the client answered inside the timeout.
   *
   * The timeout is a race rather than a rejection from the driver, because the
   * symptom being watched for is a promise that never settles at all. Waiting on
   * the command alone would hang the watchdog in precisely the case it exists
   * for -- and for Redis that is not a hypothetical: the shared ioredis client is
   * built with `maxRetriesPerRequest: null` (BullMQ requires it), which means a
   * command issued while disconnected is queued forever rather than rejected.
   */
  async function check() {
    const controller = new AbortController();
    let timeoutId;
    const expired = Symbol('timeout');
    try {
      const outcome = await Promise.race([
        probe(controller.signal).then(() => true),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(expired), timeoutMs);
        }),
      ]);
      if (outcome === expired) {
        controller.abort();
        consecutive += 1;
        log.error(
          `[db-watchdog] ${subject} did not answer in ${timeoutMs}ms (${consecutive}/${failures})`,
        );
      } else {
        // A success clears the count: the bar is CONSECUTIVE failures, so a slow
        // minute or a single dropped connection never costs a restart. The wedge
        // this watches for does not recover on its own, so it never clears.
        if (consecutive > 0)
          log.warn(`[db-watchdog] ${subject} answered again after ${consecutive}`);
        consecutive = 0;
        return true;
      }
    } catch (err) {
      // A rejection is a healthier signal than a hang: the client is still
      // refusing work, but it is refusing rather than swallowing. Counted the same.
      consecutive += 1;
      log.error(
        `[db-watchdog] ${subject} probe failed (${consecutive}/${failures}): ${err?.message ?? err}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (consecutive >= failures && !stopped) {
      stopped = true;
      clearInterval(timer);
      const reason =
        `[db-watchdog] ${subject} has stopped issuing connections ` +
        `(${consecutive} probes in a row). The server itself may be fine -- this is the ` +
        `in-process client. Exiting so the platform starts a container that can serve.`;
      log.error(reason);
      onGiveUp(reason);
    }
    return false;
  }

  timer = setInterval(check, intervalMs);
  // A watchdog is not a reason to hold the process open on its own.
  timer.unref?.();

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
