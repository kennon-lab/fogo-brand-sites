// Drip scheduling (EMAIL_CAPTURE_SCOPE_v1.md §6.1–6.4): which email, if any, a
// subscriber is due next. Pure (no I/O) so it's unit-tested without a database;
// api/_lib/drip.js does the sending.
//
// Sends are recorded as (sequence, step) with step = 1-based position in the
// list the step came from:
//   <track>            a product track's steps (dispenser, bottles, …)
//   general            the general welcome
//   general-fallback   the no-choice fallback emails
//
// Timing (days are whole 24h periods):
//   product-track signup   step k due at confirmed_at + day_k
//   general, no choice     welcome at confirmed_at; fallback item k at confirmed_at + day_k
//   general → chose T      T's steps from on_choice[T].start_step, due at
//                          track_changed_at + (day_k − day of the step before start_step)
// At most one email per subscriber per run, and never two within MIN_GAP_HOURS
// (the day-0 welcome is exempt), so a subscriber who falls behind catches up
// one email per day instead of getting a burst.

const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_GAP_HOURS = 20;
// The cron runs once a day, so anything due within the next 12h goes out in
// today's run instead of waiting a full extra day.
export const DUE_GRACE_HOURS = 12;

const ts = (v) => (v ? new Date(v).getTime() : null);

/** Ordered candidate list: [{ sequence, step, file, dueAt }] for this subscriber's path. */
export function scheduleFor(seq, sub) {
  const confirmed = ts(sub.confirmed_at);
  const changed = ts(sub.track_changed_at);
  const out = [];
  const push = (sequence, steps, anchor, offsetDay = 0, from = 1) => {
    steps.forEach((s, i) => {
      if (i + 1 < from) return;
      out.push({ sequence, step: i + 1, file: s.file, dueAt: anchor + ((s.day ?? 0) - offsetDay) * DAY_MS });
    });
  };

  const general = seq.tracks.general;
  if (sub.track !== 'general' && changed && general?.on_choice?.[sub.track]) {
    // Chose a track from the general welcome.
    const steps = seq.tracks[sub.track]?.steps ?? [];
    const start = general.on_choice[sub.track].start_step ?? 1;
    const prevDay = start > 1 ? steps[start - 2]?.day ?? 0 : 0;
    push(sub.track, steps, changed, prevDay, start);
  } else if (sub.track === 'general') {
    push('general', general?.steps ?? [], confirmed);
    push('general-fallback', general?.fallback ?? [], confirmed);
  } else {
    push(sub.track, seq.tracks[sub.track]?.steps ?? [], confirmed);
  }
  return out;
}

/**
 * The next email to send now, or null.
 * sub: { track, confirmed_at, track_changed_at, sent: [{ sequence, step, sent_at }] }
 * Returns { sequence, step, file, last } — last = this is the final email of the path.
 */
export function nextDue(seq, sub, now = Date.now()) {
  const sent = new Set((sub.sent ?? []).map((s) => `${s.sequence}#${s.step}`));
  const plan = scheduleFor(seq, sub);
  const pending = plan.filter((p) => !sent.has(`${p.sequence}#${p.step}`));
  if (pending.length === 0) return null;
  const next = pending[0];
  if (next.dueAt > now + DUE_GRACE_HOURS * 60 * 60 * 1000) return null;

  const lastSent = Math.max(0, ...(sub.sent ?? []).map((s) => ts(s.sent_at) ?? 0));
  const isWelcome = next.step === 1 && (next.sequence === 'general' || next.sequence === sub.track) && !ts(sub.track_changed_at);
  if (!isWelcome && lastSent && now - lastSent < MIN_GAP_HOURS * 60 * 60 * 1000) return null;

  return { sequence: next.sequence, step: next.step, file: next.file, last: pending.length === 1 };
}
