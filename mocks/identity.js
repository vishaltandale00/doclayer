/* =============================================================
   doclayer identity layer (Phase 1 — Supabase magic-link auth).

   Replaces the old localStorage-handle layer. Identity is now an
   authenticated Supabase session. When config is missing (no
   SUPABASE_URL/ANON_KEY injected), this falls back to an
   anonymous-localStorage handle so mocks keep working offline.

   Public globals (preserved API surface):
     window.doclayerIdentity  — get/ensure/update/clear/onChange/signOut/getVariantId
     window.doclayerComments  — local-only comment cache (legacy fallback)
     window.doclayerEnsureIdentity()  — convenience shortcut
     window.doclayerCommentsToRender  — array pre-populated for comments.js

   Listens for CustomEvents emitted by comments.js:
     doclayer:comment-saved      → persist comment (local fallback)
     doclayer:comment-resolved   → flip resolved flag
   ============================================================= */
(function () {
  'use strict';

  var USER_KEY     = 'doclayer-user';
  var COMMENTS_KEY = 'doclayer-comments-v2';

  // -------- supabase init -------------------------------------
  var supa = null;          // SupabaseClient | null
  var supaReady = null;     // Promise<SupabaseClient | null>
  var currentSession = null;
  var currentVariantId = null;
  var currentIdentity = null;
  var authSubscription = null; // returned by supabase.auth.onAuthStateChange — unsubscribe on signOut
  var triggerFallbackFired = false; // sticky session flag — surfaces "⚠ degraded mode" pill in gear panel

  // INVARIANT: all writes to `currentIdentity` MUST go through setIdentity().
  // It atomically assigns and notifies subscribers exactly once. Direct
  // assignment elsewhere is a bug — it bypasses notify() and breaks the
  // single-funnel guarantee onAuthStateChange / ensure() / ready() rely on.
  function setIdentity(id) {
    currentIdentity = id;
    try {
      if (window && window.console && typeof console.debug === 'function') {
        console.debug('[doclayer] setIdentity', id && (id.email || id.handle || id.userId) || null);
      }
    } catch (e) { /* swallow */ }
    notify(currentIdentity);
  }

  function getConfig() {
    var c = window.__doclayerConfig || {};
    var url = c.SUPABASE_URL;
    var key = c.SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    if (/^__SUPABASE/.test(url) || /^__SUPABASE/.test(key)) return null; // unsubstituted placeholders
    return { url: url, key: key };
  }

  function initSupabase() {
    if (supaReady) return supaReady;
    var cfg = getConfig();
    if (!cfg) {
      supaReady = Promise.resolve(null);
      return supaReady;
    }
    supaReady = import('https://esm.sh/@supabase/supabase-js@2').then(function (mod) {
      supa = mod.createClient(cfg.url, cfg.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      var sub = supa.auth.onAuthStateChange(function (event, session) {
        currentSession = session || null;
        if (!session) {
          currentVariantId = null;
          setIdentity(null);
          return;
        }
        hydrateFromSession(session).then(function (id) {
          setIdentity(id);
          try { document.dispatchEvent(new CustomEvent('doclayer:identity-ready', { detail: id })); } catch (e) {}
        });
      });
      // supabase-js v2 returns { data: { subscription: { unsubscribe } } } — capture for cleanup.
      authSubscription = (sub && sub.data && sub.data.subscription) || null;
      return supa;
    }).catch(function (err) {
      console.warn('[doclayer] supabase init failed, falling back to local mode', err);
      supa = null;
      return null;
    });
    return supaReady;
  }

  function hydrateFromSession(session) {
    currentSession = session;
    var email = session.user.email || '';
    var color = colorFor(email);
    var avatar = avatarFor(email);
    // Look up (and idempotently provision) the user's main variant via the
    // server. requireAuth() on /api/me handles the create-on-first-call
    // logic that the old DB trigger used to do — no more direct Neon access
    // from the client. Falls back to a no-variant identity if the call
    // fails, so the UI still renders.
    var jwt = session && session.access_token;
    return fetch('/api/me', {
      method: 'GET',
      headers: jwt ? { 'Authorization': 'Bearer ' + jwt } : {},
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, body: j }; },
                            function () { return { status: res.status, body: {} }; });
    }).then(function (out) {
      var variantId = (out.status >= 200 && out.status < 300 && out.body && out.body.variant_id) || null;
      if (!variantId) {
        // /api/me failed — surface degraded mode (mirrors the old trigger-
        // fallback signal). Real prod path is the server returning a valid
        // variant_id; we land here only on network errors or a misconfigured
        // backend.
        console.warn('[doclayer] /api/me did not return a variant_id; rendering in degraded mode', out);
        triggerFallbackFired = true;
        try {
          window.dispatchEvent(new CustomEvent('doclayer:trigger-fallback', {
            detail: { userId: session.user.id, attemptedAt: new Date().toISOString() },
          }));
        } catch (e) { /* swallow */ }
      }
      currentVariantId = variantId;
      return {
        email: email, handle: email, color: color, avatar: avatar,
        variantId: variantId, userId: session.user.id,
      };
    }).catch(function (err) {
      console.warn('[doclayer] /api/me lookup failed', err);
      return { email: email, handle: email, color: color, avatar: avatar, variantId: null, userId: session.user.id };
    });
  }

  // -------- auth header helper (Neon API calls) ---------------
  // Resolves the current Supabase JWT. Returns null when anonymous or when
  // the supabase client failed to initialize. All authed API calls go
  // through here so we have one place to fix if the token shape changes.
  function getJwt() {
    if (!supa) return Promise.resolve(null);
    return supa.auth.getSession().then(function (r) {
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    }).catch(function () { return null; });
  }

  // -------- storage helpers (local fallback) ------------------
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  // -------- color / avatar derivation -------------------------
  function hashHandle(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function colorFor(handle) {
    var h = hashHandle(String(handle || '').toLowerCase());
    var hue = h % 360;
    var sat = 60 + (h % 11);
    var lig = 55 + ((h >> 4) % 11);
    return 'hsl(' + hue + ', ' + sat + '%, ' + lig + '%)';
  }
  function avatarFor(handle) {
    var s = String(handle || '');
    // For emails, prefer the local-part initials.
    if (s.indexOf('@') > 0) s = s.split('@')[0];
    var clean = s.replace(/[^A-Za-z0-9]/g, '');
    var src = clean || s || '?';
    return src.slice(0, 2).toUpperCase();
  }
  function decorate(record) {
    if (!record) return null;
    var handle = record.email || record.handle;
    return {
      handle: handle,
      email: record.email || null,
      color: record.color || colorFor(handle),
      avatar: avatarFor(handle),
      variantId: record.variantId || null,
      userId: record.userId || null,
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

  // -------- local-fallback identity store ---------------------
  function getStoredLocal() {
    return decorate(readJSON(USER_KEY, null));
  }
  function setStoredLocal(handle) {
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
  function clearStoredLocal() {
    try { localStorage.removeItem(USER_KEY); } catch (e) {}
    notify(null);
  }

  function getStored() {
    // In supabase mode, currentIdentity is canonical.
    if (supa) return currentIdentity || null;
    return getStoredLocal();
  }

  // -------- onboarding modal (email magic link) ---------------
  var modalEl = null;
  var modalPending = null;

  function buildModal(mode, prefill) {
    var wrap = document.createElement('div');
    wrap.className = 'id-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    if (mode === 'magic') {
      wrap.innerHTML =
        '<div class="id-modal-scrim"></div>' +
        '<div class="id-modal-card" role="document">' +
          '<div class="id-modal-title">sign in to start your variant</div>' +
          '<div class="id-modal-lede">we\'ll email you a magic link. your variant lives at your email — no password.</div>' +
          '<input class="id-modal-input" type="email" placeholder="you@example.com" autocomplete="email" spellcheck="false" />' +
          '<div class="id-modal-err" aria-live="polite"></div>' +
          '<div class="id-modal-row">' +
            '<button class="id-modal-cancel" type="button">cancel</button>' +
            '<button class="id-modal-submit" type="button">send magic link →</button>' +
          '</div>' +
        '</div>';
    } else {
      // local-fallback handle mode
      wrap.innerHTML =
        '<div class="id-modal-scrim"></div>' +
        '<div class="id-modal-card" role="document">' +
          '<div class="id-modal-title">the harness needs to know what to call you</div>' +
          '<div class="id-modal-lede">running offline — pick a handle. you can change it later.</div>' +
          '<input class="id-modal-input" type="text" maxlength="20" placeholder="your handle…" autocomplete="off" spellcheck="false" />' +
          '<div class="id-modal-err" aria-live="polite"></div>' +
          '<div class="id-modal-row">' +
            '<button class="id-modal-cancel" type="button">cancel</button>' +
            '<button class="id-modal-submit" type="button">join the loop ↗</button>' +
          '</div>' +
        '</div>';
    }
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
    // Fire a modal-closed event so listeners waiting on identity-ready can
    // tear down if the user dismisses the modal without signing in.
    try {
      window.dispatchEvent(new CustomEvent('doclayer:modal-closed', {
        detail: { reason: reason || 'unknown' },
      }));
    } catch (e) { /* swallow */ }
  }

  function showSentConfirmation(card, email) {
    card.innerHTML =
      '<div class="id-modal-title">check your inbox</div>' +
      '<div class="id-modal-lede">we sent a magic link to <b>' + escapeHtml(email) + '</b>. click it to sign in. you can close this dialog.</div>' +
      '<div class="id-modal-row">' +
        '<button class="id-modal-cancel" type="button">close</button>' +
      '</div>';
    card.querySelector('.id-modal-cancel').addEventListener('click', function () { closeModal('commit'); });
  }

  function openModal(opts) {
    opts = opts || {};
    var cfg = getConfig();
    var mode = cfg ? 'magic' : 'local';
    if (modalEl) closeModal('cancel');
    modalEl = buildModal(mode, opts.prefill);
    document.body.appendChild(modalEl);
    document.body.classList.add('id-modal-open');

    var card   = modalEl.querySelector('.id-modal-card');
    var input  = modalEl.querySelector('.id-modal-input');
    var errEl  = modalEl.querySelector('.id-modal-err');
    var submit = modalEl.querySelector('.id-modal-submit');
    var cancel = modalEl.querySelector('.id-modal-cancel');
    var scrim  = modalEl.querySelector('.id-modal-scrim');

    setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 40);

    function fail(msg) { errEl.textContent = msg; input.focus(); }
    function commit() {
      var v = input.value.trim();
      if (mode === 'magic') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail('that doesn\'t look like an email.');
        submit.disabled = true;
        submit.textContent = 'sending…';
        initSupabase().then(function (client) {
          if (!client) { submit.disabled = false; submit.textContent = 'send magic link →'; return fail('auth unavailable — try later.'); }
          return client.auth.signInWithOtp({
            email: v,
            // Strip hash/query so Supabase's appended #access_token=… doesn't collide
            // with any existing fragment state.
            options: { emailRedirectTo: window.location.origin + window.location.pathname },
          }).then(function (res) {
            if (res.error) { submit.disabled = false; submit.textContent = 'send magic link →'; return fail(res.error.message); }
            showSentConfirmation(card, v);
          });
        }).catch(function (err) {
          submit.disabled = false; submit.textContent = 'send magic link →';
          fail((err && err.message) || 'send failed');
        });
        return;
      }
      // local fallback
      if (v.length < 1) return fail('your handle can\'t be empty.');
      if (v.length > 20) return fail('keep it under 20 characters.');
      if (/^\s*$/.test(v)) return fail('your handle can\'t be only whitespace.');
      var id = setStoredLocal(v);
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

  // -------- comment storage (local fallback only) -------------
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

  // -------- supabase signOut (with listener cleanup) ----------
  function doSignOut() {
    if (!supa) return Promise.resolve();
    var p = supa.auth.signOut();
    // Tear down the onAuthStateChange listener so subscribers don't accumulate
    // across sign-in/sign-out cycles within the same page lifetime.
    try {
      if (authSubscription && typeof authSubscription.unsubscribe === 'function') {
        authSubscription.unsubscribe();
      }
    } catch (e) { /* swallow */ }
    authSubscription = null;
    return p;
  }

  // -------- delete-variant (auth mode) ------------------------
  // Hits DELETE /api/me/variant. The server filters by user_id so we can't
  // accidentally drop a row that isn't ours even with a stale session.
  function deleteMyVariant() {
    if (!supa || !currentIdentity || !currentIdentity.variantId) return Promise.resolve(false);
    return getJwt().then(function (jwt) {
      return fetch('/api/me/variant', {
        method: 'DELETE',
        headers: jwt ? { 'Authorization': 'Bearer ' + jwt } : {},
      });
    }).then(function (res) {
      if (!res.ok && res.status !== 204) {
        console.warn('[doclayer] delete variant failed', res.status);
        return false;
      }
      // Cascade kills comments/patches/versions. Sign out after.
      return doSignOut().then(function () { return true; });
    }).catch(function (err) {
      console.warn('[doclayer] delete variant threw', err);
      return false;
    });
  }

  // -------- public APIs ---------------------------------------
  window.doclayerIdentity = {
    get: getStored,
    ensure: function () {
      // Kick off init; if a session exists, resolve from it. Otherwise prompt.
      return initSupabase().then(function (client) {
        if (!client) {
          var id = getStoredLocal();
          if (id) return Promise.resolve(id);
          return new Promise(function (resolve, reject) {
            modalPending = { resolve: resolve, reject: reject };
            openModal({});
          });
        }
        return client.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (session) {
            return hydrateFromSession(session).then(function (id) {
              setIdentity(id);
              return id;
            });
          }
          return new Promise(function (resolve, reject) {
            modalPending = { resolve: resolve, reject: reject };
            openModal({});
          });
        });
      });
    },
    update: function (handle) {
      // In supabase mode, identity comes from the session and cannot be locally rewritten —
      // writing to localStorage here would shadow the canonical identity. No-op with a warn.
      if (supa) {
        console.warn('[doclayer] identity.update() ignored while signed in — identity is owned by the Supabase session.');
        return currentIdentity || null;
      }
      return setStoredLocal(handle);
    },
    clear: function () {
      if (supa) return doSignOut();
      clearStoredLocal();
      return Promise.resolve();
    },
    signOut: function () {
      if (supa) return doSignOut();
      clearStoredLocal();
      return Promise.resolve();
    },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      subscribers.push(fn);
      // Return an unsubscribe handle so callers can clean up.
      return function off() {
        var i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    getVariantId: function () { return (currentIdentity && currentIdentity.variantId) || null; },
    getSupabase: function () { return supa; },
    deleteMyVariant: deleteMyVariant,
    // Open the magic-link modal. Used by patch preview "sign in to apply"
    // affordance for anonymous viewers (see comments.js renderPatchPreview).
    openModal: function (opts) { return openModal(opts || {}); },
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

  // -------- scenario detection --------------------------------
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
      var hasAuth = !!getConfig();

      if (!id) {
        panel.innerHTML =
          '<div class="id-set-head"><span>identity</span>' +
            '<button class="id-set-close" type="button" aria-label="close">×</button></div>' +
          '<div class="id-set-body">' +
            '<div class="id-set-anon">' + (hasAuth
              ? 'sign in to start a variant. one magic-link email, no password.'
              : 'you\'re anonymous. drop a comment or join the loop to claim a handle.') +
            '</div>' +
            '<button class="id-set-action id-set-join" type="button">' +
              (hasAuth ? 'sign in →' : 'join the loop ↗') + '</button>' +
          '</div>';
      } else {
        var label = id.email ? 'signed in as' : 'your handle';
        var variantLine = id.variantId
          ? '<div class="id-set-variant">variant · <code>' + escapeHtml(String(id.variantId).slice(0, 8)) + '</code></div>'
          : '';
        // Surface trigger-fallback as a degraded-mode pill. Session-sticky.
        var degradedPill = triggerFallbackFired
          ? '<div class="id-set-degraded" style="display:inline-block;margin:6px 0;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;" title="DB trigger did not fire — variant created via client fallback. Check the on_auth_user_created trigger.">⚠ degraded mode</div>'
          : '';
        panel.innerHTML =
          '<div class="id-set-head"><span>identity</span>' +
            '<button class="id-set-close" type="button" aria-label="close">×</button></div>' +
          '<div class="id-set-body">' +
            '<div class="id-set-you">' +
              '<span class="id-set-avatar" style="background:' + id.color + '">' + escapeHtml(id.avatar) + '</span>' +
              '<span class="id-set-handle"><span class="id-set-label">' + label + '</span>' + escapeHtml(id.email || id.handle) + '</span>' +
            '</div>' +
            variantLine +
            degradedPill +
            '<div class="id-set-stats">your comments · <b>' + totalCount + '</b> total · <b>' + thisCount + '</b> in this scenario</div>' +
            (id.email
              ? '<button class="id-set-action id-set-signout" type="button">sign out</button>'
              : '<button class="id-set-action id-set-change" type="button">change handle</button>') +
            patchesSectionHtml(id) +
            '<button class="id-set-action id-set-see" type="button">see all your comments →</button>' +
            '<button class="id-set-action id-set-danger id-set-forget" type="button">' +
              (id.email ? 'delete my variant + all comments' : 'forget me') +
            '</button>' +
          '</div>';
      }
      bindPanel(id);
      refreshPatchesSummary();
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
      var signout = panel.querySelector('.id-set-signout');
      if (signout) signout.addEventListener('click', function () {
        shut();
        window.doclayerIdentity.signOut();
      });
      var forget = panel.querySelector('.id-set-forget');
      if (forget) forget.addEventListener('click', function () {
        if (id && id.email) {
          if (!window.confirm('delete your variant and all comments? this cannot be undone.')) return;
          deleteMyVariant().then(function () { shut(); });
        } else {
          if (!window.confirm('forget your handle and delete all your comments?')) return;
          clearCurrentUserComments();
          clearStoredLocal();
          shut();
        }
      });
      var see = panel.querySelector('.id-set-see');
      if (see) see.addEventListener('click', function () {
        shut();
        openImprovementsModal();
      });
      var patches = panel.querySelector('.id-set-patches-link');
      if (patches) patches.addEventListener('click', function () {
        shut();
        openPatchesModal();
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

  // -------- patches summary (Phase 4) -------------------------
  // Quick patch-count summary for the gear panel. Reads from
  // doclayerPatchRenderer's in-memory cache for the current scenario
  // and supplements with a Supabase count for the rest. Best-effort.
  function patchesSectionHtml(id) {
    if (!id || !id.variantId || !supa) return '';
    // Render placeholder; the panel re-renders on identity changes which
    // happen rarely — for live counts we update after a fetch.
    return '<div class="id-set-patches" data-patches-summary>' +
      '<span class="id-set-patches-label">your patches</span> · ' +
      '<b data-patches-applied>·</b> applied · ' +
      '<b data-patches-superseded>·</b> superseded · ' +
      '<button class="id-set-patches-link" type="button">see all →</button>' +
      '</div>';
  }
  function refreshPatchesSummary() {
    var el = document.querySelector('[data-patches-summary]');
    if (!el || !supa || !currentIdentity || !currentIdentity.variantId) return;
    // The old code issued two count-only Supabase queries. We now fetch a
    // page of patches from /api/me/patches and tally locally. For variants
    // with >50 patches this under-counts; the modal still shows the full
    // paginated list when opened. Acceptable trade-off for V1 to avoid a
    // dedicated /count endpoint.
    getJwt().then(function (jwt) {
      if (!jwt) return null;
      return fetch('/api/me/patches?limit=50', {
        headers: { 'Authorization': 'Bearer ' + jwt },
      }).then(function (res) { return res.ok ? res.json() : null; });
    }).then(function (data) {
      if (!data || !Array.isArray(data.patches)) return;
      var applied = 0;
      var superseded = 0;
      data.patches.forEach(function (p) {
        if (p.status === 'applied') applied++;
        else if (p.status === 'superseded') superseded++;
      });
      var a = el.querySelector('[data-patches-applied]');
      var s = el.querySelector('[data-patches-superseded]');
      if (a) a.textContent = String(applied);
      if (s) s.textContent = String(superseded);
    }).catch(function () { /* swallow */ });
  }

  // Format an ISO timestamp as a relative ("2h ago") or absolute date if older.
  function formatRelativeTime(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var diff = Date.now() - t;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + 'd ago';
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---- Patches modal (Phase 4) ----
  // Paginated list of patches across all scenarios, grouped by scenario.
  // Each row: intent, applied_at (relative), status badge, superseded_by ref.
  // Pagination via applied_at < lastSeenAppliedAt cursor (stable under inserts).
  var PATCHES_PAGE_SIZE = 50;
  function openPatchesModal() {
    var existing = document.querySelector('.id-patches-modal');
    if (existing) existing.parentNode.removeChild(existing);
    var wrap = document.createElement('div');
    wrap.className = 'id-modal id-patches-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML =
      '<div class="id-modal-scrim"></div>' +
      '<div class="id-patches-card" role="document">' +
        '<div class="id-patches-head">' +
          '<span>your patches across the loop</span>' +
          '<button class="id-patches-close" type="button" aria-label="close">×</button>' +
        '</div>' +
        '<div class="id-patches-body">' +
          '<div class="id-patches-empty">loading…</div>' +
        '</div>' +
        '<div class="id-patches-foot" style="display:none">' +
          '<button class="pm-load-more-btn" type="button">load more</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.body.classList.add('id-modal-open');

    function shut() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      document.body.classList.remove('id-modal-open');
    }
    wrap.querySelector('.id-modal-scrim').addEventListener('click', shut);
    wrap.querySelector('.id-patches-close').addEventListener('click', shut);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { shut(); document.removeEventListener('keydown', esc); }
    });

    if (!supa || !currentIdentity || !currentIdentity.variantId) {
      wrap.querySelector('.id-patches-body').innerHTML =
        '<div class="id-patches-empty">sign in to track patches across scenarios.</div>';
      return;
    }

    // State: accumulated rows by id (so we can resolve superseded_by → row).
    // We hit GET /api/me/patches?cursor=<ts> which returns BOTH patches and
    // accepted revision-variants in one roundtrip plus a unified next_cursor.
    // Server-side filter is by the auth'd user's variant_id; no client-side
    // variant filtering needed.
    var allRows = [];
    var rowById = {};
    var nextCursor = null;       // server-issued cursor for the next page
    var exhausted = false;
    var loading = false;

    function fetchPage() {
      if (loading || exhausted) return Promise.resolve();
      loading = true;

      return getJwt().then(function (jwt) {
        if (!jwt) {
          loading = false;
          wrap.querySelector('.id-patches-body').innerHTML =
            '<div class="id-patches-empty">sign in to track patches across scenarios.</div>';
          return;
        }
        var url = '/api/me/patches?limit=' + PATCHES_PAGE_SIZE +
                  (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '');
        return fetch(url, {
          headers: { 'Authorization': 'Bearer ' + jwt },
        }).then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (j) {
              throw new Error((j && j.error) || ('http_' + res.status));
            });
          }
          return res.json();
        }).then(function (data) {
          loading = false;
          var patches = Array.isArray(data && data.patches) ? data.patches : [];
          var revisions = Array.isArray(data && data.revisions) ? data.revisions : [];

          patches.forEach(function (r) {
            if (rowById[r.id]) return;
            rowById[r.id] = r;
            allRows.push(r);
          });
          // Fold revisions into allRows with the discriminator the renderer
          // expects (preserve the prior shape exactly so renderList is unchanged).
          revisions.forEach(function (r) {
            var key = 'rv:' + r.id;
            if (rowById[key]) return;
            var row = {
              id: key,
              scenario_id: r.scenario_id,
              spec: { intent: r.text || 'rewrite proposed' },
              status: r.revision_status === 'accepted' ? 'rev-accepted' : 'rev-proposed',
              applied_at: r.created_at,
              superseded_by_id: null,
              __kind: 'revision_variant',
              __target_block_id: r.target_block_id,
              __proposed_text: r.proposed_text,
            };
            rowById[key] = row;
            allRows.push(row);
          });

          // Sort newest-first across the merged timeline.
          allRows.sort(function (a, b) {
            var at = a.applied_at || '';
            var bt = b.applied_at || '';
            return at < bt ? 1 : at > bt ? -1 : 0;
          });

          nextCursor = (data && data.next_cursor) || null;
          if (!nextCursor) exhausted = true;
          renderList();
        }).catch(function () {
          loading = false;
          wrap.querySelector('.id-patches-body').innerHTML =
            '<div class="id-patches-empty">couldn\'t load.</div>';
        });
      });
    }


    function statusBadgeClass(status) {
      if (status === 'applied') return 'pm-badge pm-badge-applied';
      if (status === 'superseded') return 'pm-badge pm-badge-superseded';
      if (status === 'undone') return 'pm-badge pm-badge-undone';
      if (status === 'rev-accepted') return 'pm-badge pm-badge-rev pm-badge-rev-accepted';
      if (status === 'rev-proposed') return 'pm-badge pm-badge-rev pm-badge-rev-proposed';
      return 'pm-badge';
    }
    // Phase 6: distinguish revision-variants visually — quote-mark icon vs
    // the patch's default. Keeps them legible in a mixed list.
    function rowIcon(row) {
      return row && row.__kind === 'revision_variant' ? '<span class="pm-icon pm-icon-rv">“”</span>' : '';
    }

    function renderList() {
      var body = wrap.querySelector('.id-patches-body');
      var foot = wrap.querySelector('.id-patches-foot');
      if (!allRows.length) {
        body.innerHTML = '<div class="id-patches-empty">no patches yet — comment somewhere and let the architect propose one.</div>';
        foot.style.display = 'none';
        return;
      }
      // Group by scenario, preserving newest-first order within each group.
      var groups = [];
      var groupIdx = {};
      allRows.forEach(function (r) {
        var sc = r.scenario_id || 'unknown';
        if (groupIdx[sc] === undefined) {
          groupIdx[sc] = groups.length;
          groups.push({ scenario: sc, rows: [] });
        }
        groups[groupIdx[sc]].rows.push(r);
      });

      var html = '';
      groups.forEach(function (g) {
        html += '<section class="pm-group">' +
          '<a class="pm-scenario-header" href="' + escapeHtml(g.scenario) + '.html">' +
            escapeHtml(g.scenario) + ' · ' + g.rows.length +
          '</a>' +
          '<ul class="pm-list">';
        g.rows.forEach(function (r) {
          var intent = (r.spec && r.spec.intent) || '(no intent)';
          var when = formatRelativeTime(r.applied_at);
          var sup = '';
          if (r.superseded_by_id) {
            sup = '<a class="pm-superseded-by" href="#pm-row-' + escapeHtml(String(r.superseded_by_id)) + '"' +
              ' data-target-id="' + escapeHtml(String(r.superseded_by_id)) + '">' +
              'superseded by patch ' + escapeHtml(String(r.superseded_by_id).slice(0, 8)) +
              '</a>';
          }
          html += '<li class="pm-patch-row pm-' + escapeHtml(r.status || 'unknown') + '" id="pm-row-' + escapeHtml(String(r.id)) + '">' +
            rowIcon(r) +
            '<span class="pm-intent">' + escapeHtml(intent) + '</span>' +
            '<span class="pm-when" title="' + escapeHtml(r.applied_at || '') + '">' + escapeHtml(when) + '</span>' +
            '<span class="' + statusBadgeClass(r.status) + '">' + escapeHtml(r.status || '') + '</span>' +
            (sup ? '<span class="pm-superseded-ref">' + sup + '</span>' : '') +
            '</li>';
        });
        html += '</ul></section>';
      });
      body.innerHTML = html;
      // Wire up superseded-by links to scroll to the target row within the modal.
      body.querySelectorAll('.pm-superseded-by').forEach(function (a) {
        a.addEventListener('click', function (e) {
          var id = a.getAttribute('data-target-id');
          var target = body.querySelector('#pm-row-' + cssEscapeId(id));
          if (target) {
            e.preventDefault();
            target.classList.add('pm-flash');
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(function () { target.classList.remove('pm-flash'); }, 1400);
          }
        });
      });
      foot.style.display = exhausted ? 'none' : 'flex';
    }

    function cssEscapeId(s) {
      if (window.CSS && CSS.escape) return CSS.escape(s);
      return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    wrap.querySelector('.pm-load-more-btn').addEventListener('click', function () { fetchPage(); });

    fetchPage();
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
    initSupabase().then(function (client) {
      if (client) {
        // Pick up session (including from magic-link redirect).
        client.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (session) {
            return hydrateFromSession(session).then(function (id) {
              setIdentity(id);
              try { document.dispatchEvent(new CustomEvent('doclayer:identity-ready', { detail: id })); } catch (e) {}
            });
          }
        });
      }
      // Pre-populate the render queue for comments.js (local fallback only).
      var id = supa ? null : getStoredLocal();
      var scenario = detectScenario();
      window.doclayerCommentsToRender = id ? commentsFor(id.handle, scenario) : [];
      buildGear();
    });
  });
})();
