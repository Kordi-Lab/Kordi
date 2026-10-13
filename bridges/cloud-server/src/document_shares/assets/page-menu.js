(function () {
  'use strict';
  // The selection menu: a text selection inside one block shows Comment and
  // React just above it. Works with mouse drags and touch selections
  // (Safari on iPhone) through selectionchange.
  var doc = document.getElementById('doc');
  var menu = document.getElementById('menu');
  var emo = document.getElementById('emo');
  if (!doc || !menu || !emo || !window.KordiDoc) return;
  var EMOJI = ['\u2764\uFE0F', '\uD83D\uDC4D', '\uD83D\uDD25', '\uD83D\uDC40', '\uD83E\uDD14', '\uD83C\uDF89'];
  var GAP = 8;
  var EDGE = 8;
  var current = null; // { blockId, range } while a selection is showing the menu
  var emojiBlock = null;

  EMOJI.forEach(function (e) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.setAttribute('aria-label', 'React ' + e);
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    b.addEventListener('click', function () {
      var blockId = emojiBlock;
      hideAll(true);
      if (blockId) window.KordiDoc.react(blockId, e);
    });
    emo.appendChild(b);
  });

  function blockOf(node) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    var block = element && element.closest('[data-block]');
    return block && doc.contains(block) ? block : null;
  }

  function selectionTarget() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!String(sel).trim()) return null;
    var start = blockOf(range.startContainer);
    var end = blockOf(range.endContainer);
    if (!start || start !== end) return null;
    return { blockId: start.getAttribute('data-block'), range: range };
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function place() {
    if (!current) return;
    var rect = current.range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideAll(false); return; }
    var width = menu.offsetWidth;
    var height = menu.offsetHeight;
    var left = clamp(rect.left + rect.width / 2 - width / 2, EDGE, window.innerWidth - width - EDGE);
    var top = rect.top - height - GAP;
    var below = top < EDGE;
    if (below) top = rect.bottom + GAP;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.classList.toggle('below', below);
    if (!emo.hidden) placeEmojiUnder(menu.getBoundingClientRect());
  }

  function placeEmojiUnder(anchor) {
    var width = emo.offsetWidth;
    var left = clamp(anchor.left + anchor.width / 2 - width / 2, EDGE, window.innerWidth - width - EDGE);
    var top = anchor.bottom + 6;
    if (top + emo.offsetHeight > window.innerHeight - EDGE) top = anchor.top - emo.offsetHeight - 6;
    emo.style.left = left + 'px';
    emo.style.top = top + 'px';
  }

  function hideAll(collapse) {
    current = null;
    emojiBlock = null;
    menu.hidden = true;
    emo.hidden = true;
    if (collapse) {
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  }

  function update() {
    var target = selectionTarget();
    if (!target) {
      if (current) hideAll(false);
      return;
    }
    if (!current && window.KordiDoc.closePeople) window.KordiDoc.closePeople();
    var changedBlock = !current || current.blockId !== target.blockId;
    current = target;
    if (changedBlock) emo.hidden = true;
    menu.hidden = false;
    place();
  }

  var timer = null;
  document.addEventListener('selectionchange', function () {
    clearTimeout(timer);
    timer = setTimeout(update, 60);
  });
  window.addEventListener('scroll', function () { if (current) place(); else if (!emo.hidden && emojiBlock) emo.hidden = true; }, { passive: true, capture: true });
  window.addEventListener('resize', function () { if (current) place(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && (!menu.hidden || !emo.hidden)) hideAll(true);
  });
  document.addEventListener('mousedown', function (ev) {
    if (!menu.contains(ev.target) && !emo.contains(ev.target)) emo.hidden = true;
  });

  // Keep the selection while pressing menu buttons.
  menu.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
  menu.addEventListener('click', function (ev) {
    var button = ev.target.closest('[data-act]');
    if (!button || !current) return;
    var blockId = current.blockId;
    if (button.getAttribute('data-act') === 'comment') {
      hideAll(true);
      window.KordiDoc.openComposer(blockId);
      return;
    }
    emojiBlock = blockId;
    emo.hidden = !emo.hidden;
    if (!emo.hidden) placeEmojiUnder(menu.getBoundingClientRect());
  });

  window.KordiDoc.hideMenu = function () { hideAll(true); };
  // Annotations under a block changed height; follow the selection.
  window.KordiDoc.placeMenu = place;

  window.KordiDoc.showEmoji = function (anchor, blockId) {
    emojiBlock = blockId;
    emo.hidden = false;
    placeEmojiUnder(anchor.getBoundingClientRect());
  };
})();
