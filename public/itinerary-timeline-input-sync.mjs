// J2C-1.2 real-device input persistence hardening.
// A visible timeline is still only a draft. A manual dwell-time edit is an
// explicit scheduling intent, so the main itinerary Save may persist that edit
// even when the user skips the separate “套用此時間軸” button. A pure J2B route
// save must remain route-only and must not activate the J2C schedule schema.

const DURATION_SELECTOR = '[data-j2c-duration]';
let manualDurationDirty = false;

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

function invalidatesTimeline(button) {
  return button?.matches?.('[data-j2b2-calc], [data-j2b2-apply], [data-it2-move], [data-it2-remove], [data-it2-back-pick], [data-it2-edit-basic], [data-it2-new], [data-it2-open], [data-it2-back-list]');
}

document.addEventListener('input', event => {
  const input = event.target?.closest?.(DURATION_SELECTOR);
  if (!input) return;
  manualDurationDirty = true;
  commitDurationInput(input);
}, true);

document.addEventListener('click', event => {
  const button = event.target?.closest?.('button');
  if (!button) return;

  if (invalidatesTimeline(button)) {
    manualDurationDirty = false;
    return;
  }

  if (!button.matches('[data-j2c-apply], [data-it2-save]')) return;
  flushDurationInputs();

  if (button.matches('[data-j2c-apply]')) {
    manualDurationDirty = false;
    return;
  }

  // Direct Save only promotes the timeline when the user actually edited a
  // dwell-time field. Smart defaults alone must not convert a route-only J2B
  // save into a J2C schedule save.
  if (button.matches('[data-it2-save]') && manualDurationDirty) {
    const apply = document.querySelector('[data-j2c-apply]');
    if (apply) apply.click();
    manualDurationDirty = false;
  }
}, true);

window.TwinItineraryTimelineInputSync = Object.freeze({ version: 'J2C-1.2' });
