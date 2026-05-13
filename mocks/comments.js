/* =============================================================
   doclayer pause + anchored comments — primary feedback path.

   Spacebar pauses all animation. While paused, click anywhere on
   the canvas to anchor a fresh comment bubble. Submit POSTs to
   /api/draft-feedback and types the architect's reply into the
   thread. Comments persist via window.doclayerComments + emitted
   events (the identity layer in Phase 2 owns storage).

   Coexists with the global feedback widget (feedback.js). The
   crosshair cursor disables while the global widget is open.
   ============================================================= */
(function () {
  if (window.__doclayerComments) return;
  window.__doclayerComments = true;

  // ---- Scenario context (read from .fb-panel like feedback.js does) ----
  var fbRoot = document.querySelector('.fb-panel');
  var SCENARIO = (fbRoot && fbRoot.dataset.scenario) || 'unknown';
  var PHASE = (fbRoot && fbRoot.dataset.phase) || '';
  var API_URL = '/api/draft-feedback';
  var CANNED_URL = 'feedback-canned.json';
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Identity (provided by the identity layer; fall back to a default) ----
  function getViewer() {
    if (window.doclayerViewer && typeof window.doclayerViewer === 'object') {
      return window.doclayerViewer;
    }
    return { handle: 'viewer', color: 'var(--third)' };
  }

  // Fetch the current Supabase JWT (null when anonymous). The identity layer
  // owns the supabase client; we just borrow getSession() here so every API
  // call can attach `Authorization: Bearer <jwt>`.
  function getJwt() {
    var supa = (window.doclayerIdentity && window.doclayerIdentity.getSupabase)
      ? window.doclayerIdentity.getSupabase() : null;
    if (!supa) return Promise.resolve(null);
    return supa.auth.getSession().then(function (r) {
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    }).catch(function () { return null; });
  }

  // ---- State ----
  var paused = false;
  var pendingAnchor = null;       // { dot, bubble } before first submit
  var bubbles = [];               // active rendered comment bubbles
  var cannedCache = null;
  var stripeAnimating = false;

  // ---- DOM scaffolding ----
  var layer = document.createElement('div');
  layer.className = 'dlc-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);

  var toast = document.createElement('div');
  toast.className = 'dlc-toast';
  toast.innerHTML = '<span class="dlc-toast-bars">&#9612;&#9612;</span>'
    + ' <span class="dlc-toast-text">paused &middot; click to comment &middot; space to resume</span>';
  document.body.appendChild(toast);

  // ---- Pause / resume ----
  function setPaused(next) {
    if (next === paused) return;
    paused = next;
    window.__doclayerPaused = paused;
    document.body.classList.toggle('doclayer-paused', paused);
    toast.classList.toggle('on', paused);
    try {
      window.dispatchEvent(new CustomEvent(paused ? 'doclayer:pause' : 'doclayer:resume'));
    } catch (e) {}
    if (!paused) cancelPending();
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (pendingAnchor) { cancelPending(); e.preventDefault(); return; }
      if (paused) { setPaused(false); e.preventDefault(); return; }
    }
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (isTypingTarget(e.target)) return;
    // Skip while the global feedback panel is open.
    if (document.body.classList.contains('fb-open')) return;
    e.preventDefault();
    setPaused(!paused);
  });

  // ---- cssPath helper: tag + nth-child chain up to 3 levels, prefers id ----
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + cssEscape(el.id);
    var parts = [];
    var cur = el;
    for (var depth = 0; depth < 3 && cur && cur.nodeType === 1 && cur !== document.body; depth++) {
      var seg = cur.tagName.toLowerCase();
      // Prefer a unique class if available
      var cls = pickStableClass(cur);
      if (cls) {
        seg += '.' + cls;
      } else if (cur.parentNode) {
        var siblings = cur.parentNode.children;
        if (siblings.length > 1) {
          var idx = Array.prototype.indexOf.call(siblings, cur) + 1;
          seg += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(seg);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function pickStableClass(el) {
    if (!el.classList || !el.classList.length) return null;
    for (var i = 0; i < el.classList.length; i++) {
      var c = el.classList[i];
      if (/^(doclayer-paused|dlc-|fb-|tw-|active|done|on|open|hover|focus)/i.test(c)) continue;
      // unique-ish?
      try {
        if (document.querySelectorAll('.' + cssEscape(c)).length <= 4) return c;
      } catch (e) {}
    }
    return null;
  }

  // ---- Click to anchor ----
  document.addEventListener('mousedown', function (e) {
    if (!paused) return;
    if (e.button !== 0) {
      if (e.button === 2 && pendingAnchor) {
        e.preventDefault();
        cancelPending();
      }
      return;
    }
    // Skip clicks on our own UI or on the global widget
    if (isOwnUI(e.target)) return;
    if (document.body.classList.contains('fb-open')) return;
    e.preventDefault();
    e.stopPropagation();
    spawnFreshBubble(e.clientX, e.clientY);
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (paused && pendingAnchor) {
      e.preventDefault();
      cancelPending();
    }
  });

  function isOwnUI(el) {
    while (el && el.nodeType === 1) {
      if (el.classList && (
        el.classList.contains('dlc-toast') ||
        el.classList.contains('dlc-bubble') ||
        el.classList.contains('dlc-dot') ||
        el.classList.contains('fb-panel') ||
        el.classList.contains('fb-scrim') ||
        el.classList.contains('fb-trigger')
      )) return true;
      el = el.parentNode;
    }
    return false;
  }

  function cancelPending() {
    if (!pendingAnchor) return;
    if (pendingAnchor.dot && pendingAnchor.dot.parentNode) {
      pendingAnchor.dot.parentNode.removeChild(pendingAnchor.dot);
    }
    if (pendingAnchor.bubble && pendingAnchor.bubble.parentNode) {
      pendingAnchor.bubble.parentNode.removeChild(pendingAnchor.bubble);
    }
    pendingAnchor = null;
  }

  // ---- Bubble rendering ----
  function spawnFreshBubble(x, y) {
    cancelPending();
    var el = document.elementFromPoint(x, y);
    var selector = el ? cssPath(el) : '';
    var xPct = (x / window.innerWidth) * 100;
    var yPct = (y / window.innerHeight) * 100;
    var anchor = { x: x, y: y, xPct: xPct, yPct: yPct, selector: selector };
    var viewer = getViewer();

    var dot = makeDot(x, y, viewer.color);
    var bubble = makeBubble(x, y, viewer, anchor, null);
    layer.appendChild(dot);
    layer.appendChild(bubble);
    positionBubble(bubble, x, y);

    pendingAnchor = { dot: dot, bubble: bubble, anchor: anchor };

    var ta = bubble.querySelector('.dlc-ta');
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 80);
  }

  function makeDot(x, y, color) {
    var dot = document.createElement('span');
    dot.className = 'dlc-dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    if (color) dot.style.setProperty('--dlc-color', color);
    return dot;
  }

  function makeBubble(x, y, viewer, anchor, existing) {
    var bubble = document.createElement('div');
    bubble.className = 'dlc-bubble' + (existing ? ' is-thread' : ' is-fresh');
    bubble.setAttribute('role', 'dialog');
    bubble.style.setProperty('--dlc-color', viewer.color || 'var(--third)');

    var header = '<div class="dlc-head">'
      + '<span class="dlc-avatar" style="background:' + escapeAttr(viewer.color || 'var(--third)') + '"></span>'
      + '<span class="dlc-handle">' + escapeHtml(viewer.handle || 'viewer') + '</span>'
      + '<button class="dlc-close" type="button" aria-label="cancel">&times;</button>'
      + '</div>';

    if (existing) {
      // Render thread directly
      bubble.innerHTML = header + threadBodyHtml(existing);
      wireThread(bubble, existing);
    } else {
      bubble.innerHTML = header
        + '<div class="dlc-body">'
        +   '<textarea class="dlc-ta" maxlength="300" rows="3" placeholder="leave a comment on this part of the doc&hellip;"></textarea>'
        +   '<div class="dlc-foot">'
        +     '<span class="dlc-count">0 / 300</span>'
        +     '<button class="dlc-submit" type="button" disabled>send to architect &#8599;</button>'
        +   '</div>'
        +   '<div class="dlc-drafting"><span class="dlc-pulse"></span><span class="dlc-draft-label">architect drafting&hellip;</span></div>'
        +   '<div class="dlc-error"></div>'
        + '</div>';
      wireFresh(bubble, anchor, viewer);
    }
    return bubble;
  }

  function threadBodyHtml(comment) {
    var v = comment.author || { handle: 'viewer', color: 'var(--third)' };
    return '<div class="dlc-body">'
      + '<div class="dlc-msg dlc-msg-you">'
      +   '<span class="dlc-msg-tag">' + escapeHtml(v.handle) + '</span>'
      +   '<span class="dlc-msg-text">' + escapeHtml(comment.text || '') + '</span>'
      + '</div>'
      + (comment.response
          ? '<div class="dlc-msg dlc-msg-arch">'
            + '<span class="dlc-msg-tag">architect</span>'
            + '<span class="dlc-msg-text">' + escapeHtml(comment.response) + '</span>'
            + '</div>'
          : '')
      + '<div class="dlc-foot dlc-foot-thread">'
      +   '<button class="dlc-resolve" type="button">resolve</button>'
      + '</div>'
      + '</div>';
  }

  function wireFresh(bubble, anchor, viewer) {
    var ta = bubble.querySelector('.dlc-ta');
    var count = bubble.querySelector('.dlc-count');
    var submit = bubble.querySelector('.dlc-submit');
    var drafting = bubble.querySelector('.dlc-drafting');
    var err = bubble.querySelector('.dlc-error');
    var close = bubble.querySelector('.dlc-close');

    function refresh() {
      var n = ta.value.length;
      count.textContent = n + ' / 300';
      count.classList.toggle('warn', n > 270);
      submit.disabled = ta.value.trim().length < 3;
    }
    ta.addEventListener('input', refresh);
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !submit.disabled) {
        e.preventDefault();
        doSubmit();
      }
    });
    close.addEventListener('click', cancelPending);

    function doSubmit() {
      var text = ta.value.trim();
      if (text.length < 3) return;
      submit.disabled = true;
      ta.disabled = true;
      drafting.classList.add('on');
      err.classList.remove('on');

      var payload = {
        scenario: SCENARIO,
        phase: PHASE,
        feedback: text,
        anchor: anchor,
        viewer: viewer,
      };
      var started = Date.now();

      // Persistence-first: POST /api/comments/post (authed) to get a
      // comment_id, then call /api/draft-feedback with that id so the
      // architect response is attached to the persisted row. If the user
      // is anonymous (no JWT) or the persist call fails non-fatally, we
      // still attempt the architect call without a comment_id so they
      // get a response (just not server-persisted).
      getJwt().then(function (jwt) {
        var headers = { 'Content-Type': 'application/json' };
        if (jwt) headers['Authorization'] = 'Bearer ' + jwt;

        function callArchitect(commentId) {
          var body = {
            scenario: payload.scenario,
            phase: payload.phase,
            feedback: payload.feedback,
            anchor: payload.anchor,
            viewer: payload.viewer,
          };
          if (commentId) body.comment_id = commentId;
          return fetch(API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
          }).then(function (res) {
            return res.json().then(function (j) { return { status: res.status, body: j }; },
                                  function () { return { status: res.status, body: {} }; });
          }).then(function (out) {
            var minDelay = Math.max(0, 900 - (Date.now() - started));
            setTimeout(function () { handle(out); }, minDelay);
          }).catch(function () {
            cannedFallback(text).then(function (resp) { complete(resp, true, null); })
              .catch(function () { failure("couldn't reach architect — try again"); });
          });
        }

        if (!jwt) {
          // Anonymous: surface a quiet hint but proceed without persistence.
          return callArchitect(null);
        }
        return fetch('/api/comments/post', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            scenario: payload.scenario,
            phase: payload.phase || undefined,
            feedback: payload.feedback,
            anchor: payload.anchor || undefined,
          }),
        }).then(function (res) {
          return res.json().then(function (j) { return { status: res.status, body: j }; },
                                function () { return { status: res.status, body: {} }; });
        }).then(function (p) {
          var commentId = (p && p.body && p.body.comment_id) || null;
          // 429 short-circuits architect — caller is rate-limited.
          if (p.status === 429) {
            failure("you've left a lot of feedback recently — try again in a minute");
            return;
          }
          // 401/422/5xx: still call architect, just without persistence.
          return callArchitect(commentId);
        }).catch(function () {
          // Persist call threw — fall back to architect-only.
          return callArchitect(null);
        });
      });

      function handle(out) {
        if (out.status >= 200 && out.status < 300 && out.body && out.body.response) {
          complete(
            out.body.response,
            false,
            out.body.routedTo,
            out.body.patch || null,
            out.body.revision_variant || null
          );
          return;
        }
        if (out.status === 503 && out.body && out.body.fallback === 'canned') {
          cannedFallback(text).then(function (resp) { complete(resp, true, null); })
            .catch(function () { failure("couldn't load fallback"); });
          return;
        }
        if (out.status === 429) { failure("typing fast — try again in a minute"); return; }
        var msg = (out.body && out.body.error) ? out.body.error : "couldn't draft — try again";
        failure(msg);
      }

      function failure(msg) {
        drafting.classList.remove('on');
        err.textContent = msg;
        err.classList.add('on');
        ta.disabled = false;
        submit.disabled = false;
      }

      function complete(responseText, isCanned, routedTo, patch, revisionVariant) {
        drafting.classList.remove('on');
        var comment = {
          id: makeId(),
          scenario: SCENARIO,
          phase: PHASE,
          anchor: anchor,
          text: text,
          response: '',
          author: viewer,
          routedTo: routedTo || null,
          canned: !!isCanned,
          createdAt: Date.now(),
          resolved: false,
          patch: patch || null,
          revisionVariant: revisionVariant || null,
        };
        // Swap to thread view, but type the architect response in.
        switchToThread(bubble, comment, responseText);
      }
    }
    submit.addEventListener('click', doSubmit);
    refresh();
  }

  function switchToThread(bubble, comment, responseText) {
    bubble.classList.remove('is-fresh');
    bubble.classList.add('is-thread');
    var body = bubble.querySelector('.dlc-body');
    body.innerHTML = '<div class="dlc-msg dlc-msg-you">'
      +   '<span class="dlc-msg-tag">' + escapeHtml(comment.author.handle) + '</span>'
      +   '<span class="dlc-msg-text">' + escapeHtml(comment.text) + '</span>'
      + '</div>'
      + '<div class="dlc-msg dlc-msg-arch">'
      +   '<span class="dlc-msg-tag">architect</span>'
      +   '<span class="dlc-msg-text"></span>'
      + '</div>'
      + '<div class="dlc-patch-slot"></div>'
      + '<div class="dlc-foot dlc-foot-thread"><button class="dlc-resolve" type="button">resolve</button></div>';

    var archEl = body.querySelector('.dlc-msg-arch .dlc-msg-text');
    typeInto(archEl, responseText, function () {
      comment.response = responseText;
      bubbles.push({ comment: comment, bubble: bubble });
      pendingAnchor = null;
      // Render the patch / revision-variant preview AFTER architect types —
      // feels causal. P1-4: if BOTH arrive, render both (patch first, then
      // revision-variant under an "also proposed:" label) — the viewer can
      // accept either or both independently rather than silently dropping
      // the revision. Console.warn so dev can see the dual emission.
      if (comment.patch && comment.revisionVariant) {
        console.warn('[doclayer-comments] architect emitted both patch and revision-variant — rendering both', {
          patch: comment.patch,
          revisionVariant: comment.revisionVariant,
        });
        renderPatchPreview(bubble, comment);
        // Insert an "also proposed:" separator + a fresh slot, then render
        // the revision-variant into the new slot.
        var primarySlot = bubble.querySelector('.dlc-patch-slot');
        if (primarySlot && primarySlot.parentNode) {
          var alsoLabel = document.createElement('div');
          alsoLabel.className = 'dlc-patch-also-label';
          alsoLabel.textContent = 'also proposed:';
          primarySlot.parentNode.insertBefore(alsoLabel, primarySlot.nextSibling);
          var rvSlot = document.createElement('div');
          rvSlot.className = 'dlc-patch-slot dlc-patch-slot-also';
          alsoLabel.parentNode.insertBefore(rvSlot, alsoLabel.nextSibling);
          renderRevisionVariantPreview(bubble, comment, rvSlot);
        }
      } else if (comment.patch) {
        renderPatchPreview(bubble, comment);
      } else if (comment.revisionVariant) {
        renderRevisionVariantPreview(bubble, comment);
      }
      try {
        window.dispatchEvent(new CustomEvent('doclayer:comment-saved', { detail: comment }));
      } catch (e) {}
    });

    wireThread(bubble, comment);
  }

  // ---- Patch preview UI ----
  // Renders an op diff card inside the response bubble with apply/discard
  // buttons, handles the POST to /api/variants/apply, and surfaces the
  // 60s undo countdown on success.
  function renderPatchPreview(bubble, comment, explicitSlot) {
    // P1-4: callers can pass an explicit slot when rendering a second preview
    // (e.g. dual emit patch+revision). Default to first empty .dlc-patch-slot.
    var slot = explicitSlot || bubble.querySelector('.dlc-patch-slot:not(.dlc-patch-slot-claimed)');
    // P6: on re-render (e.g. after sign-in completes), no unclaimed slot exists
    // because we claimed it during the first render. Reuse the previously
    // claimed patch slot in this bubble — keyed by data-slot-kind so we don't
    // grab a revision slot in a dual-emit bubble.
    if (!slot && !explicitSlot) {
      slot = bubble.querySelector('.dlc-patch-slot.dlc-patch-slot-claimed[data-slot-kind="patch"]');
      if (slot) slot.innerHTML = '';
    }
    if (!slot || !comment.patch) return;
    slot.classList.add('dlc-patch-slot-claimed');
    slot.dataset.slotKind = 'patch';
    var patch = comment.patch;

    // ---- Identity gate: anonymous viewers can read the preview but get a
    // "sign in to apply" button instead of an enabled apply (which would 401).
    var identity = (window.doclayerIdentity && window.doclayerIdentity.get && window.doclayerIdentity.get()) || null;
    var isSignedInToVariant = !!(identity && identity.variantId);

    // ---- Render: macro envelope (if any) + ops diff + effective_ops ----
    var headerExtras = '';
    if (patch.macro && typeof patch.macro === 'object') {
      headerExtras +=
        '<div class="patch-macro-row">' +
          '<span class="patch-badge patch-badge-structural">structural change</span>' +
          '<span class="patch-macro-kind">' + escapeHtml(patch.macro.kind || 'macro') + '</span>' +
          (patch.macro.params
            ? '<span class="patch-macro-params">' + escapeHtml(formatValue(patch.macro.params)) + '</span>'
            : '') +
        '</div>';
    }

    var literalOpsHtml = (patch.ops || [])
      .filter(function (o) { return o.op !== 'test'; })
      .map(function (o) { return renderOpRow(o, patch.ops || []); })
      .join('');

    // Macro-only patches have ops=[] (or test-only) and carry the writes in
    // effective_ops. Always render effective_ops if they exist and differ
    // from the literal ops — otherwise the viewer accepts blind.
    var effectiveOps = Array.isArray(patch.effective_ops) ? patch.effective_ops : [];
    var literalNonTest = (patch.ops || []).filter(function (o) { return o.op !== 'test'; });
    var effectiveNonTest = effectiveOps.filter(function (o) { return o.op !== 'test'; });
    // Show effective_ops whenever there's a macro envelope (regardless of
    // whether expansion count happens to match the literal-op count). The
    // "Macro expands to:" label disambiguates.
    var showEffective = effectiveNonTest.length > 0 && !!patch.macro;
    var effectiveOpsHtml = showEffective
      ? effectiveNonTest.map(function (o) { return renderOpRow(o, effectiveOps); }).join('')
      : '';

    var opsBlock = '';
    if (literalOpsHtml) {
      opsBlock += '<div class="patch-ops">' + literalOpsHtml + '</div>';
    }
    if (effectiveOpsHtml) {
      opsBlock +=
        '<div class="patch-ops-effective">' +
          '<div class="patch-ops-effective-label">macro expands to:</div>' +
          effectiveOpsHtml +
        '</div>';
    }
    if (!opsBlock) {
      opsBlock = '<div class="patch-ops"><div class="patch-op-empty">(no diff)</div></div>';
    }

    var footHtml = isSignedInToVariant
      ? '<button class="patch-apply-btn" type="button">apply to your variant</button>' +
        '<button class="patch-discard-link" type="button">discard</button>'
      : '<button class="patch-apply-btn patch-signin-btn" type="button">sign in to apply</button>' +
        '<button class="patch-discard-link" type="button">discard</button>';

    slot.innerHTML =
      '<div class="patch-preview">' +
        '<div class="patch-preview-head">' +
          '<span class="patch-intent">' + escapeHtml(patch.intent || 'patch') + '</span>' +
        '</div>' +
        headerExtras +
        opsBlock +
        '<div class="patch-preview-foot">' + footHtml + '</div>' +
        '<div class="patch-applying-row" style="display:none">' +
          '<span class="dlc-pulse"></span>' +
          '<span class="patch-applying-label">architect applying&hellip;</span>' +
        '</div>' +
        '<div class="patch-error" style="display:none"></div>' +
      '</div>';

    var applyBtn   = slot.querySelector('.patch-apply-btn');
    var discardBtn = slot.querySelector('.patch-discard-link');
    var applying   = slot.querySelector('.patch-applying-row');
    var errEl      = slot.querySelector('.patch-error');

    if (!isSignedInToVariant) {
      applyBtn.addEventListener('click', function () {
        if (window.doclayerIdentity && typeof window.doclayerIdentity.openModal === 'function') {
          window.doclayerIdentity.openModal({});
        } else if (window.doclayerEnsureIdentity) {
          window.doclayerEnsureIdentity();
        }
        // After sign-in, identity-ready fires and we re-render the preview
        // so the user can apply without finding the patch card again.
        // AbortController ensures the listener is torn down if:
        //  - signin succeeds (re-render fires + abort)
        //  - user closes the modal without signing in (doclayer:modal-closed)
        //  - the bubble is removed from the DOM
        // Otherwise the listener leaks and a future signin re-renders a stale
        // preview attached to an orphaned bubble.
        var ac = new AbortController();
        document.addEventListener('doclayer:identity-ready', function () {
          try { renderPatchPreview(bubble, comment); } catch (e) { /* swallow */ }
          ac.abort();
        }, { signal: ac.signal, once: true });
        window.addEventListener('doclayer:modal-closed', function () {
          ac.abort();
        }, { signal: ac.signal, once: true });
        // Watch bubble removal via MutationObserver — addEventListener('remove')
        // is not a standard event, so we observe the parent for childList
        // mutations and abort when bubble leaves the tree.
        if (bubble && bubble.parentNode && typeof MutationObserver === 'function') {
          var mo = new MutationObserver(function () {
            if (!bubble.isConnected) { ac.abort(); mo.disconnect(); }
          });
          try { mo.observe(bubble.parentNode, { childList: true }); } catch (e) { /* swallow */ }
          ac.signal.addEventListener('abort', function () { mo.disconnect(); });
        }
      });
    } else {
      applyBtn.addEventListener('click', function () { submitPatch(); });
    }
    discardBtn.addEventListener('click', function () {
      if (slot.parentNode) slot.parentNode.removeChild(slot);
    });

    function setApplying(on) {
      applying.style.display = on ? 'flex' : 'none';
      applyBtn.disabled = on;
      discardBtn.disabled = on;
    }
    function setError(msg, action) {
      errEl.innerHTML = '<span class="patch-error-msg">' + escapeHtml(msg) + '</span>'
        + (action ? ' <button class="patch-error-action" type="button">' + escapeHtml(action.label) + '</button>' : '');
      errEl.style.display = 'block';
      if (action) {
        errEl.querySelector('.patch-error-action').addEventListener('click', action.fn);
      }
    }

    function submitPatch() {
      errEl.style.display = 'none';
      setApplying(true);
      doApply(patch).then(function (out) {
        setApplying(false);
        if (out.status >= 200 && out.status < 300) {
          // Live-apply DOM and start the undo countdown.
          if (window.doclayerPatchRenderer) {
            window.doclayerPatchRenderer.applyPatchLive(patch, out.body.patch_id);
          }
          comment.appliedPatchId = out.body.patch_id;
          renderAppliedCountdown(slot, out.body.patch_id);
          return;
        }
        handleApplyError(out);
      }).catch(function (e) {
        setApplying(false);
        setError("couldn't reach server — retry", { label: 'retry', fn: submitPatch });
      });
    }

    function handleApplyError(out) {
      var body = out.body || {};
      var code = body.error || ('http ' + out.status);
      if (out.status === 409 && body.error === 'SCHEMA_STALE') {
        setError('this patch references an old schema', { label: 'regenerate', fn: function () {
          errEl.style.display = 'none';
          setApplying(true);
          regenerate(patch).then(function (fresh) {
            setApplying(false);
            if (fresh && fresh.patch) {
              comment.patch = fresh.patch;
              renderPatchPreview(bubble, comment);
            } else {
              setError("couldn't regenerate — try again", { label: 'retry', fn: submitPatch });
            }
          }).catch(function () {
            setApplying(false);
            setError("couldn't regenerate", { label: 'retry', fn: submitPatch });
          });
        }});
        return;
      }
      if (out.status === 412 || (out.status === 409 && body.error === 'VERSION_FORK_DETECTED')) {
        setError('your variant has changed · another patch landed first', { label: 'refresh + retry', fn: function () {
          // Surgical re-sync: re-fetch and replay applied patches against
          // :root, then re-render this preview against the fresh doc state.
          // Avoids location.reload() — preserves pause state, scroll position,
          // and any in-flight comments the viewer hasn't sent yet.
          errEl.style.display = 'none';
          setApplying(true);
          var doFetch = (window.doclayerPatchRenderer && typeof window.doclayerPatchRenderer.fetchAndReplay === 'function')
            ? window.doclayerPatchRenderer.fetchAndReplay()
            : Promise.resolve();
          doFetch.then(function () {
            setApplying(false);
            renderPatchPreview(bubble, comment);
          }).catch(function () {
            setApplying(false);
            setError("couldn't refresh — try again", { label: 'retry', fn: submitPatch });
          });
        }});
        return;
      }
      if (out.status === 422) {
        // SMOKE_FAILED carries {scenario, assertion} — show both so the viewer
        // can see WHICH scenario's smoke check broke, not just the failed bit.
        if (body.error === 'SMOKE_FAILED') {
          var scenarioStr = body.scenario ? String(body.scenario) : 'scenario';
          var assertionStr = body.assertion ? String(body.assertion) : 'unknown';
          setError("couldn't apply: smoke check on " + scenarioStr + ' failed (' + assertionStr + ')',
            { label: 'retry', fn: submitPatch });
          return;
        }
        var reason = body.reason || body.assertion || body.guard || code;
        setError("couldn't apply: " + reason, { label: 'retry', fn: submitPatch });
        return;
      }
      if (out.status === 401 || out.status === 403) {
        setError("you're not signed in for this variant", null);
        return;
      }
      setError("couldn't apply (" + code + ")", { label: 'retry', fn: submitPatch });
    }
  }

  function renderAppliedCountdown(slot, patchId) {
    var duration = 60000;
    var started = Date.now();
    slot.querySelector('.patch-preview').classList.add('patch-applied');
    slot.querySelector('.patch-preview-foot').style.display = 'none';
    var bar = document.createElement('div');
    bar.className = 'patch-applied-countdown';
    bar.innerHTML =
      '<span class="pac-label">applied · undo within <span class="pac-secs">60</span>s</span>' +
      '<button class="patch-undo-btn" type="button">undo</button>' +
      '<div class="pac-bar"><div class="pac-fill"></div></div>';
    slot.appendChild(bar);
    var fill = bar.querySelector('.pac-fill');
    var secs = bar.querySelector('.pac-secs');
    var undoBtn = bar.querySelector('.patch-undo-btn');

    var rafId = null;
    function tick() {
      var elapsed = Date.now() - started;
      var pct = Math.max(0, 1 - elapsed / duration);
      fill.style.width = (pct * 100).toFixed(1) + '%';
      secs.textContent = Math.max(0, Math.ceil((duration - elapsed) / 1000));
      if (elapsed < duration) {
        rafId = requestAnimationFrame(tick);
      } else {
        bar.classList.add('expired');
        undoBtn.disabled = true;
        undoBtn.textContent = 'undo window closed';
      }
    }
    rafId = requestAnimationFrame(tick);

    undoBtn.addEventListener('click', function () {
      if (Date.now() - started > duration) return;
      undoBtn.disabled = true;
      undoBtn.textContent = 'undoing…';
      if (!window.doclayerPatchRenderer) {
        undoBtn.textContent = 'undo unavailable';
        return;
      }
      window.doclayerPatchRenderer.undoPatch(patchId).then(function () {
        if (rafId) cancelAnimationFrame(rafId);
        bar.innerHTML = '<span class="pac-undone">reverted</span>';
      }).catch(function (e) {
        var code = (e && e.code) || '';
        var msg = (e && e.message) || 'undo failed';
        if (code === 'UNDO_WINDOW_EXPIRED') {
          // Force the visual expired state: stop the countdown, gray out the
          // bar, disable the undo button. Matches what tick() does at t=60s.
          if (rafId) cancelAnimationFrame(rafId);
          bar.classList.add('expired');
          fill.style.width = '0%';
          secs.textContent = '0';
          undoBtn.disabled = true;
          undoBtn.textContent = 'undo window closed';
        } else {
          undoBtn.disabled = false;
          undoBtn.textContent = 'undo';
        }
        var p = document.createElement('div');
        p.className = 'patch-error';
        p.style.display = 'block';
        p.textContent = msg;
        bar.appendChild(p);
      });
    });
  }

  // ---- Revision-variant preview UI ----
  // Prose escape hatch (DSL spec section g): when the architect classifies a
  // comment as a prose-rewrite, it emits a revision-variant proposal instead
  // of a patch. Render a distinct bubble: shows the target prose block, the
  // current text excerpt, the suggested rewrite, and accept/dismiss buttons.
  // On accept, POST /api/variants/revision-accept, swap textContent live, and
  // persist to localStorage so the swap survives reload (mocks have no Yjs).
  function renderRevisionVariantPreview(bubble, comment, explicitSlot) {
    // P1-4: accept an explicit slot for dual-emit; otherwise grab the first
    // unclaimed .dlc-patch-slot. Marks the slot claimed so a subsequent
    // render finds the NEXT one.
    var slot = explicitSlot || bubble.querySelector('.dlc-patch-slot:not(.dlc-patch-slot-claimed)');
    // P6: on re-render (post sign-in), no unclaimed slot remains — reuse the
    // previously claimed revision slot in this bubble (keyed by data-slot-kind
    // so we don't accidentally clobber a sibling patch preview).
    if (!slot && !explicitSlot) {
      slot = bubble.querySelector('.dlc-patch-slot.dlc-patch-slot-claimed[data-slot-kind="revision"]');
      if (slot) slot.innerHTML = '';
    }
    if (!slot || !comment.revisionVariant) return;
    slot.classList.add('dlc-patch-slot-claimed');
    slot.dataset.slotKind = 'revision';
    var rv = comment.revisionVariant;
    var blockId = rv.target_block_id || '';
    var suggested = rv.suggested_text || '';
    var intent = rv.intent || 'rewrite proposed';
    var rationale = rv.rationale || '';

    var identity = (window.doclayerIdentity && window.doclayerIdentity.get && window.doclayerIdentity.get()) || null;
    var isSignedInToVariant = !!(identity && identity.variantId);

    // Resolve target element + current text for the diff preview. We accept
    // either a data-prose match or (fallback) a substring scan against the
    // article body. If we can't find the block, we still let the viewer
    // accept — they just lose the live DOM swap.
    var targetEl = blockId ? document.querySelector('[data-prose="' + cssEscape(blockId) + '"]') : null;
    var currentText = targetEl ? (targetEl.textContent || '').trim() : '';
    var currentExcerpt = currentText.length > 140 ? currentText.slice(0, 137) + '…' : currentText;

    var footHtml = isSignedInToVariant
      ? '<button class="rv-accept-btn" type="button">accept rewrite</button>' +
        '<button class="rv-dismiss-btn" type="button">dismiss</button>'
      : '<button class="rv-accept-btn rv-signin-btn" type="button">sign in to accept</button>' +
        '<button class="rv-dismiss-btn" type="button">dismiss</button>';

    slot.innerHTML =
      '<div class="patch-preview revision-variant-preview">' +
        '<div class="patch-preview-head">' +
          '<span class="patch-intent rv-pill">rewrite proposed</span>' +
          '<span class="rv-intent-text">' + escapeHtml(intent) + '</span>' +
        '</div>' +
        '<div class="rv-target">' +
          (blockId
            ? '<span class="rv-target-label">target · </span><code class="rv-target-id">' + escapeHtml(blockId) + '</code>'
            : '<span class="rv-target-label">(no target block — accept will only record the proposal)</span>') +
          (targetEl ? '' : (blockId ? ' <span class="rv-not-found">not on this page</span>' : '')) +
        '</div>' +
        (currentExcerpt
          ? '<div class="rv-current"><span class="rv-current-label">now:</span> ' + escapeHtml(currentExcerpt) + '</div>'
          : '') +
        '<div class="rv-suggested"><span class="rv-suggested-bar"></span><div class="rv-suggested-text">' + escapeHtml(suggested) + '</div></div>' +
        (rationale ? '<div class="rv-rationale">' + escapeHtml(rationale) + '</div>' : '') +
        '<div class="patch-preview-foot">' + footHtml + '</div>' +
        '<div class="patch-applying-row" style="display:none">' +
          '<span class="dlc-pulse"></span>' +
          '<span class="patch-applying-label">accepting&hellip;</span>' +
        '</div>' +
        '<div class="patch-error" style="display:none"></div>' +
      '</div>';

    var acceptBtn  = slot.querySelector('.rv-accept-btn');
    var dismissBtn = slot.querySelector('.rv-dismiss-btn');
    var applying   = slot.querySelector('.patch-applying-row');
    var errEl      = slot.querySelector('.patch-error');

    function setBusy(on) {
      applying.style.display = on ? 'flex' : 'none';
      acceptBtn.disabled = on;
      dismissBtn.disabled = on;
    }
    function setError(msg) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }

    if (!isSignedInToVariant) {
      acceptBtn.addEventListener('click', function () {
        if (window.doclayerIdentity && typeof window.doclayerIdentity.openModal === 'function') {
          window.doclayerIdentity.openModal({});
        } else if (window.doclayerEnsureIdentity) {
          window.doclayerEnsureIdentity();
        }
        var ac = new AbortController();
        document.addEventListener('doclayer:identity-ready', function () {
          try { renderRevisionVariantPreview(bubble, comment); } catch (e) {}
          ac.abort();
        }, { signal: ac.signal, once: true });
        window.addEventListener('doclayer:modal-closed', function () { ac.abort(); }, { signal: ac.signal, once: true });
      });
    } else {
      acceptBtn.addEventListener('click', function () { doAccept(); });
    }
    dismissBtn.addEventListener('click', function () {
      // Local-only dismiss. We don't round-trip a rejection — the proposal
      // hasn't been persisted yet (propose+accept happen together on click).
      if (slot.parentNode) slot.parentNode.removeChild(slot);
    });

    function doAccept() {
      errEl.style.display = 'none';
      setBusy(true);
      // Two-step: propose (persists the row), then accept (flips status).
      // We do this rather than auto-accepting on propose so the audit trail
      // shows both 'revision_proposed' and 'revision_accepted' events.
      proposeRevision(rv, comment).then(function (out) {
        if (!out || out.status < 200 || out.status >= 300 || !out.body || !out.body.comment_id) {
          throw new Error((out && out.body && out.body.error) || 'propose_failed');
        }
        return acceptRevision(out.body.comment_id);
      }).then(function (out) {
        setBusy(false);
        if (out.status >= 200 && out.status < 300 && out.body) {
          finalizeAcceptUi(out.body);
          return;
        }
        var msg = (out.body && out.body.error) || ('http ' + out.status);
        setError("couldn't accept: " + msg);
      }).catch(function (e) {
        setBusy(false);
        setError("couldn't accept — " + ((e && e.message) || 'network'));
      });
    }

    function finalizeAcceptUi(serverBody) {
      var acceptedText = (serverBody && typeof serverBody.accepted_text === 'string') ? serverBody.accepted_text : suggested;
      var serverBlock = (serverBody && typeof serverBody.target_block_id === 'string') ? serverBody.target_block_id : blockId;
      // Live DOM swap + localStorage persistence so reload replays it.
      var swap = applyRevisionToDom(serverBlock, acceptedText);
      var preview = slot.querySelector('.patch-preview');
      if (preview) preview.classList.add('rv-accepted');
      var foot = slot.querySelector('.patch-preview-foot');
      if (foot) foot.style.display = 'none';
      var done = document.createElement('div');
      done.className = 'rv-accepted-row';
      if (swap && swap.ok === false && swap.reason === 'structured_descendants') {
        done.classList.add('rv-accepted-blocked');
        done.innerHTML = '<span class="rv-accepted-label">accepted · rewrite blocked: target has structured descendants</span>';
      } else {
        done.innerHTML = '<span class="rv-accepted-label">accepted · prose updated</span>';
      }
      slot.querySelector('.patch-preview').appendChild(done);
      comment.acceptedRevisionId = serverBody && serverBody.comment_id;
      try {
        window.dispatchEvent(new CustomEvent('doclayer:revision-accepted', {
          detail: { commentId: comment.id, blockId: serverBlock, suggestedText: acceptedText },
        }));
      } catch (e) {}
    }
  }

  // FNV-1a 32-bit hex. Non-crypto, FNV-1a 32-bit, drift detection only.
  function fnv1a32Hex(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // Apply the rewrite to the DOM and persist locally so reload replays it.
  // Real Yjs integration is out of scope for v1 mocks — this is the
  // human-accept-in-live-editor simulation.
  //
  // P0-1 (defense-in-depth): refuse swap if target has structured descendants
  // ([data-prose] / [data-patchable]) — textContent assignment would destroy
  // those nodes and later patches/replays would no-op silently. We surface a
  // 'rewrite blocked' state on the bubble so the user sees why.
  //
  // P0-2: capture pre-swap textContent hash to enable drift detection on
  // later replays. localStorage value is the JSON envelope
  // `{ text, sourceHash, acceptedAt }` — backward compatible with legacy
  // plain-string entries (replayAcceptedRevisions handles either).
  //
  // Returns: { ok: bool, reason?: string }
  function applyRevisionToDom(blockId, text) {
    if (!blockId) return { ok: false, reason: 'no_block_id' };
    var el = document.querySelector('[data-prose="' + cssEscape(blockId) + '"]');
    if (el && el.querySelector('[data-prose], [data-patchable]')) {
      console.warn('[doclayer-comments] revision apply blocked — target has structured descendants', { blockId: blockId });
      return { ok: false, reason: 'structured_descendants' };
    }
    var sourceHash = el ? fnv1a32Hex(el.textContent || '') : null;
    if (el) {
      // P6: clear any prior drift flag — this is a fresh accept on the live DOM.
      delete el.dataset.revisionStale;
      el.textContent = text;
    }
    var variantId = (window.doclayerIdentity && window.doclayerIdentity.getVariantId)
      ? window.doclayerIdentity.getVariantId() : null;
    if (variantId) {
      try {
        var envelope = JSON.stringify({
          text: text,
          sourceHash: sourceHash,
          acceptedAt: Date.now(),
        });
        localStorage.setItem('doclayer:revision:' + variantId + ':' + blockId, envelope);
      } catch (e) {}
    }
    return { ok: true };
  }

  function proposeRevision(rv, comment) {
    var variantId = (window.doclayerIdentity && window.doclayerIdentity.getVariantId)
      ? window.doclayerIdentity.getVariantId() : null;
    var payload = {
      variant_id: variantId,
      scenario_id: SCENARIO,
      viewer_comment_id: rv.viewer_comment_id || comment.id,
      target_block_id: rv.target_block_id || '',
      suggested_text: rv.suggested_text,
      rationale: rv.rationale || '',
      intent: rv.intent || '',
      anchor: comment.anchor,
    };
    // P1-5: forward schema_fp so the server can reject stale proposals (409).
    if (rv.schema_fp) payload.schema_fp = rv.schema_fp;
    return authedFetch('/api/variants/revision-propose', payload);
  }
  function acceptRevision(commentId) {
    return authedFetch('/api/variants/revision-accept', { comment_id: commentId, action: 'accept' });
  }
  function authedFetch(url, payload) {
    var supa = (window.doclayerIdentity && window.doclayerIdentity.getSupabase) ? window.doclayerIdentity.getSupabase() : null;
    var tokenP = supa ? supa.auth.getSession().then(function (r) {
      return r && r.data && r.data.session && r.data.session.access_token;
    }) : Promise.resolve(null);
    return tokenP.then(function (token) {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? ('Bearer ' + token) : '',
        },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json().then(function (j) { return { status: res.status, body: j }; },
                              function () { return { status: res.status, body: {} }; });
      });
    });
  }

  function doApply(patch) {
    var supa = (window.doclayerIdentity && window.doclayerIdentity.getSupabase) ? window.doclayerIdentity.getSupabase() : null;
    var variantId = (window.doclayerIdentity && window.doclayerIdentity.getVariantId) ? window.doclayerIdentity.getVariantId() : null;
    var bodyObj = {
      patch: patch,
      variant_id: variantId,
      scenario_id: SCENARIO,
    };
    var tokenP = supa ? supa.auth.getSession().then(function (r) {
      return r && r.data && r.data.session && r.data.session.access_token;
    }) : Promise.resolve(null);
    return tokenP.then(function (token) {
      return fetch('/api/variants/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? ('Bearer ' + token) : '',
        },
        body: JSON.stringify(bodyObj),
      }).then(function (res) {
        return res.json().then(function (j) { return { status: res.status, body: j }; },
                              function () { return { status: res.status, body: {} }; });
      });
    });
  }

  function regenerate(patch) {
    var supa = (window.doclayerIdentity && window.doclayerIdentity.getSupabase) ? window.doclayerIdentity.getSupabase() : null;
    var variantId = (window.doclayerIdentity && window.doclayerIdentity.getVariantId) ? window.doclayerIdentity.getVariantId() : null;
    var tokenP = supa ? supa.auth.getSession().then(function (r) {
      return r && r.data && r.data.session && r.data.session.access_token;
    }) : Promise.resolve(null);
    return tokenP.then(function (token) {
      return fetch('/api/variants/regenerate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? ('Bearer ' + token) : '',
        },
        body: JSON.stringify({
          prior_patch: patch,
          variant_id: variantId,
          scenario_id: SCENARIO,
        }),
      }).then(function (r) { return r.json().catch(function () { return {}; }); });
    });
  }

  function renderOpRow(o, ops) {
    // Block ops get special structured formatting — humans can't read raw
    // /variant/content/blocks/items/<id> add/remove ops, but they CAN read
    // "insert block <id> (paragraph) at position 3".
    var blockMatch = (o.path || '').match(/^\/variant\/content\/blocks\/items\/([a-z0-9-]+)(?:\/(.+))?$/i);
    if (blockMatch) {
      var blockId = blockMatch[1];
      var sub = blockMatch[2] || '';
      var kind = '';
      var label = '';
      if (!sub && o.op === 'add' && o.value && typeof o.value === 'object') {
        kind = o.value.kind || o.value.type || 'block';
        label = 'insert ' + kind + ' block ' + blockId.slice(0, 8);
      } else if (!sub && o.op === 'remove') {
        label = 'remove block ' + blockId.slice(0, 8);
      } else {
        label = (o.op || 'op') + ' ' + (sub ? (sub + ' of ') : '') + 'block ' + blockId.slice(0, 8);
      }
      return '<div class="patch-op patch-op-block">' +
        '<span class="patch-badge patch-badge-block">block</span>' +
        '<span class="ptv-key">' + escapeHtml(label) + '</span>' +
      '</div>';
    }

    var prior = findPriorTestValue(ops, o);
    var label2 = humanizePath(o.path || '');
    var fromTo = (o.op === 'remove')
      ? '<span class="ptv-from">' + escapeHtml(formatValue(prior)) + '</span> <span class="ptv-arr">→ removed</span>'
      : '<span class="ptv-from">' + escapeHtml(formatValue(prior)) + '</span> <span class="ptv-arr">→</span> <span class="ptv-to">' + escapeHtml(formatValue(o.value)) + '</span>';
    return '<div class="patch-op">'
      + '<span class="ptv-key">' + escapeHtml(label2) + '</span>'
      + fromTo
      + '</div>';
  }

  function findPriorTestValue(ops, mutOp) {
    var idx = ops.indexOf(mutOp);
    if (idx <= 0) return undefined;
    var prior = ops[idx - 1];
    if (prior && prior.op === 'test' && prior.path === mutOp.path) return prior.value;
    return undefined;
  }
  function humanizePath(p) {
    return (p || '').replace(/^\/variant\//, '').replace(/\//g, ' · ');
  }
  function formatValue(v) {
    if (v === undefined) return '∅';
    if (v === null) return 'null';
    if (typeof v === 'string') {
      return v.length > 60 ? '"' + v.slice(0, 57) + '…"' : '"' + v + '"';
    }
    if (typeof v === 'object') {
      try { var s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + '…' : s; }
      catch (e) { return '[object]'; }
    }
    return String(v);
  }

  function wireThread(bubble, comment) {
    var resolveBtn = bubble.querySelector('.dlc-resolve');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', function () {
        comment.resolved = true;
        // collapse to just the dot
        if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
        try {
          window.dispatchEvent(new CustomEvent('doclayer:comment-resolved', { detail: comment }));
        } catch (e) {}
      });
    }
    var close = bubble.querySelector('.dlc-close');
    if (close) {
      close.addEventListener('click', function () {
        // Hide thread bubble but keep dot
        bubble.classList.add('dlc-collapsed');
      });
    }
  }

  // ---- Positioning: anchor on screen, but keep bubble in viewport ----
  function positionBubble(bubble, x, y) {
    var W = 280, H = 160;
    var vw = window.innerWidth, vh = window.innerHeight;
    var bx, by;
    // Prefer to the right + below the anchor
    bx = (x + 20 + W < vw) ? (x + 20) : (x - 20 - W);
    by = (y + 16 + H < vh) ? (y + 16) : Math.max(8, vh - H - 8);
    bx = Math.max(8, Math.min(bx, vw - W - 8));
    bubble.style.left = bx + 'px';
    bubble.style.top = by + 'px';
  }

  // ---- Re-anchor on resize ----
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reanchorAll, 200);
  });
  function reanchorAll() {
    bubbles.forEach(function (entry) {
      var c = entry.comment;
      var pt = resolvePoint(c.anchor);
      if (!pt) return;
      var sib = entry.bubble.previousSibling;
      // Re-place dot: find the matching dot via stored reference
      if (entry.dot && entry.dot.parentNode) {
        entry.dot.style.left = pt.x + 'px';
        entry.dot.style.top = pt.y + 'px';
      }
      positionBubble(entry.bubble, pt.x, pt.y);
    });
  }
  function resolvePoint(anchor) {
    if (anchor.selector) {
      try {
        var node = document.querySelector(anchor.selector);
        if (node) {
          var r = node.getBoundingClientRect();
          if (r.width && r.height) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      } catch (e) {}
    }
    if (typeof anchor.xPct === 'number' && typeof anchor.yPct === 'number') {
      return { x: (anchor.xPct / 100) * window.innerWidth, y: (anchor.yPct / 100) * window.innerHeight };
    }
    return { x: anchor.x, y: anchor.y };
  }

  // ---- Persistence: render existing comments for this scenario on load ----
  function renderExisting() {
    var arr = window.doclayerComments;
    if (!Array.isArray(arr) || !arr.length) return;
    arr.forEach(function (c) {
      if (!c || c.scenario !== SCENARIO || c.resolved) return;
      var pt = resolvePoint(c.anchor || {});
      if (!pt) return;
      var dot = makeDot(pt.x, pt.y, (c.author && c.author.color) || 'var(--third)');
      var bubble = makeBubble(pt.x, pt.y, c.author || getViewer(), c.anchor, c);
      layer.appendChild(dot);
      layer.appendChild(bubble);
      positionBubble(bubble, pt.x, pt.y);
      bubble.classList.add('dlc-collapsed'); // start collapsed; click dot to open
      bubbles.push({ comment: c, bubble: bubble, dot: dot });
      dot.addEventListener('click', function () {
        bubble.classList.toggle('dlc-collapsed');
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderExisting);
  } else {
    setTimeout(renderExisting, 0);
  }
  // Allow the identity layer to push comments in after-the-fact
  window.addEventListener('doclayer:comments-loaded', renderExisting);

  // ---- Typing engine (mirrors feedback.js heuristics) ----
  function typeInto(el, fullText, onDone) {
    if (REDUCED) {
      el.textContent = fullText;
      if (onDone) onDone();
      return;
    }
    el.textContent = '';
    el.classList.add('dlc-typing');
    var i = 0;
    function delay(ch) {
      var d = 26 + Math.random() * 42;
      if (ch === '.' || ch === '?' || ch === '!') d += 180 + Math.random() * 220;
      else if (ch === ',' || ch === ';' || ch === ':') d += 110 + Math.random() * 160;
      else if (ch === '\n' || ch === '—') d += 220 + Math.random() * 280;
      else if (ch === ' ' && Math.random() < 0.12) d += 70 + Math.random() * 110;
      return d;
    }
    function step() {
      if (i >= fullText.length) {
        el.classList.remove('dlc-typing');
        if (onDone) onDone();
        return;
      }
      var ch = fullText.charAt(i++);
      el.textContent += ch;
      setTimeout(step, delay(ch));
    }
    step();
  }

  // ---- Canned fallback ----
  function cannedFallback(feedback) {
    var p = cannedCache ? Promise.resolve(cannedCache)
      : fetch(CANNED_URL).then(function (r) { return r.json(); }).then(function (j) { cannedCache = j; return j; });
    return p.then(function (canned) {
      var responses = (canned && canned.responses) || [];
      for (var i = 0; i < responses.length; i++) {
        var r = responses[i];
        try {
          var src = r.pattern.replace(/^\(\?i\)/, '');
          var re = new RegExp(src, 'i');
          if (re.test(feedback)) return r.response;
        } catch (e) {}
      }
      return (responses[responses.length - 1] && responses[responses.length - 1].response) || 'logged.';
    });
  }

  // ---- Utilities ----
  function makeId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
