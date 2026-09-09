// J2C-1.1 real-device input persistence hardening.
// iPhone Safari can keep a focused number input's latest value from reaching
// the timeline state before a tap on Apply/Save. Mirror every input event to
// the existing change-based timeline handler, and force one final sync before
// explicit apply/save actions.

const DURATION_SELECTOR = '[data-j2c-duration]';

function validDurationInput(input) {
  if (!input?.matches?.(DURATION_SELECTOR)) return false;
  const raw = String(input.value ?? '').trim();
  if (!raw) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0;
}

function commitDurationInput(input) {
  if (!validDurationInput(input)) return;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('input', event => {
  const input = event.target?.closest?.(DURATION_SELECTOR);
  if (!input) return;
  commitDurationInput(input);
}, true);

document.addEventListener('click', event => {
  const button = event.target?.closest?.('button');
  if (!button?.matches?.('[data-j2c-apply], [data-it2-save]')) return;
  document.querySelectorAll(DURATION_SELECTOR).forEach(commitDurationInput);
}, true);

window.TwinItineraryTimelineInputSync = Object.freeze({ version: 'J2C-1.1' });
