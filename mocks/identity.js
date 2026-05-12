/* =============================================================
   doclayer identity + comment-persistence layer.

   Two localStorage keyspaces:
     doclayer-user        → {handle, color, avatar, createdAt}
     doclayer-comments-v2 → { [handle]: { [scenarioId]: [Comment] } }

   Public globals:
     window.doclayerIdentity  — get/ensure/update/clear/onChange
     window.doclayerComments  — allForScenario / save / resolve / remove …
     window.doclayerEnsureIdentity()  — convenience shortcut
     window.doclayerCommentsToRender  — array pre-populated for comments.js

   Listens for CustomEvents emitted by comments.js:
     doclayer:comment-saved      → persist comment
     doclayer:comment-resolved   → flip resolved flag
   ============================================================= */
(function () {
  'use strict';

  var USER_KEY     = 'doclayer-user';
  var COMMENTS_KEY = 'doclayer-comments-v2';

  // -------- storage helpers ----------------------------------
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  // -------- identity derivation ------------------------------
  // Deterministic 32-bit hash (djb2 variant) so handle → color is stable.
  function hashHandle(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }
  function colorFor(handle) {
    var h = hashHandle(handle.toLowerCase());
    var hue = h % 360;
    // saturation 60-70%, lightness 55-65% — vibrant, readable on dark bg.
    var sat = 60 + (h % 11);
    var lig = 55 + ((h >> 4) % 11);
    return 'hsl(' + hue + ', ' + sat + '%, ' + lig + '%)';
  }
  function avatarFor(handle) {
    var clean = String(handle || '').replace(/[^A-Za-z0-9]/g, '');
    var src = clean || handle || '?';
    return src.slice(0, 2).toUpperCase();
  }
  function decorate(record) {
    if (!record) return null;
    return {
      handle: record.handle,
      color: record.color || colorFor(record.handle),
      avatar: avatarFor(record.handle),
      createdAt: record.createdAt,
    };
  }

  // -------- onChange subscribers ------------------------------
  var subscribers = [];
  function notify(identity) {
    subscribers.forEach(function (fn) {
      try { fn(identity); } catch (e) { /* swallow */ }
    });
  }

  // -------- identity store ------------------------------------
  function getStored() {
    return decorate(readJSON(USER_KEY, null));
  }
  function setStored(handle) {
    var trimmed = String(handle || '').trim();
    if (!trimmed) throw new Error('empty handle');
    var record = {
      handle: trimmed,
      color: colorFor(trimmed),
      createdAt: new Date().toISOString(),
    };
    writeJSON(USER_KEY, record);
    var id = decorate(record);
    notify(id);
    try { document.dispatchEvent(new CustomEvent('doclayer:identity-ready', { detail: id })); } catch (e) {}
    return id;
  }
  function clearStored() {
    try { localStorage.removeItem(USER_KEY); } catch (e) {}
    notify(null);
  }

  // -------- onboarding modal ----------------------------------
  var modalEl = null;
  var modalPending = null; // {resolve, reject} for current ensure() promise

  function buildModal(prefill) {
    var wrap = document.createElement('div');
    wrap.className = 'id-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML =
      '<div class="id-modal-scrim"></div>' +
      '<div class="id-modal-card" role="document">' +
        '<div class="id-modal-title">the harness needs to know what to call you</div>' +
        '<div class="id-modal-lede">you\'ll show up in the loop as this handle. you can change it later.</div>' +
        '<input class="id-modal-input" type="text" maxlength="20" placeholder="your handle…" autocomplete="off" spellcheck="false" />' +
        '<div class="id-modal-err" aria-live="polite"></div>' +
        '<div class="id-modal-row">' +
          '<button class="id-modal-cancel" type="button">cancel</button>' +
          '<button class="id-modal-submit" type="button">join the loop ↗</button>' +
        '</div>' +
      '</div>';
    var input = wrap.querySelector('.id-modal-input');
    if (prefill) input.value = prefill;
    return wrap;
  }

  function closeModal(reason) {
    if (!modalEl) return;
    if (modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
    document.body.classList.remove('id-modal-open');
    if (modalPending && reason === 'cancel') {
      modalPending.reject(new Error('cancelled'));
    }
    modalPending = null;
  }

  function openModal(opts) {
    opts = opts || {};
    if (modalEl) closeModal('cancel');
    modalEl = buildModal(opts.prefill);
    document.body.appendChild(modalEl);
    document.body.classList.add('id-modal-open');

    var input  = modalEl.querySelector('.id-modal-input');
    var errEl  = modalEl.querySelector('.id-modal-err');
    var submit = modalEl.querySelector('.id-modal-submit');
    var cancel = modalEl.querySelector('.id-modal-cancel');
    var scrim  = modalEl.querySelector('.id-modal-scrim');

    setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 40);

    function fail(msg) { errEl.textContent = msg; input.focus(); }
    function commit() {
      var v = input.value.trim();
      if (v.length < 1) return fail('your handle can\'t be empty.');
      if (v.length > 20) return fail('keep it under 20 characters.');
      if (/^\s*$/.test(v)) return fail('your handle can\'t be only whitespace.');
      var id = setStored(v);
      var pending = modalPending;
      modalPending = null;
      closeModal('commit');
      if (pending) pending.resolve(id);
      if (opts.onCommit) opts.onCommit(id);
    }

    submit.addEventListener('click', commit);
    cancel.addEventListener('click', function () { closeModal('cancel'); });
    scrim.addEventListener('click', function () { closeModal('cancel'); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeModal('cancel'); }
    });
  }

  // -------- comment storage -----------------------------------
  function readAllComments() { return readJSON(COMMENTS_KEY, {}); }
  function writeAllComments(obj) { writeJSON(COMMENTS_KEY, obj); }

  function commentsFor(handle, scenarioId) {
    if (!handle) return [];
    var all = readAllComments();
    var u = all[handle] || {};
    return (u[scenarioId] || []).slice();
  }
  function commentsForCurrentUser() {
    var id = getStored();
    if (!id) return {};
    var all = readAllComments();
    return all[id.handle] || {};
  }

  function saveComment(comment) {
    var id = getStored();
    if (!id) return null;
    var all = readAllComments();
    var bucket = all[id.handle] || (all[id.handle] = {});
    var scenario = comment.scenario || 'unknown';
    var list = bucket[scenario] || (bucket[scenario] = []);
    var stored = Object.assign({
      id: 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      createdAt: new Date().toISOString(),
      resolved: false,
      author: { handle: id.handle, color: id.color },
    }, comment);
    // Don't double-insert if comments.js already assigned an id we've stored.
    var existing = list.findIndex(function (c) { return c.id === stored.id; });
    if (existing >= 0) list[existing] = stored;
    else list.push(stored);
    writeAllComments(all);
    return stored;
  }

  function resolveComment(commentId) {
    var id = getStored();
    if (!id) return;
    var all = readAllComments();
    var bucket = all[id.handle];
    if (!bucket) return;
    Object.keys(bucket).forEach(function (sc) {
      bucket[sc].forEach(function (c) { if (c.id === commentId) c.resolved = true; });
    });
    writeAllComments(all);
  }

  function removeComment(commentId) {
    var id = getStored();
    if (!id) return;
    var all = readAllComments();
    var bucket = all[id.handle];
    if (!bucket) return;
    Object.keys(bucket).forEach(function (sc) {
      bucket[sc] = bucket[sc].filter(function (c) { return c.id !== commentId; });
    });
    writeAllComments(all);
  }

  function clearCurrentUserComments() {
    var id = getStored();
    if (!id) return;
    var all = readAllComments();
    delete all[id.handle];
    writeAllComments(all);
  }

  // -------- public APIs ---------------------------------------
  window.doclayerIdentity = {
    get: getStored,
    ensure: function () {
      var id = getStored();
      if (id) return Promise.resolve(id);
      return new Promise(function (resolve, reject) {
        modalPending = { resolve: resolve, reject: reject };
        openModal({});
      });
    },
    update: function (handle) { return setStored(handle); },
    clear: function () { clearStored(); },
    onChange: function (fn) { if (typeof fn === 'function') subscribers.push(fn); },
  };
  window.doclayerEnsureIdentity = function () {
    return window.doclayerIdentity.ensure();
  };

  window.doclayerComments = {
    allForScenario: function (scenarioId) {
      var id = getStored();
      return id ? commentsFor(id.handle, scenarioId) : [];
    },
    allForUserScenario: function (handle, scenarioId) {
      return commentsFor(handle, scenarioId);
    },
    save: saveComment,
    resolve: resolveComment,
    remove: removeComment,
    allForCurrentUser: commentsForCurrentUser,
  };

  // -------- event bridge from comments.js ---------------------
  document.addEventListener('doclayer:comment-saved', function (e) {
    if (!e.detail) return;
    saveComment(e.detail);
  });
  document.addEventListener('doclayer:comment-resolved', function (e) {
    if (!e.detail) return;
    resolveComment(e.detail.id || e.detail);
  });

  // -------- scenario detection (mirrors feedback.js) ----------
  function detectScenario() {
    var body = document.body;
    if (body && body.dataset && body.dataset.scenario) return body.dataset.scenario;
    var fb = document.querySelector('.fb-panel[data-scenario]');
    if (fb && fb.dataset.scenario) return fb.dataset.scenario;
    var path = (location.pathname || '').split('/').pop() || '';
    return path.replace(/\.html?$/i, '') || 'index';
  }

  // -------- settings gear UI ----------------------------------
  function buildGear() {
    if (document.querySelector('.id-gear')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'id-gear';
    btn.setAttribute('aria-label', 'identity settings');
    btn.innerHTML = '<span class="id-gear-icon">⚙</span><span class="id-gear-avatar" aria-hidden="true"></span>';
    document.body.appendChild(btn);

    var panel = document.createElement('aside');
    panel.className = 'id-settings';
    panel.setAttribute('aria-hidden', 'true');
    document.body.appendChild(panel);

    var scrim = document.createElement('div');
    scrim.className = 'id-settings-scrim';
    document.body.appendChild(scrim);

    function paintGear() {
      var id = getStored();
      var av = btn.querySelector('.id-gear-avatar');
      if (id) {
        av.style.display = 'inline-flex';
        av.style.background = id.color;
        av.textContent = id.avatar;
      } else {
        av.style.display = 'none';
        av.textContent = '';
      }
    }

    function renderPanel() {
      var id = getStored();
      var scenario = detectScenario();
      var myAll = commentsForCurrentUser();
      var totalCount = 0;
      Object.keys(myAll).forEach(function (k) { totalCount += (myAll[k] || []).length; });
      var thisCount = (myAll[scenario] || []).length;

      if (!id) {
        panel.innerHTML =
          '<div class="id-set-head"><span>identity</span>' +
            '<button class="id-set-close" type="button" aria-label="close">×</button></div>' +
          '<div class="id-set-body">' +
            '<div class="id-set-anon">you\'re anonymous. drop a comment or join the loop to claim a handle.</div>' +
            '<button class="id-set-action id-set-join" type="button">join the loop ↗</button>' +
          '</div>';
      } else {
        panel.innerHTML =
          '<div class="id-set-head"><span>identity</span>' +
            '<button class="id-set-close" type="button" aria-label="close">×</button></div>' +
          '<div class="id-set-body">' +
            '<div class="id-set-you">' +
              '<span class="id-set-avatar" style="background:' + id.color + '">' + escapeHtml(id.avatar) + '</span>' +
              '<span class="id-set-handle">' + escapeHtml(id.handle) + '</span>' +
            '</div>' +
            '<div class="id-set-stats">your comments · <b>' + totalCount + '</b> total · <b>' + thisCount + '</b> in this scenario</div>' +
            '<button class="id-set-action id-set-change" type="button">change handle</button>' +
            '<button class="id-set-action id-set-see" type="button">see all your comments →</button>' +
            '<button class="id-set-action id-set-danger id-set-forget" type="button">forget me</button>' +
          '</div>';
      }
      bindPanel(id);
    }

    function bindPanel(id) {
      var close = panel.querySelector('.id-set-close');
      if (close) close.addEventListener('click', shut);
      var join = panel.querySelector('.id-set-join');
      if (join) join.addEventListener('click', function () {
        shut();
        window.doclayerIdentity.ensure().then(function () {}).catch(function () {});
      });
      var change = panel.querySelector('.id-set-change');
      if (change) change.addEventListener('click', function () {
        shut();
        openModal({ prefill: id ? id.handle : '' });
      });
      var forget = panel.querySelector('.id-set-forget');
      if (forget) forget.addEventListener('click', function () {
        if (!window.confirm('forget your handle and delete all your comments?')) return;
        clearCurrentUserComments();
        clearStored();
        shut();
      });
      var see = panel.querySelector('.id-set-see');
      if (see) see.addEventListener('click', function () {
        shut();
        openImprovementsModal();
      });
    }

    function open() {
      renderPanel();
      panel.classList.add('is-open');
      scrim.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
    }
    function shut() {
      panel.classList.remove('is-open');
      scrim.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
    }

    btn.addEventListener('click', function () {
      panel.classList.contains('is-open') ? shut() : open();
    });
    scrim.addEventListener('click', shut);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) shut();
    });

    paintGear();
    window.doclayerIdentity.onChange(function () { paintGear(); if (panel.classList.contains('is-open')) renderPanel(); });
  }

  // -------- cross-scenario improvements modal -----------------
  function openImprovementsModal() {
    var existing = document.querySelector('.id-improve');
    if (existing) existing.parentNode.removeChild(existing);
    var all = commentsForCurrentUser();
    var keys = Object.keys(all).sort();
    var html = '<div class="id-modal-scrim"></div><div class="id-improve-card">' +
      '<div class="id-improve-head"><span>your improvements across the loop</span>' +
        '<button class="id-improve-close" type="button" aria-label="close">×</button></div>' +
      '<div class="id-improve-body">';
    if (!keys.length) {
      html += '<div class="id-improve-empty">no comments yet. wander into a scenario, pause time, and drop a thought.</div>';
    } else {
      keys.forEach(function (sc) {
        var list = all[sc] || [];
        if (!list.length) return;
        html += '<div class="id-improve-group">' +
          '<a class="id-improve-sc" href="' + sc + '.html">' + escapeHtml(sc) + ' · ' + list.length + '</a>' +
          '<ul class="id-improve-list">';
        list.slice().reverse().forEach(function (c) {
          var t = c.text || '(no text)';
          var when = c.createdAt ? new Date(c.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          html += '<li class="id-improve-item' + (c.resolved ? ' resolved' : '') + '">' +
            '<span class="id-improve-ts">' + escapeHtml(when) + '</span>' +
            '<span class="id-improve-text">' + escapeHtml(t) + '</span>' +
            (c.response ? '<span class="id-improve-resp">↳ ' + escapeHtml(c.response) + '</span>' : '') +
            '</li>';
        });
        html += '</ul></div>';
      });
    }
    html += '</div></div>';
    var wrap = document.createElement('div');
    wrap.className = 'id-modal id-improve';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    document.body.classList.add('id-modal-open');
    function shut() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      document.body.classList.remove('id-modal-open');
    }
    wrap.querySelector('.id-modal-scrim').addEventListener('click', shut);
    wrap.querySelector('.id-improve-close').addEventListener('click', shut);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { shut(); document.removeEventListener('keydown', esc); }
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  // -------- bootstrap on DOMContentLoaded ---------------------
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () {
    var id = getStored();
    var scenario = detectScenario();
    // Pre-populate the render queue for comments.js (Phase 1).
    if (id) {
      window.doclayerCommentsToRender = commentsFor(id.handle, scenario);
    } else {
      window.doclayerCommentsToRender = [];
    }
    buildGear();
  });
})();
