(function () {
  'use strict';
  var doc = document.getElementById('doc');
  if (!doc) return;
  var token = doc.getAttribute('data-token');
  var api = '/v1/cloud/public/documents/' + encodeURIComponent(token);
  var EMOJI = ['\u2764\uFE0F', '\uD83D\uDC4D', '\uD83D\uDD25', '\uD83D\uDC40', '\uD83E\uDD14', '\uD83C\uDF89'];
  var state = { reactions: [], comments: [], agent: null, askAgent: false, sel: null, composing: null };

  function store(name, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(name);
      window.localStorage.setItem(name, value);
    } catch (e) { return null; }
    return value;
  }
  function readerKey() {
    var key = store('kordi.document.readerKey');
    if (key && /^[A-Za-z0-9_-]{16,64}$/.test(key)) return key;
    var bytes = new Uint8Array(18);
    window.crypto.getRandomValues(bytes);
    key = btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    store('kordi.document.readerKey', key);
    return key;
  }
  function readerName() { return (store('kordi.document.readerName') || '').trim(); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  var toastTimer;
  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase() || '?';
  }
  function avatar(author) {
    var a = el('span', 'av');
    var url = author && author.avatarUrl;
    if (url && (/^https:\/\//.test(url) || /^data:image\//.test(url))) {
      var img = el('img'); img.alt = ''; img.src = url; a.appendChild(img);
    } else { a.textContent = initials(author && author.displayName); }
    return a;
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function request(path, body) {
    return fetch(api + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.message || 'Something went wrong');
        return data;
      });
    });
  }
  function load() {
    return request('?readerKey=' + encodeURIComponent(readerKey())).then(function (data) {
      state.reactions = data.reactions || [];
      state.comments = data.comments || [];
      state.agent = data.agent;
      state.askAgent = !!(data.viewerCan && data.viewerCan.askAgent);
      renderAll();
    }).catch(function (e) { toast(e.message); });
  }

  function renderReacts(host, blockId) {
    var groups = {};
    var order = [];
    state.reactions.forEach(function (r) {
      if (r.blockId !== blockId) return;
      if (!groups[r.reaction]) { groups[r.reaction] = { n: 0, mine: false }; order.push(r.reaction); }
      groups[r.reaction].n += 1;
      if (r.mine) groups[r.reaction].mine = true;
    });
    if (!order.length) return;
    var row = el('div', 'reacts');
    order.forEach(function (e) {
      var b = el('button', 'react' + (groups[e].mine ? ' mine' : ''), e + ' ' + groups[e].n);
      b.setAttribute('aria-label', groups[e].n + ' ' + e);
      b.addEventListener('click', function (ev) { ev.stopPropagation(); react(blockId, e); });
      row.appendChild(b);
    });
    host.appendChild(row);
  }
  function commentLine(c, cls) {
    var head = el('div', cls);
    head.appendChild(avatar(c.author));
    var n = el('div', 'n', c.author.displayName);
    n.appendChild(el('span', null, when(c.createdAt)));
    return { head: head, name: n };
  }
  function renderComments(host, blockId) {
    var top = state.comments.filter(function (c) { return c.blockId === blockId && !c.parentCommentId && !c.resolvedAt; });
    top.forEach(function (c) {
      var box = el('div', 'cmt');
      var line = commentLine(c, 'ch');
      line.head.appendChild(line.name);
      box.appendChild(line.head);
      box.appendChild(el('div', 'x', c.body));
      state.comments.filter(function (r) { return r.parentCommentId === c.commentId; }).forEach(function (r) {
        var reply = commentLine(r, 'cr');
        var body = el('div');
        body.appendChild(reply.name);
        body.appendChild(el('div', 'x', r.body));
        reply.head.appendChild(body);
        box.appendChild(reply.head);
      });
      var form = el('div', 'cf');
      var input = el('input');
      input.placeholder = 'Reply';
      input.maxLength = 4000;
      var post = el('button', null, 'Post');
      post.addEventListener('click', function () { postComment(blockId, input.value, c.commentId); });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') post.click(); });
      form.appendChild(input); form.appendChild(post); box.appendChild(form);
      box.addEventListener('click', function (ev) { ev.stopPropagation(); });
      host.appendChild(box);
    });
    if (state.composing === blockId) host.appendChild(composer(blockId));
  }
  function composer(blockId) {
    var box = el('div', 'cmtbox');
    box.addEventListener('click', function (ev) { ev.stopPropagation(); });
    var name = null;
    if (!readerName()) {
      name = el('input', 'nm');
      name.placeholder = 'Your name';
      name.maxLength = 40;
      box.appendChild(name);
    }
    var input = el('input');
    var agent = state.agent && state.agent.displayName;
    input.placeholder = state.askAgent && agent ? 'Add a comment, or @' + agent : 'Add a comment';
    input.maxLength = 4000;
    var post = el('button', null, 'Post');
    post.addEventListener('click', function () {
      if (name) {
        var v = name.value.trim();
        if (!v) { name.focus(); return; }
        store('kordi.document.readerName', v.slice(0, 40));
      }
      postComment(blockId, input.value, null);
    });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') post.click(); });
    box.appendChild(input); box.appendChild(post);
    setTimeout(function () { (name || input).focus(); }, 0);
    return box;
  }
  function renderAll() {
    doc.querySelectorAll('.annot').forEach(function (host) {
      var id = host.getAttribute('data-for');
      host.textContent = '';
      renderReacts(host, id);
      renderComments(host, id);
    });
  }

  function react(blockId, emoji) {
    request('/reactions', { blockId: blockId, reaction: emoji, readerKey: readerKey(), readerName: readerName() || 'Reader' })
      .then(function (data) {
        state.reactions = state.reactions.filter(function (r) { return r.blockId !== blockId; }).concat(data.reactions || []);
        renderAll();
      }).catch(function (e) { toast(e.message); });
  }
  function postComment(blockId, text, parentId) {
    var body = String(text || '').trim();
    if (!body) return;
    var payload = { blockId: blockId, body: body, readerKey: readerKey(), readerName: readerName() || 'Reader' };
    if (parentId) payload.parentCommentId = parentId;
    request('/comments', payload).then(function (comment) {
      state.comments.push(comment);
      state.composing = null;
      renderAll();
      toast('Comment posted');
    }).catch(function (e) { toast(e.message); });
  }

  var tb = document.getElementById('tb');
  var emo = document.getElementById('emo');
  EMOJI.forEach(function (e) {
    var b = el('button', null, e);
    b.setAttribute('aria-label', 'React ' + e);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); var id = state.sel; clearSel(); react(id, e); });
    emo.appendChild(b);
  });
  function clearSel() {
    doc.querySelectorAll('.block.sel').forEach(function (b) { b.classList.remove('sel'); });
    tb.hidden = true; emo.hidden = true; state.sel = null;
  }
  doc.addEventListener('click', function (ev) {
    var block = ev.target.closest('.block');
    if (!block || ev.target.closest('a')) return;
    ev.stopPropagation();
    var id = block.getAttribute('data-block');
    if (state.sel === id) { clearSel(); return; }
    clearSel();
    state.sel = id;
    block.classList.add('sel');
    var top = block.offsetTop;
    tb.style.top = Math.max(0, top - 50) + 'px';
    emo.style.top = Math.max(0, top - 100) + 'px';
    tb.hidden = false;
  });
  tb.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-act]');
    if (!btn) return;
    ev.stopPropagation();
    if (btn.getAttribute('data-act') === 'react') { emo.hidden = !emo.hidden; return; }
    state.composing = state.sel;
    clearSel();
    renderAll();
  });
  emo.addEventListener('click', function (ev) { ev.stopPropagation(); });
  document.addEventListener('click', function () { clearSel(); closePeople(); });

  var chip = document.getElementById('authorChip');
  var people = document.getElementById('people');
  function closePeople() { if (chip) { chip.setAttribute('aria-expanded', 'false'); people.hidden = true; } }
  if (chip) {
    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = people.hidden;
      people.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
    });
    people.addEventListener('click', function (ev) { ev.stopPropagation(); });
  }
  load();
})();
