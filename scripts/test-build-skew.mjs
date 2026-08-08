// Known-answer tests for the stale-build reload decision.
//
//   node scripts/test-build-skew.mjs
//
// The logic is imported straight from src/lib/build-skew.ts (Node strips the types), so what
// is tested here is exactly what ships — that module is dependency-free for this reason, and
// must stay that way. The clock, the localStorage stamp and location.reload() live in the
// caller (src/components/now-playing-context.tsx); everything a wrong answer would cost —
// a reload loop, a page yanked mid-use, a tab that never notices a deploy — is decided here.
import {
  INTERACTION_IDLE_MS,
  MISMATCH_GRACE_MS,
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

// Defaults: skewed, nothing in the way of a reload. Each test overrides one field, so a
// `reload: false` below is always attributable to the thing being tested.
const base = {
  clientBuild: "old",
  serverBuild: "new",
  now: T,
  mismatchSince: null,
  lastReloadAt: null,
  visible: false,
  lastInteractionAt: null,
};
const at = (overrides) => evaluateSkew({ ...base, ...overrides });

// ── Agreement and silence ──────────────────────────────────────────────────────────────
check("matching builds never reload", at({ serverBuild: "old" }), {
  mismatchSince: null,
  reload: false,
});
check(
  "a matching build clears an in-progress streak (the deploy propagated)",
  at({ serverBuild: "old", mismatchSince: T - 10 * 60_000 }),
  { mismatchSince: null, reload: false },
);
check("a missing server build is not evidence of skew", at({ serverBuild: undefined }), {
  mismatchSince: null,
  reload: false,
});
check("a missing client build is not evidence of skew", at({ clientBuild: undefined }), {
  mismatchSince: null,
  reload: false,
});
check("empty strings count as missing, not as a mismatch", at({ clientBuild: "", serverBuild: "" }), {
  mismatchSince: null,
  reload: false,
});

// ── The debounce ───────────────────────────────────────────────────────────────────────
check("a first mismatch starts the streak and does not reload", at({}), {
  mismatchSince: T,
  reload: false,
});
check(
  "still inside the grace window: streak preserved, no reload",
  at({ mismatchSince: T - (MISMATCH_GRACE_MS - 1) }),
  { mismatchSince: T - (MISMATCH_GRACE_MS - 1), reload: false },
);
check(
  "exactly at the grace window the reload fires",
  at({ mismatchSince: T - MISMATCH_GRACE_MS }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: true },
);
// A deploy mid-propagation serves old and new alternately: match → mismatch → match. The
// streak must restart each time, so a flapping edge can never accumulate to the threshold.
{
  let state = null;
  for (const [i, server] of ["new", "old", "new", "old", "new"].entries()) {
    const d = evaluateSkew({
      ...base,
      serverBuild: server,
      now: T + i * 60_000,
      mismatchSince: state,
    });
    state = d.mismatchSince;
    check(`flapping propagation, reply ${i + 1} (${server}) does not reload`, d.reload, false);
  }
  check("flapping leaves only a fresh streak, well short of the threshold", state, T + 4 * 60_000);
}

// ── The reload throttle ────────────────────────────────────────────────────────────────
check(
  "a reload inside the throttle window is suppressed (no reload loop)",
  at({ mismatchSince: T - MISMATCH_GRACE_MS, lastReloadAt: T - (RELOAD_THROTTLE_MS - 1) }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: false },
);
check(
  "once the throttle window has passed, a persisting mismatch reloads again",
  at({ mismatchSince: T - MISMATCH_GRACE_MS, lastReloadAt: T - RELOAD_THROTTLE_MS }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: true },
);
// The worst case the throttle exists for: a beacon that can never agree. Simulated at the
// real 6s poll cadence over an hour — the bound is elapsed/RELOAD_THROTTLE_MS, not per-poll.
{
  let lastReloadAt = null;
  let mismatchSince = null;
  let reloads = 0;
  for (let t = T; t < T + 60 * 60_000; t += 6_000) {
    const d = evaluateSkew({ ...base, now: t, mismatchSince, lastReloadAt });
    mismatchSince = d.mismatchSince;
    if (d.reload) {
      reloads++;
      lastReloadAt = t;
      mismatchSince = null; // a reload restarts the tab, and the streak with it
    }
  }
  check("a permanently broken beacon reloads at most 6x/hour, not per poll", reloads, 6);
}

// ── Deferral while in use ──────────────────────────────────────────────────────────────
check(
  "visible and just used: the reload waits",
  at({
    mismatchSince: T - MISMATCH_GRACE_MS,
    visible: true,
    lastInteractionAt: T - (INTERACTION_IDLE_MS - 1),
  }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: false },
);
check(
  "visible but idle past the window: reload",
  at({
    mismatchSince: T - MISMATCH_GRACE_MS,
    visible: true,
    lastInteractionAt: T - INTERACTION_IDLE_MS,
  }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: true },
);
check(
  "visible but never touched since load: reload",
  at({ mismatchSince: T - MISMATCH_GRACE_MS, visible: true, lastInteractionAt: null }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: true },
);
check(
  "hidden reloads immediately even if it was touched a second ago",
  at({
    mismatchSince: T - MISMATCH_GRACE_MS,
    visible: false,
    lastInteractionAt: T - 1_000,
  }),
  { mismatchSince: T - MISMATCH_GRACE_MS, reload: true },
);
// Deferral must not consume the streak — the whole point is that it fires at the next idle
// moment rather than restarting the 3-minute wait.
{
  const since = T - MISMATCH_GRACE_MS;
  const deferred = at({ mismatchSince: since, visible: true, lastInteractionAt: T - 1_000 });
  check("a deferred reload keeps the streak", deferred.mismatchSince, since);
  const later = evaluateSkew({
    ...base,
    now: T + 60_000,
    mismatchSince: deferred.mismatchSince,
    visible: true,
    lastInteractionAt: T - 1_000, // untouched since
  });
  check("and fires as soon as the user goes idle", later.reload, true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("FAIL: the stale-build reload decision does not match its known answers.");
  process.exit(1);
}
process.exit(0);
