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

      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

      function handle(out) {
        if (out.status >= 200 && out.status < 300 && out.body && out.body.response) {
          complete(out.body.response, false, out.body.routedTo);
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

      function complete(responseText, isCanned, routedTo) {
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
      + '<div class="dlc-foot dlc-foot-thread"><button class="dlc-resolve" type="button">resolve</button></div>';

    var archEl = body.querySelector('.dlc-msg-arch .dlc-msg-text');
    typeInto(archEl, responseText, function () {
      comment.response = responseText;
      bubbles.push({ comment: comment, bubble: bubble });
      pendingAnchor = null;
      try {
        window.dispatchEvent(new CustomEvent('doclayer:comment-saved', { detail: comment }));
      } catch (e) {}
    });

    wireThread(bubble, comment);
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
