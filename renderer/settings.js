const $ = (id) => document.getElementById(id);

// the delay and the sound only mean something while notifications are on
function syncNotify() {
  $('notifyAfter').disabled = !$('notify').checked;
  $('notifySound').disabled = !$('notify').checked;
}

// How the status line stands, said under its checkbox.
const STATUS_LINE_NOTE = {
  plain: 'Claude Code hands its status line command the 5-hour and weekly figures with every reply. Clawd has registered a silent one to receive them.',
  wrap: 'Your own status line is kept: Clawd runs it unchanged after taking the 5-hour and weekly figures Claude Code hands it. Turning this off puts your entry back exactly as it was.',
  kept: 'You have a status line of your own, and wrapping it did not test cleanly on this computer, so it was left untouched. Usage is read from the usage service instead, less often.',
  off: 'Claude Code hands its status line command the 5-hour and weekly figures with every reply. Clawd registers a silent one to receive them; a status line of your own is kept and still runs.',
};

window.stoplight.getSettings().then((s) => {
  $('size').min = s.sizeMin;
  $('size').max = s.sizeMax;
  $('size').value = s.sizePct;
  $('statusLine').checked = s.statusLine;
  $('statusLineNote').textContent = STATUS_LINE_NOTE[s.statusLine ? s.statusLineState : 'off'] || STATUS_LINE_NOTE.off;
  $('usageRenew').checked = s.usageRenew;
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
    statusLine: $('statusLine').checked,
    usageRenew: $('usageRenew').checked,
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
