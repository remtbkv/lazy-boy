// Known-answer tests for the stale-build reload decision.
//
//   node scripts/test-build-skew.mjs
//
// The logic is imported straight from src/lib/build-skew.ts (Node strips the types), so what
// is tested here is exactly what ships — that module is dependency-free for this reason, and
// must stay that way. The clock, the localStorage stamp and location.reload() live in the
// caller (src/components/now-playing-context.tsx); everything a wrong answer would cost —
// a reload loop, a page yanked mid-use, a tab that never notices a deploy — is decided here.
//
// The load-bearing case is the last section: a tab pinned by Vercel skew protection sees the
// now-playing poll agree with itself forever, and is only ever caught by the unpinned probe
// disagreeing. If a "poll" match could clear the streak, the guard would be inert exactly
// where it matters.
import {
  INTERACTION_IDLE_MS,
  MISMATCH_GRACE_MS,
  NO_SKEW,
  RELOAD_THROTTLE_MS,
  evaluateSkew,
} from "../src/lib/build-skew.ts";

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  );
}

const T = 1_000_000_000_000; // an arbitrary fixed "now"
const streak = (since, authMismatch = false) => ({ since, authMismatch });

// Defaults: skewed, from the cheap poll source, nothing in the way of a reload. Each test
// overrides one field, so a `reload: false` below is always attributable to what it tests.
const base = {
  clientBuild: "old",
  serverBuild: "new",
  source: "poll",
  now: T,
  streak: NO_SKEW,
  lastReloadAt: null,
  visible: false,
  lastInteractionAt: null,
};
const at = (overrides) => evaluateSkew({ ...base, ...overrides });

// ── Agreement and silence ──────────────────────────────────────────────────────────────
check("matching builds never reload", at({ serverBuild: "old" }), {
  streak: NO_SKEW,
  reload: false,
});
check(
  "a matching poll clears an unconfirmed streak (the deploy propagated)",
  at({ serverBuild: "old", streak: streak(T - 10 * 60_000) }),
  { streak: NO_SKEW, reload: false },
);
check(
  "a missing server build leaves the streak exactly as it was",
  at({ serverBuild: undefined, streak: streak(T - 10 * 60_000, true) }),
  { streak: streak(T - 10 * 60_000, true), reload: false },
);
check("a missing client build is not evidence of skew", at({ clientBuild: undefined }), {
  streak: NO_SKEW,
  reload: false,
});
check(
  "empty strings count as missing, not as a mismatch",
  at({ clientBuild: "", serverBuild: "" }),
  { streak: NO_SKEW, reload: false },
);

// ── The debounce ───────────────────────────────────────────────────────────────────────
check("a first mismatch starts the streak and does not reload", at({}), {
  streak: streak(T),
  reload: false,
});
check(
  "still inside the grace window: streak preserved, no reload",
  at({ streak: streak(T - (MISMATCH_GRACE_MS - 1)) }),
  { streak: streak(T - (MISMATCH_GRACE_MS - 1)), reload: false },
);
check(
  "exactly at the grace window the reload fires",
  at({ streak: streak(T - MISMATCH_GRACE_MS) }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: true },
);
// A deploy mid-propagation serves old and new alternately, and the tab receiving them may be
// the FRESH one (client = the new build, some replies still from the old). Nothing unpinned
// has contradicted it, so each match must restart the streak — otherwise a current tab would
// reload itself for no reason every time a deploy rolls out.
{
  let state = NO_SKEW;
  for (const [i, server] of ["new", "old", "new", "old", "new"].entries()) {
    const d = evaluateSkew({ ...base, serverBuild: server, now: T + i * 60_000, streak: state });
    state = d.streak;
    check(`flapping propagation, reply ${i + 1} (${server}) does not reload`, d.reload, false);
  }
  check(
    "flapping leaves only a fresh streak, well short of the threshold",
    state,
    streak(T + 4 * 60_000),
  );
}

// ── The reload throttle ────────────────────────────────────────────────────────────────
check(
  "a reload inside the throttle window is suppressed (no reload loop)",
  at({ streak: streak(T - MISMATCH_GRACE_MS), lastReloadAt: T - (RELOAD_THROTTLE_MS - 1) }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: false },
);
check(
  "once the throttle window has passed, a persisting mismatch reloads again",
  at({ streak: streak(T - MISMATCH_GRACE_MS), lastReloadAt: T - RELOAD_THROTTLE_MS }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: true },
);
// The worst case the throttle exists for: a beacon that can never agree. Simulated at the
// real 6s poll cadence over an hour — the bound is elapsed/RELOAD_THROTTLE_MS, not per-poll.
{
  let lastReloadAt = null;
  let state = NO_SKEW;
  let reloads = 0;
  for (let t = T; t < T + 60 * 60_000; t += 6_000) {
    const d = evaluateSkew({ ...base, now: t, streak: state, lastReloadAt });
    state = d.streak;
    if (d.reload) {
      reloads++;
      lastReloadAt = t;
      state = NO_SKEW; // a reload restarts the tab, and the streak with it
    }
  }
  check("a permanently broken beacon reloads at most 6x/hour, not per poll", reloads, 6);
}

