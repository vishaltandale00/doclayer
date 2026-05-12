/* =============================================================
   doclayer feedback widget — shared across all scenarios.

   Scenario context is read from data-scenario / data-phase on the
   .fb-panel root. Each scenario gets its own localStorage thread
   keyed by scenario id (doclayer-feedback-<scenario>).

   Tries POST /api/draft-feedback first, falls back to the canned
   responses in feedback-canned.json (regex pattern match) when the
   API is unavailable (503) or absent.
   ============================================================= */
(function () {
  var root = document.querySelector('.fb-panel');
  if (!root) return;
  var SCENARIO = root.dataset.scenario || 'unknown';
  var PHASE = root.dataset.phase || '';
  var STORAGE_KEY = 'doclayer-feedback-' + SCENARIO;
  var API_URL = '/api/draft-feedback';
  var CANNED_URL = 'feedback-canned.json';
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- DOM ----
  var trigger    = document.getElementById('fbTrigger');
  var scrim      = document.getElementById('fbScrim');
  var panel      = document.getElementById('fbPanel');
  var closeBtn   = document.getElementById('fbClose');
  var text       = document.getElementById('fbText');
  var count      = document.getElementById('fbCount');
  var submit     = document.getElementById('fbSubmit');
  var drafting   = document.getElementById('fbDrafting');
  var response   = document.getElementById('fbResponse');
  var respBody   = document.getElementById('fbRespBody');
  var modeSub    = document.getElementById('fbModeSub');
  var againBtn   = document.getElementById('fbAgain');
  var err        = document.getElementById('fbError');
  var errMsg     = document.getElementById('fbErrorMsg');
  var retryBtn   = document.getElementById('fbRetry');
  var hist       = document.getElementById('fbHistory');
  // Optional: scenario-specific embellishments. Missing = silent no-op.
  var gutter     = document.getElementById('gutter');
  var pipV       = document.getElementById('pip-v');
  var roleBtns   = panel.querySelectorAll('.fb-role');

  var currentRole = 'writer';
  var lastPayload = null;
  var cannedCache = null;

  // ---- Open / close ----
  function open() {
    panel.classList.add('open');
    scrim.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('fb-open');
    renderHistory();
    setTimeout(function () { try { text.focus(); } catch (e) {} }, 220);
  }
  function close() {
    panel.classList.remove('open');
    scrim.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('fb-open');
  }
  trigger.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) close();
  });

  // ---- Role pills ----
  roleBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      roleBtns.forEach(function (x) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      currentRole = b.getAttribute('data-role');
    });
  });

  // ---- Textarea / counter / submit-enable ----
  function refreshCount() {
    var n = text.value.length;
    count.textContent = n + ' / 300';
    count.classList.toggle('warn', n > 270);
    submit.disabled = text.value.trim().length < 3;
  }
  text.addEventListener('input', refreshCount);

  // ---- localStorage thread ----
  function loadThread() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveThread(items) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-20))); }
    catch (e) {}
  }
  function pushThread(entry) {
    var items = loadThread();
    items.push(entry);
    saveThread(items);
  }
  function renderHistory() {
    var items = loadThread();
    if (!items.length) { hist.classList.remove('on'); hist.innerHTML = ''; return; }
    var html = '<div class="fb-hist-title">prior thread · ' + items.length + '</div>';
    items.slice().reverse().forEach(function (it) {
      var when = new Date(it.timestamp);
      var ts = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += '<div class="fb-hist-item">'
            +   '<span class="fb-hist-ts">' + ts + '</span>'
            +   '<span class="fb-hist-you">you (' + escapeHtml(it.role) + '): </span>'
            +   escapeHtml(it.feedback)
            +   '<span class="fb-hist-arch">↳ ' + escapeHtml(it.response) + '</span>'
            + '</div>';
    });
    hist.innerHTML = html;
    hist.classList.add('on');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  // ---- Gutter particle: fire the third-writer event once ----
  // No-op on scenarios without a #gutter element.
  function fireGutterParticle() {
    if (!gutter) return;
    var ev = document.createElement('span');
    ev.className = 'ev third fire-once';
    ev.style.top = '36%';
    ev.innerHTML = '<span class="who">you ·</span> comment · third writer';
    gutter.appendChild(ev);
    setTimeout(function () { if (ev.parentNode) ev.parentNode.removeChild(ev); }, 1800);
  }

  // ---- Architect pip pulse (09 only — pip-v exists) ----
  function pipDrafting(on) {
    if (!pipV) return;
    if (on) {
      pipV.classList.add('fb-drafting-pip');
      pipV._fbPrev = pipV.textContent;
      pipV.textContent = 'architect: drafting reply';
    } else {
      pipV.classList.remove('fb-drafting-pip');
      // Don't restore text — the 30s loop reclaims it on the next frame.
    }
  }

  // ---- Typing engine: local typer for the response body ----
  function typeInto(el, fullText, onDone) {
    if (REDUCED) { el.textContent = fullText; el.classList.remove('tw-typing'); el.classList.add('tw-done'); if (onDone) onDone(); return; }
    el.textContent = '';
    el.classList.add('tw-typing');
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
        el.classList.remove('tw-typing');
        el.classList.add('tw-done');
        if (onDone) onDone();
        return;
      }
      var ch = fullText.charAt(i++);
      el.textContent += ch;
      setTimeout(step, delay(ch));
    }
    step();
  }

  // ---- Canned fallback (regex pattern match) ----
  function fetchCanned() {
    if (cannedCache) return Promise.resolve(cannedCache);
    return fetch(CANNED_URL).then(function (r) { return r.json(); }).then(function (j) {
      cannedCache = j;
      return j;
    });
  }
  function pickCanned(feedback, role, canned) {
    var responses = (canned && canned.responses) || [];
    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      try {
        // The canned file uses PCRE-style "(?i)" inline flags; JS doesn't
        // support those, so strip them and apply the 'i' flag instead.
        var src = r.pattern.replace(/^\(\?i\)/, '');
        var re = new RegExp(src, 'i');
        if (re.test(feedback)) return r;
      } catch (e) { /* skip bad pattern */ }
    }
    return responses[responses.length - 1] || { response: 'logged.', routedTo: 'both' };
  }

  // ---- Submit flow ----
  function showError(msg, retryable) {
    err.classList.add('on');
    errMsg.textContent = msg;
    retryBtn.style.display = retryable ? '' : 'none';
  }
  function clearStates() {
    err.classList.remove('on');
    response.classList.remove('on');
    drafting.classList.remove('on');
    modeSub.style.display = 'none';
  }

  function doSubmit() {
    var feedback = text.value.trim();
    if (feedback.length < 3) return;
    lastPayload = { scenario: SCENARIO, phase: PHASE, role: currentRole, feedback: feedback };

    clearStates();
    drafting.classList.add('on');
    submit.disabled = true;
    pipDrafting(true);
    fireGutterParticle();

    var started = Date.now();
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastPayload),
    }).then(function (res) {
      return res.json().then(function (json) { return { status: res.status, body: json }; });
    }).then(function (out) {
      var elapsed = Date.now() - started;
      var minDelay = Math.max(0, 900 - elapsed); // keep at least ~0.9s of drafting state
      setTimeout(function () { handleResponse(out); }, minDelay);
    }).catch(function () {
      // Network error / no API mounted → degrade to canned.
      fetchCanned().then(function (canned) {
        var pick = pickCanned(lastPayload.feedback, lastPayload.role, canned);
        pipDrafting(false);
        drafting.classList.remove('on');
        renderResponse(pick.response, true, pick.routedTo);
      }).catch(function () {
        pipDrafting(false);
        drafting.classList.remove('on');
        submit.disabled = false;
        showError("couldn't draft — try again", true);
      });
    });
  }

  function handleResponse(out) {
    pipDrafting(false);
    drafting.classList.remove('on');

    if (out.status >= 200 && out.status < 300 && out.body && out.body.response) {
      renderResponse(out.body.response, false, out.body.routedTo);
      return;
    }
    if (out.status === 503 && out.body && out.body.fallback === 'canned') {
      fetchCanned().then(function (canned) {
        var pick = pickCanned(lastPayload.feedback, lastPayload.role, canned);
        renderResponse(pick.response, true, pick.routedTo);
      }).catch(function () {
        submit.disabled = false;
        showError("couldn't load fallback — try again", true);
      });
      return;
    }
    if (out.status === 429) {
      submit.disabled = false;
      showError('rate limited, try again in a minute', false);
      return;
    }
    submit.disabled = false;
    var msg = (out.body && out.body.error) ? ("couldn't draft — " + out.body.error) : "couldn't draft — try again";
    showError(msg, true);
  }

  function renderResponse(textOut, isCanned, routedTo) {
    response.classList.add('on');
    modeSub.style.display = isCanned ? '' : 'none';
    // Update route hint
    var routeEl = response.querySelector('.fb-route');
    if (routedTo && routeEl) routeEl.textContent = '· routed to ' + routedTo;
    typeInto(respBody, textOut, function () {
      // Persist this exchange to localStorage thread
      pushThread({
        feedback: lastPayload.feedback,
        response: textOut,
        role: lastPayload.role,
        routedTo: routedTo || null,
        canned: !!isCanned,
        timestamp: Date.now(),
      });
    });
  }

  submit.addEventListener('click', doSubmit);
  retryBtn.addEventListener('click', doSubmit);
  againBtn.addEventListener('click', function () {
    clearStates();
    text.value = '';
    refreshCount();
    renderHistory();
    try { text.focus(); } catch (e) {}
  });

  // Keyboard shortcut: cmd/ctrl+Enter to submit
  text.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !submit.disabled) {
      e.preventDefault();
      doSubmit();
    }
  });

  refreshCount();
})();
