(function () {
  'use strict';
  // Reactions and comments for the public document page. The selection menu
  // lives in page-menu.js and calls window.KordiDoc.
  var doc = document.getElementById('doc');
  if (!doc) return;
  var token = doc.getAttribute('data-token');
  var api = '/v1/cloud/public/documents/' + encodeURIComponent(token);
  var state = { reactions: [], comments: [], agent: null, askAgent: false, composing: null, replying: null };

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
    }).catch(function () {
      throw new Error('No connection');
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
      b.type = 'button';
      b.setAttribute('aria-pressed', String(groups[e].mine));
      b.setAttribute('aria-label', e + ' ' + groups[e].n);
      b.addEventListener('click', function () { react(blockId, e); });
      row.appendChild(b);
    });
    host.appendChild(row);
  }

  // A composer from the page template; the name field only until a name is stored.
  function composer(blockId, parentId) {
    var box = document.getElementById('composer-template').content.firstElementChild.cloneNode(true);
    var name = box.querySelector('.nm');
    var input = box.querySelector('.tx');
    var post = box.querySelector('.post');
    if (readerName()) { name.remove(); name = null; }
    var agent = state.agent && state.agent.displayName;
    input.placeholder = parentId ? 'Reply' : (state.askAgent && agent ? 'Add a comment, or @' + agent : 'Add a comment');
    function submit() {
      if (name) {
        var given = name.value.trim();
        if (!given) { name.focus(); return; }
        store('kordi.document.readerName', given.slice(0, 40));
      }
      var body = input.value.trim();
      if (!body) { input.focus(); return; }
      post.disabled = true;
      postComment(blockId, body, parentId).then(function (ok) { post.disabled = false; if (!ok) input.focus(); });
    }
    post.addEventListener('click', submit);
    box.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); closeComposer(); }
    });
    return { box: box, focus: function () { (name || input).focus(); } };
  }
  function closeComposer() {
    state.composing = null;
    state.replying = null;
    renderAll();
  }

  function line(c, cls) {
    var head = el('div', cls);
    head.appendChild(avatar(c.author));
    var n = el('div', 'n', c.author.displayName);
    n.appendChild(el('span', null, when(c.createdAt)));
    return { head: head, name: n };
  }
  function renderComments(host, blockId) {
    var focus = null;
    state.comments.filter(function (c) { return c.blockId === blockId && !c.parentCommentId && !c.resolvedAt; }).forEach(function (c) {
      var box = el('div', 'cmt');
      var top = line(c, 'ch');
      top.head.appendChild(top.name);
      box.appendChild(top.head);
      box.appendChild(el('div', 'x', c.body));
      state.comments.filter(function (r) { return r.parentCommentId === c.commentId && !r.resolvedAt; }).forEach(function (r) {
        var reply = line(r, 'cr');
        var body = el('div');
        body.appendChild(reply.name);
        body.appendChild(el('div', 'x', r.body));
        reply.head.appendChild(body);
        box.appendChild(reply.head);
      });
      if (state.replying === c.commentId) {
        var replyBox = composer(blockId, c.commentId);
        replyBox.box.classList.add('cf');
        box.appendChild(replyBox.box);
        focus = replyBox;
      } else {
        var open = el('button', 'replyto', 'Reply');
        open.type = 'button';
        open.addEventListener('click', function () { state.replying = c.commentId; state.composing = null; renderAll(); });
        box.appendChild(open);
      }
      host.appendChild(box);
    });
    if (state.composing === blockId) {
      var fresh = composer(blockId, null);
      host.appendChild(fresh.box);
      focus = fresh;
    }
    return focus;
  }
  function renderAll() {
    var focus = null;
    doc.querySelectorAll('.annot').forEach(function (host) {
      var id = host.getAttribute('data-for');
      host.textContent = '';
      renderReacts(host, id);
      focus = renderComments(host, id) || focus;
    });
    if (focus) focus.focus();
  }

  function react(blockId, emoji) {
    request('/reactions', { blockId: blockId, reaction: emoji, readerKey: readerKey(), readerName: readerName() || 'Reader' })
      .then(function (data) {
        state.reactions = state.reactions.filter(function (r) { return r.blockId !== blockId; }).concat(data.reactions || []);
        renderAll();
      }).catch(function (e) { toast(e.message); });
  }
  function postComment(blockId, body, parentId) {
    var payload = { blockId: blockId, body: body, readerKey: readerKey(), readerName: readerName() || 'Reader' };
    if (parentId) payload.parentCommentId = parentId;
    return request('/comments', payload).then(function (comment) {
      state.comments.push(comment);
      state.composing = null;
      state.replying = null;
      renderAll();
      toast('Comment posted');
      return true;
    }).catch(function (e) { toast(e.message); return false; });
  }

  // HTML documents render in a frame; their actions sit under it.
  doc.querySelectorAll('[data-frame-act]').forEach(function (button) {
    button.addEventListener('click', function () {
      var act = button.getAttribute('data-frame-act');
      if (act === 'comment') window.KordiDoc.openComposer('b0');
      else window.KordiDoc.showEmoji(button, 'b0');
    });
  });

  // The People card under the @author chip, clamped to the viewport.
  var chip = document.getElementById('authorChip');
  var people = document.getElementById('people');
  function placePeople() {
    var rect = chip.getBoundingClientRect();
    var width = people.offsetWidth;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    var top = rect.bottom + 6;
    if (top + people.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - people.offsetHeight - 6);
    people.style.left = left + 'px';
    people.style.top = top + 'px';
  }
  function closePeople() {
    if (!chip || people.hidden) return;
    people.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  }
  if (chip) {
    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!people.hidden) { closePeople(); return; }
      if (window.KordiDoc.hideMenu) window.KordiDoc.hideMenu();
      people.hidden = false;
      chip.setAttribute('aria-expanded', 'true');
      placePeople();
    });
    people.addEventListener('click', function (ev) { ev.stopPropagation(); });
    document.addEventListener('click', closePeople);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePeople(); });
    window.addEventListener('resize', function () { if (!people.hidden) placePeople(); });
    window.addEventListener('scroll', function () { if (!people.hidden) placePeople(); }, { passive: true });
  }

  window.KordiDoc = {
    react: react,
    toast: toast,
    openComposer: function (blockId) { state.composing = blockId; state.replying = null; renderAll(); },
    showEmoji: function () {},
    hideMenu: null,
    closePeople: closePeople
  };
  load();
})();