// ── Deferral while in use ──────────────────────────────────────────────────────────────
check(
  "visible and just used: the reload waits",
  at({
    streak: streak(T - MISMATCH_GRACE_MS),
    visible: true,
    lastInteractionAt: T - (INTERACTION_IDLE_MS - 1),
  }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: false },
);
check(
  "visible but idle past the window: reload",
  at({
    streak: streak(T - MISMATCH_GRACE_MS),
    visible: true,
    lastInteractionAt: T - INTERACTION_IDLE_MS,
  }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: true },
);
check(
  "visible but never touched since load: reload",
  at({ streak: streak(T - MISMATCH_GRACE_MS), visible: true, lastInteractionAt: null }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: true },
);
check(
  "hidden reloads immediately even if it was touched a second ago",
  at({ streak: streak(T - MISMATCH_GRACE_MS), visible: false, lastInteractionAt: T - 1_000 }),
  { streak: streak(T - MISMATCH_GRACE_MS), reload: true },
);
// Deferral must not consume the streak — the whole point is that it fires at the next idle
// moment rather than restarting the 3-minute wait.
{
  const since = T - MISMATCH_GRACE_MS;
  const deferred = at({ streak: streak(since), visible: true, lastInteractionAt: T - 1_000 });
  check("a deferred reload keeps the streak", deferred.streak, streak(since));
  const later = evaluateSkew({
    ...base,
    now: T + 60_000,
    streak: deferred.streak,
    visible: true,
    lastInteractionAt: T - 1_000, // untouched since
  });
  check("and fires as soon as the user goes idle", later.reload, true);
}

// ── The pinned tab: authoritative vs poll ──────────────────────────────────────────────
check("an authoritative mismatch starts the streak and marks it confirmed", at({ source: "authoritative" }), {
  streak: streak(T, true),
  reload: false,
});
check(
  "a poll match can NOT clear a streak an unpinned probe confirmed (the pinned signature)",
  at({ serverBuild: "old", streak: streak(T - 60_000, true) }),
  { streak: streak(T - 60_000, true), reload: false },
);
check(
  "an authoritative match DOES clear it — the tab really is on the current build",
  at({ serverBuild: "old", source: "authoritative", streak: streak(T - 60_000, true) }),
  { streak: NO_SKEW, reload: false },
);
check(
  "a poll mismatch inherits the confirmed flag rather than dropping it",
  at({ streak: streak(T - 60_000, true) }),
  { streak: streak(T - 60_000, true), reload: false },
);
// End to end, at the real cadences: a tab pinned to an old deployment. Its now-playing poll
// answers with its OWN build id every 6s (skew protection routes it back to itself), so the
// poll agrees forever; only the credentials-omitted probe, every ~5 min, ever disagrees.
{
  const PROBE_EVERY_MS = 5 * 60_000;
  let state = NO_SKEW;
  let reloadedAt = null;
  for (let t = T; t <= T + 20 * 60_000 && reloadedAt === null; t += 6_000) {
    // Every tick: the pinned poll, agreeing with this tab's own (stale) build.
    let d = evaluateSkew({ ...base, serverBuild: "old", source: "poll", now: t, streak: state });
    state = d.streak;
    if (d.reload) reloadedAt = t;
    // Every ~5 min: the unpinned probe, reporting the deployment that is actually live.
    if ((t - T) % PROBE_EVERY_MS === 0) {
      d = evaluateSkew({
        ...base,
        serverBuild: "new",
        source: "authoritative",
        now: t,
        streak: state,
      });
      state = d.streak;
      if (d.reload) reloadedAt = t;
    }
  }
  check(
    "a pinned tab still reloads, 3 min after the first unpinned probe",
    reloadedAt === null ? null : (reloadedAt - T) / 60_000,
    3,
  );
}
// The same run without the probe is the control: it must NEVER reload — which is exactly why
// the poll beacon on its own was not enough.
{
  let state = NO_SKEW;
  let reloads = 0;
  for (let t = T; t <= T + 60 * 60_000; t += 6_000) {
    const d = evaluateSkew({ ...base, serverBuild: "old", source: "poll", now: t, streak: state });
    state = d.streak;
    if (d.reload) reloads++;
  }
  check("control: without the unpinned probe the pinned tab never notices", reloads, 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("FAIL: the stale-build reload decision does not match its known answers.");
  process.exit(1);
}
process.exit(0);
