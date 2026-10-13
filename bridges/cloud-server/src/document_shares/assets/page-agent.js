(function () {
  'use strict';
  // Agent pieces of the public document page: the agent avatar and tag, the
  // "is working" and "Could not answer" lines, the mention button, and the
  // refresh timer. page.js builds threads with these through window.KordiAgent.
  var SVG = 'http://www.w3.org/2000/svg';
  var GLYPH = [
    'M12 5c.6 4.2 2.3 6.4 7 7-4.7.6-6.4 2.8-7 7-.6-4.2-2.3-6.4-7-7 4.7-.6 6.4-2.8 7-7z',
    'M18.5 2.5c.2 1.4.8 2 2 2.2-1.2.2-1.8.8-2 2.2-.2-1.4-.8-2-2-2.2 1.2-.2 1.8-.8 2-2.2z'
  ];
  var EVERY_MS = 4000;
  var LIMIT_MS = 120000;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function avatar() {
    var a = el('span', 'av agent');
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    GLYPH.forEach(function (d) {
      var path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    a.appendChild(svg);
    return a;
  }
  function tag() { return el('span', 'tag', 'Agent'); }
  function system(text) { return el('div', 'sys', text); }

  function status(comment) { return comment && comment.agentRun ? comment.agentRun.status : null; }
  function isWorking(comment) {
    var s = status(comment);
    return s === 'queued' || s === 'running';
  }
  function anyWorking(comments) { return (comments || []).some(isWorking); }

  function working(name) {
    var row = el('div', 'work');
    row.appendChild(el('span', null, (name || 'Agent') + ' is working'));
    var dots = el('span', 'dots');
    dots.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i += 1) dots.appendChild(el('i'));
    row.appendChild(dots);
    return row;
  }
  // `retry` is called with the button; without it the line has no action.
  function failed(retry) {
    var row = el('div', 'fail');
    row.appendChild(el('span', null, 'Could not answer'));
    if (retry) {
      var button = el('button', 'retry', 'Retry');
      button.type = 'button';
      button.addEventListener('click', function () { retry(button); });
      row.appendChild(button);
    }
    return row;
  }

  // For one thread in order: the system replies that only repeat a failed
  // run, and the failed comments that were asked again since.
  function threadFacts(thread) {
    var hidden = {};
    var retried = {};
    thread.forEach(function (c, i) {
      if (status(c) !== 'failed') return;
      for (var j = i + 1; j < thread.length; j += 1) {
        var later = thread[j];
        if (later.kind === 'system' && !hidden[later.commentId]) { hidden[later.commentId] = true; break; }
      }
      retried[c.commentId] = thread.slice(i + 1).some(function (later) {
        return later.agentRun && later.body === c.body;
      });
    });
    return { hidden: hidden, retried: retried };
  }

  // Shows the "@Agent" button of a composer and inserts the mention at the caret.
  function mention(button, input, name) {
    if (!button) return;
    if (!name) { button.remove(); return; }
    button.textContent = '@' + name;
    button.setAttribute('aria-label', 'Mention ' + name);
    button.hidden = false;
    button.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    button.addEventListener('click', function () {
      var value = input.value;
      var start = input.selectionStart == null ? value.length : input.selectionStart;
      var end = input.selectionEnd == null ? start : input.selectionEnd;
      var before = value.slice(0, start);
      var after = value.slice(end);
      var text = (before && !/\s$/.test(before) ? ' ' : '') + '@' + name + (/^\s/.test(after) ? '' : ' ');
      input.value = before + text + after;
      var caret = before.length + text.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  }

  // Calls `refresh` every four seconds while `busy()` holds, for two minutes
  // from the last `restart`.
  function watcher(busy, refresh) {
    var timer = null;
    var until = 0;
    function check(restart) {
      if (!busy()) { clearTimeout(timer); timer = null; until = 0; return; }
      if (restart || !until) until = Date.now() + LIMIT_MS;
      if (timer || Date.now() >= until) return;
      timer = setTimeout(function () { timer = null; refresh(); }, EVERY_MS);
    }
    return check;
  }

  window.KordiAgent = {
    avatar: avatar,
    tag: tag,
    system: system,
    status: status,
    isWorking: isWorking,
    anyWorking: anyWorking,
    working: working,
    failed: failed,
    threadFacts: threadFacts,
    mention: mention,
    watcher: watcher
  };
})();
