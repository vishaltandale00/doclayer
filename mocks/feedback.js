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
  var QUEUE_KEY = 'doclayer-feedback-queue-' + SCENARIO;
  var API_URL = '/api/draft-feedback';
  var PERSIST_URL = '/api/comments/post';
  var CANNED_URL = 'feedback-canned.json';
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Auth: fetch the current Supabase JWT (null if anonymous).
  // Identity layer owns the supabase client; we just borrow getSession().
  function getJwt() {
    var supa = (window.doclayerIdentity && window.doclayerIdentity.getSupabase)
      ? window.doclayerIdentity.getSupabase() : null;
    if (!supa) return Promise.resolve(null);
    return supa.auth.getSession().then(function (r) {
      return (r && r.data && r.data.session && r.data.session.access_token) || null;
    }).catch(function () { return null; });
  }
  function authHeaders(jwt) {
    var h = { 'Content-Type': 'application/json' };
    if (jwt) h['Authorization'] = 'Bearer ' + jwt;
    return h;
  }

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
  var pipEl      = document.querySelector('.harness-strip .pip') || document.getElementById('pip-v');
  var draftLabel = drafting && drafting.querySelector('span:not(.fb-pulse)');

  var lastPayload = null;
  var cannedCache = null;
  var stageTimer = null;
  var countdownTimer = null;
  var queueBanner = null;

  // ---- Open / close ----
  function open() {
    panel.classList.add('open');
    scrim.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('fb-open');
    renderHistory();
    renderQueueBanner();
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
            +   '<span class="fb-hist-you">you: </span>'
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
    if (!gutter || REDUCED) return;
    var ev = document.createElement('span');
    ev.className = 'ev third fire-once';
    ev.style.top = '36%';
    ev.innerHTML = '<span class="who">you ·</span> comment · third writer';
    gutter.appendChild(ev);
    setTimeout(function () { if (ev.parentNode) ev.parentNode.removeChild(ev); }, 1800);
  }

  // ---- Universal submit→pip particle: single dot, gentle arc to architect ----
  // Fires on every scenario that has a .harness-strip .pip (or #pip-v fallback).
  function fireCommentParticle() {
    if (REDUCED) return;
    var pip = document.querySelector('.harness-strip .pip') || document.getElementById('pip-v');
    if (!pip || !submit) return;
    var sRect = submit.getBoundingClientRect();
    var pRect = pip.getBoundingClientRect();
    if (!sRect.width || !pRect.width) return;
    var startX = sRect.left + sRect.width / 2;
    var startY = sRect.top + sRect.height / 2;
    var endX = pRect.left + pRect.width / 2;
    var endY = pRect.top + pRect.height / 2;
    var dx = endX - startX;
    var dy = endY - startY;
    // Gentle arc: lift the midpoint by 12% of the travel distance, clamped.
    var arc = Math.min(60, Math.max(18, Math.hypot(dx, dy) * 0.12));
    var dot = document.createElement('span');
    dot.className = 'fb-particle';
    dot.style.left = (startX - 4) + 'px';
    dot.style.top  = (startY - 4) + 'px';
    dot.style.setProperty('--fb-dx', dx + 'px');
    dot.style.setProperty('--fb-dy', dy + 'px');
    dot.style.setProperty('--fb-arc', (-arc) + 'px');
    document.body.appendChild(dot);
    setTimeout(function () { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 760);
  }

  // ---- Architect pip pulse ----
  function pipDrafting(on) {
    if (!pipEl) return;
    if (on) {
      pipEl.classList.add('fb-drafting-pip');
      pipEl._fbPrev = pipEl.textContent;
      pipEl.textContent = 'architect: drafting reply';
    } else {
      pipEl.classList.remove('fb-drafting-pip');
    }
  }

  function startStages() {
    if (!draftLabel) return;
    var s = ['reading your comment…', 'routing your comment…', 'drafting response…'], i=0;
    draftLabel.textContent = s[0];
    stageTimer = setInterval(function(){ if(++i>=s.length){clearInterval(stageTimer);stageTimer=null;return;} draftLabel.textContent=s[i]; }, 600);
  }
  function stopStages() {
    if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
    if (draftLabel) draftLabel.textContent = 'architect drafting…';
  }
  function endDrafting() { stopStages(); pipDrafting(false); drafting.classList.remove('on'); }
  function loadQueue(){try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');}catch(e){return[];}}
  function saveQueue(q){try{localStorage.setItem(QUEUE_KEY,JSON.stringify(q.slice(-10)));}catch(e){}}
  function renderQueueBanner() {
    if (queueBanner && queueBanner.parentNode) queueBanner.parentNode.removeChild(queueBanner);
    queueBanner = null;
    var q = loadQueue();
    if (!q.length) return;
    queueBanner = document.createElement('div');
    queueBanner.className = 'fb-queue';
    queueBanner.innerHTML = q.length+' comment'+(q.length>1?'s':'')+' waiting · <button class="fb-queue-try" type="button">try now</button>';
    var body = panel.querySelector('.fb-body');
    body.insertBefore(queueBanner, body.firstChild);
    queueBanner.querySelector('.fb-queue-try').addEventListener('click', function () {
      var q = loadQueue(), item = q.shift(); if (!item) return;
      saveQueue(q);
      text.value = item.payload.feedback;
      refreshCount(); renderQueueBanner(); doSubmit();
    });
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
  function pickCanned(feedback, canned) {
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
  function setSubmitting(on) {
    submit.disabled = on || text.value.trim().length < 3;
    submit.textContent = on ? 'drafting…' : 'send to architect ↗';
  }
  function showError(msg, retryable) {
    err.classList.add('on');
    errMsg.textContent = msg;
    retryBtn.style.display = retryable ? '' : 'none';
  }
  function startCountdown(s) {
    if (countdownTimer) clearInterval(countdownTimer);
    retryBtn.style.display = 'none';
    function tick() {
      errMsg.textContent = "you're typing fast · try again in "+s+'s';
      if (s-- <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        errMsg.textContent = 'ready · try again';
        retryBtn.style.display = ''; setSubmitting(false);
      }
    }
    tick(); countdownTimer = setInterval(tick, 1000);
  }
  function clearStates() {
    err.classList.remove('on');
    response.classList.remove('on');
    drafting.classList.remove('on');
    modeSub.style.display = 'none';
    stopStages();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // Surface a non-blocking inline notice. The architect call still runs;
  // this is just a hint that the comment didn't persist server-side. Uses
  // the existing #fbError container but doesn't suspend the submit flow.
  function showInlineNotice(msg, ctaLabel, ctaFn) {
    err.classList.add('on');
    errMsg.textContent = msg;
    if (ctaLabel && ctaFn) {
      retryBtn.style.display = '';
      retryBtn.textContent = ctaLabel;
      retryBtn.onclick = function () {
        retryBtn.onclick = null;
        retryBtn.textContent = 'retry';
        ctaFn();
      };
    } else {
      retryBtn.style.display = 'none';
    }
  }

  // POST /api/comments/post. Returns { status, body } envelope; never throws.
  function persistComment(payload, jwt) {
    return fetch(PERSIST_URL, {
      method: 'POST',
      headers: authHeaders(jwt),
      body: JSON.stringify({
        scenario: payload.scenario,
        phase: payload.phase || undefined,
        feedback: payload.feedback,
        // No anchor in the global-widget flow; comments.js sends one.
      }),
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, body: j, headers: res.headers }; },
                            function () { return { status: res.status, body: {}, headers: res.headers }; });
    }).catch(function () {
      // Network/5xx fall-through. Caller treats as "skip persistence".
      return { status: 0, body: {}, headers: null };
    });
  }

  function doSubmit() {
    var feedback = text.value.trim();
    if (feedback.length < 3) return;
    lastPayload = { scenario: SCENARIO, phase: PHASE, feedback: feedback };

    clearStates();
    drafting.classList.add('on');
    setSubmitting(true);
    fireCommentParticle();
    startStages();
    pipDrafting(true);
    fireGutterParticle();

    var started = Date.now();

    // ---- Persistence-first flow ----
    // Step 1: hit /api/comments/post so the comment lands in the DB.
    // Step 2: hit /api/draft-feedback with the comment_id so the architect
    //         response is attached onto that same row.
    // The 401/429/422 paths short-circuit the persistence half but still
    // call the architect with NO comment_id, so the user gets a response
    // (just unpersisted). 5xx/network → fall through silently to the
    // unpersisted architect call (existing canned-fallback path covers it).
    getJwt().then(function (jwt) {
      if (!jwt) {
        // Anonymous: skip persistence; show inline sign-in CTA.
        showInlineNotice("sign in to save your feedback to the timeline", "sign in", function () {
          if (window.doclayerIdentity && typeof window.doclayerIdentity.openModal === 'function') {
            window.doclayerIdentity.openModal({});
          } else if (window.doclayerEnsureIdentity) {
            window.doclayerEnsureIdentity();
          }
        });
        return runArchitect(null, jwt, started);
      }
      return persistComment(lastPayload, jwt).then(function (p) {
        if (p.status >= 200 && p.status < 300 && p.body && p.body.comment_id) {
          // Clear any prior inline notice from a previous attempt.
          err.classList.remove('on');
          return runArchitect(p.body.comment_id, jwt, started);
        }
        if (p.status === 401) {
          showInlineNotice("session expired — sign in to save your feedback", "sign in", function () {
            if (window.doclayerIdentity && typeof window.doclayerIdentity.openModal === 'function') {
              window.doclayerIdentity.openModal({});
            }
          });
          return runArchitect(null, jwt, started);
        }
        if (p.status === 429) {
          var retryAfter = 60;
          try {
            if (p.headers && typeof p.headers.get === 'function') {
              var ra = p.headers.get('Retry-After');
              if (ra) retryAfter = Math.max(1, parseInt(ra, 10) || 60);
            }
            if (p.body && typeof p.body.retry_after_seconds === 'number') {
              retryAfter = Math.max(1, p.body.retry_after_seconds);
            }
          } catch (e) {}
          // Mirror the existing 429 affordance: surface the countdown in #fbError.
          endDrafting();
          setSubmitting(true);
          err.classList.add('on');
          startCountdown(retryAfter);
          errMsg.textContent = "you've left a lot of feedback recently — try again in " + retryAfter + "s";
          return; // Skip architect entirely on rate-limit.
        }
        if (p.status === 422) {
          var detail = (p.body && (p.body.detail || p.body.error)) || 'validation error';
          showInlineNotice("couldn't save: " + detail, null, null);
          return runArchitect(null, jwt, started);
        }
        // 5xx / 0 (network) — fall through to architect call without persistence.
        return runArchitect(null, jwt, started);
      });
    });
  }

  function runArchitect(commentId, jwt, started) {
    var body = { scenario: lastPayload.scenario, phase: lastPayload.phase, feedback: lastPayload.feedback };
    if (commentId) body.comment_id = commentId;
    return fetch(API_URL, {
      method: 'POST',
      headers: authHeaders(jwt),
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, body: j }; },
                            function () { return { status: res.status, body: {} }; });
    }).then(function (out) {
      var minDelay = Math.max(0, 900 - (Date.now() - started));
      setTimeout(function () { handleResponse(out); }, minDelay);
    }).catch(function () {
      fetchCanned().then(function (canned) {
        var pick = pickCanned(lastPayload.feedback, canned);
        endDrafting();
        renderResponse(pick.response, true, pick.routedTo);
      }).catch(function () {
        endDrafting(); setSubmitting(false);
        var q=loadQueue(); q.push({payload:lastPayload,pending:true,timestamp:Date.now()}); saveQueue(q);
        showError("couldn't reach the architect · saved locally · will draft when online", true);
      });
    });
  }

  function handleResponse(out) {
    endDrafting();

    if (out.status >= 200 && out.status < 300 && out.body && out.body.response) {
      renderResponse(out.body.response, false, out.body.routedTo);
      return;
    }
    if (out.status === 503 && out.body && out.body.fallback === 'canned') {
      fetchCanned().then(function (canned) {
        var pick = pickCanned(lastPayload.feedback, canned);
        renderResponse(pick.response, true, pick.routedTo);
      }).catch(function () {
        setSubmitting(false);
        showError("couldn't load fallback — try again", true);
      });
      return;
    }
    if (out.status === 429) {
      setSubmitting(true);
      err.classList.add('on');
      startCountdown(60);
      return;
    }
    setSubmitting(false);
    if (out.status === 502 || out.status === 500) {
      showError('the architect glitched · retry?', true);
      return;
    }
    var msg = (out.body && out.body.error) ? ("couldn't draft — " + out.body.error) : "couldn't draft — try again";
    showError(msg, true);
  }

  function renderResponse(textOut, isCanned, routedTo) {
    response.classList.add('on');
    modeSub.style.display = isCanned ? '' : 'none';
    var routeEl = response.querySelector('.fb-route');
    if (routedTo && routeEl) routeEl.textContent = '· routed to ' + routedTo;
    setSubmitting(false);
    typeInto(respBody, textOut, function () {
      pushThread({
        feedback: lastPayload.feedback,
        response: textOut,
        routedTo: routedTo || null,
        canned: !!isCanned,
        timestamp: Date.now(),
      });
    });
  }

  submit.addEventListener('click', doSubmit);
  retryBtn.addEventListener('click', function () {
    clearStates();
    doSubmit();
  });
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
