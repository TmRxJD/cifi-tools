// BIG-NUMBER INPUTS. Lifted out of app.js because the COMPANION EXTENSION needs it without
// app.js: shipsPage.js calls attachBigNumberInput, but app.js is 3,100 lines of routing, hunter
// UI and auth that the extension neither loads nor wants. One canonical home, two consumers --
// not a copy in each, which is the parallel-implementation drift this project keeps paying for.
//
// Depends only on window.CostFormulas (fmtBig / parseBig), so it is origin- and page-agnostic.

// BIG-NUMBER INPUTS: type the game's notation, see the game's notation.
//
// Progression counters and fleet stats run to 2.27e17 and beyond, and a raw <input type="number">
// makes the user read and retype "227254992551159000" -- unreadable, and easy to get wrong by an
// order of magnitude without noticing. The game and this tool both DISPLAY "227.25qa", so the
// input should accept it.
//
// ONE helper, applied at every such site, rather than per-field handling: the parse and the format
// must agree everywhere, and CostFormulas owns both halves (fmtBig / parseBig share one suffix
// ladder). The element becomes type="text" because type="number" rejects "227.25qa" outright --
// the browser blanks the value rather than letting us read it.
//
// The RAW number is what is stored; the formatted string is only what is shown. While the field has
// focus the raw digits are shown so the value can be edited precisely; on blur it reformats. That
// is why `dataset.raw` exists rather than reading the number back out of the display text -- a
// round trip through "227.25qa" loses precision, and writing that back would silently change the
// user's data every time they clicked a field.
function attachBigNumberInput(el, { get, set, onChange }) {
  if (!el) return;
  el.type = 'text';
  el.inputMode = 'decimal';
  el.autocomplete = 'off';
  const show = () => {
    const v = Number(get()) || 0;
    el.dataset.raw = String(v);
    // fmtBig renders anything under 1000 as "179.00" -- correct for a cost, wrong for a counter,
    // which is a whole number and should read as one. Abbreviate only where abbreviating helps.
    el.value = v < 1000 ? String(v) : window.CostFormulas.fmtBig(v);
    el.classList.remove('border-red-500');
  };
  el.addEventListener('focus', () => { el.value = el.dataset.raw || '0'; el.select(); });
  el.addEventListener('input', () => {
    const parsed = window.CostFormulas.parseBig(el.value);
    // UNPARSEABLE IS FLAGGED, NEVER COERCED. Falling back to 0 would silently wipe a real counter
    // the moment a user mistyped a suffix -- the silent-zero failure this project bans.
    el.classList.toggle('border-red-500', el.value.trim() !== '' && parsed === null);
    if (parsed === null) return;
    el.dataset.raw = String(parsed);
    set(parsed);
    if (onChange) onChange(parsed);
  });
  el.addEventListener('blur', show);
  show();
}
window.attachBigNumberInput = attachBigNumberInput;
