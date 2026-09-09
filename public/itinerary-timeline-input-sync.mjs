// J2C-1.2 real-device input persistence hardening.
// A visible timeline is still only a draft. Pressing the main itinerary Save
// is itself an explicit persistence action, so flush the focused iPhone value
// and apply the currently visible timeline before the existing save handler runs.

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

function flushDurationInputs() {
  document.querySelectorAll(DURATION_SELECTOR).forEach(commitDurationInput);
}

document.addEventListener('input', event => {
  const input = event.target?.closest?.(DURATION_SELECTOR);
  if (!input) return;
  commitDurationInput(input);
}, true);

document.addEventListener('click', event => {
  const button = event.target?.closest?.('button');
  if (!button?.matches?.('[data-j2c-apply], [data-it2-save]')) return;
  flushDurationInputs();

  // User feedback showed that requiring both “套用此時間軸” and “儲存修改”
  // is not intuitive. The main Save is an explicit user action, so make it
  // consume the currently visible timeline without silently saving beforehand.
  if (button.matches('[data-it2-save]')) {
    const apply = document.querySelector('[data-j2c-apply]');
    if (apply) apply.click();
  }
}, true);

window.TwinItineraryTimelineInputSync = Object.freeze({ version: 'J2C-1.2' });
