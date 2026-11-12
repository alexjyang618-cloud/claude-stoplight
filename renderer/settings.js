const $ = (id) => document.getElementById(id);

// the delay and the sound only mean something while notifications are on
function syncNotify() {
  $('notifyAfter').disabled = !$('notify').checked;
  $('notifySound').disabled = !$('notify').checked;
}

window.stoplight.getSettings().then((s) => {
  $('size').value = s.sizePct;
  $('sizeVal').textContent = `${s.sizePct}%`;
  $('dim').checked = s.dimIdle;
  $('ghost').checked = s.clickThroughIdle;
  $('notify').checked = s.notify;
  $('notifyAfter').value = s.notifyAfterSec;
  $('notifySound').checked = s.notifySound;
  $('prune').value = s.pruneHours;
  $('port').value = s.port;
  $('ver').textContent = s.version;
  syncNotify();
});

$('size').addEventListener('input', () => {
  $('sizeVal').textContent = `${$('size').value}%`;
});

$('notify').addEventListener('change', syncNotify);

function save() {
  window.stoplight.saveSettings({
    sizePct: Number($('size').value),
    dimIdle: $('dim').checked,
    clickThroughIdle: $('ghost').checked,
    notify: $('notify').checked,
    notifyAfterSec: Number($('notifyAfter').value),
    notifySound: $('notifySound').checked,
    pruneHours: Number($('prune').value),
    port: Number($('port').value),
  });
  window.close();
}

$('save').addEventListener('click', save);
$('cancel').addEventListener('click', () => window.close());

// Return takes the primary action and Esc cancels, as in any dialog. A
// focused button keeps Return for itself, and so does an input method that is
// still composing.
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    window.close();
  } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    save();
  }
});
