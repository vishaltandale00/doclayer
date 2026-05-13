/* =============================================================
   doclayer patch-renderer — Phase 4 client patch flow.

   On scenario load: fetches the current user's applied patches
   for this scenario from Supabase and replays them against the
   live DOM (CSS vars on :root, microcopy textContent swaps,
   visibility toggles, animation scale). Exposes a small API for
   comments.js to live-apply freshly drafted patches and to
   undo within the 60s window.

   Public globals:
     window.doclayerPatchRenderer
       .applyPatchLive(patch)              — POST to /api/variants/apply
       .undoPatch(patchId)                 — POST to /api/variants/undo
       .getPatchHistoryAtPath(schemaPath)  — for hover popover
       .ready                              — Promise<void> (initial replay done)

   No-ops gracefully when the viewer is anonymous or Supabase is
   unavailable. Block ops are out of scope for v1 mocks.
   ============================================================= */
(function () {
  'use strict';
  if (window.__doclayerPatchRenderer) return;
  window.__doclayerPatchRenderer = true;

  var SCENARIO = detectScenario();
  var APPLY_URL = '/api/variants/apply';
  var UNDO_URL  = '/api/variants/undo';
  var VARIANT_PREFIX = '/variant';
  var CSS_VARS_URL = 'css-vars.json'; // relative; build-inject-env copies it next to this file

  // patch_id -> { patch, ops, appliedAt, supersededBy }
  var appliedPatches = new Map();
  // schemaPath -> [patch_id, ...] (chronological)
  var pathHistory = new Map();
  var popoverEl = null;
  var popoverTimer = null;
  var popoverFor = null;

  // ---- CSS-var registry (single source of truth, fetched from server) ----
  // We mirror lib/css-vars.ts at build time via mocks/css-vars.json. If the
  // fetch fails (offline / file moved), we keep a minimal fallback so colors
  // still apply — but log loudly so the drift is visible.
  var cssVarRegistry = null;        // Array<{name, schemaPath, default}>
  var cssVarBySchemaPath = null;    // Map<schemaPath, entry>
  var cssVarRegistryReady = null;   // Promise<void>

  function loadCssVarRegistry() {
    if (cssVarRegistryReady) return cssVarRegistryReady;
    cssVarRegistryReady = fetch(CSS_VARS_URL, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('css-vars.json ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var entries = (j && Array.isArray(j.entries)) ? j.entries : [];
        cssVarRegistry = entries;
        cssVarBySchemaPath = new Map();
        entries.forEach(function (e) { cssVarBySchemaPath.set(e.schemaPath, e); });
      })
      .catch(function (err) {
        console.warn('[doclayer-patch] css-vars.json fetch failed — applying patches without registry', err);
        cssVarRegistry = [];
        cssVarBySchemaPath = new Map();
      });
    return cssVarRegistryReady;
  }

  function detectScenario() {
    var body = document.body;
    if (body && body.dataset && body.dataset.scenario) return body.dataset.scenario;
    var fb = document.querySelector('.fb-panel[data-scenario]');
    if (fb && fb.dataset.scenario) return fb.dataset.scenario;
    var path = (location.pathname || '').split('/').pop() || '';
    return path.replace(/\.html?$/i, '') || 'index';
  }

  // ---- path → DOM application ----
  function applyOpToDom(op) {
    if (op.op === 'test') return;
    var path = op.path || '';
    if (!path.startsWith(VARIANT_PREFIX + '/')) return;

    // Registry-driven CSS-var application — single source of truth shipped
    // from lib/css-vars.ts → mocks/css-vars.json. Replaces the prior bespoke
    // regex/name-mapping which was drifting from the server registry.
    if (cssVarBySchemaPath) {
      var entry = cssVarBySchemaPath.get(path);
      if (entry) {
        var v = op.op === 'remove' ? '' : op.value;
        document.documentElement.style.setProperty(entry.name, String(v));
        return;
      }
    }

    // /variant/microcopy/<key>
    var m = path.match(/^\/variant\/microcopy\/(.+)$/);
    if (m) {
      var key = m[1];
      var nodes = document.querySelectorAll('[data-patchable="' + cssEscape(key) + '"]');
      nodes.forEach(function (n) {
        // Never innerHTML — textContent only.
        if (n.getAttribute('data-patchable-type') !== 'block') {
          n.textContent = String(op.value);
        }
      });
      return;
    }
    // /variant/visibility/<key>
    m = path.match(/^\/variant\/visibility\/(.+)$/);
    if (m) {
      var vkey = m[1];
      var vnodes = document.querySelectorAll('[data-patchable="' + cssEscape(vkey) + '"][data-patchable-type="visible"]');
      vnodes.forEach(function (n) {
        if (op.value === false) n.classList.add('patched-hidden');
        else n.classList.remove('patched-hidden');
      });
      return;
    }
    // Block ops — out of scope for v1.
    if (/^\/variant\/content\/blocks\//.test(path)) {
      console.warn('[doclayer-patch] block op skipped (v1 mock):', path);
      return;
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function trackPatch(patchRow) {
    var patchId = patchRow.id || patchRow.patch_id;
    var spec = patchRow.spec || patchRow;
    var ops = (spec.effective_ops && spec.effective_ops.length) ? spec.effective_ops : (spec.ops || []);
    appliedPatches.set(patchId, {
      id: patchId,
      patch: spec,
      ops: ops,
      // Surface macro and effective_ops so the popover can label macro patches
      // (kind + blockId for block ops). Empty/absent → row renders without badge.
      macro: spec.macro || null,
      effectiveOps: Array.isArray(spec.effective_ops) ? spec.effective_ops : null,
      intent: spec.intent || '(no intent)',
      appliedAt: patchRow.applied_at || patchRow.appliedAt || new Date().toISOString(),
      supersededById: patchRow.superseded_by_id || null,
      author: patchRow.author_email || (window.doclayerIdentity && window.doclayerIdentity.get() && window.doclayerIdentity.get().email) || '',
    });
    ops.forEach(function (op) {
      if (op.op === 'test') return;
      var list = pathHistory.get(op.path) || [];
      list.push(patchId);
      pathHistory.set(op.path, list);
    });
  }

  // ---- Reset CSS vars to registry defaults ----
  // Used before re-replaying after undo so any vars touched only by the
  // undone patch (and absent from remaining patches) fall back cleanly.
  function resetCssVarsToDefaults() {
    if (!cssVarRegistry) return;
    var root = document.documentElement;
    cssVarRegistry.forEach(function (e) {
      // Setting the property to '' removes it, exposing the stylesheet default.
      // We intentionally use '' rather than e.default so an unauthored var
      // inherits from style.css rather than being pinned to a stale JSON value.
      root.style.removeProperty(e.name);
    });
  }

  // ---- Initial fetch + replay ----
  function fetchAndReplay() {
    // Always ensure the registry is loaded — even for anonymous viewers, so
    // that any post-signin live-apply has the mapping available.
    var regP = loadCssVarRegistry();
    if (!window.doclayerIdentity) return regP;
    var supa = window.doclayerIdentity.getSupabase && window.doclayerIdentity.getSupabase();
    var variantId = window.doclayerIdentity.getVariantId && window.doclayerIdentity.getVariantId();
    if (!supa || !variantId) return regP;

    return regP.then(function () {
      return supa.from('patches')
        .select('id, spec, status, applied_at, superseded_by_id, scenario_id')
        .eq('variant_id', variantId)
        .eq('scenario_id', SCENARIO)
        .eq('status', 'applied')
        .order('applied_at', { ascending: true });
    }).then(function (res) {
      if (!res) return;
      if (res.error) { console.warn('[doclayer-patch] fetch failed', res.error); return; }
      // Wipe local registries: this is a canonical replay.
      appliedPatches.clear();
      pathHistory.clear();
      resetCssVarsToDefaults();
      var rows = res.data || [];
      rows.forEach(function (row) {
        trackPatch(row);
        var ops = (row.spec && row.spec.effective_ops && row.spec.effective_ops.length)
          ? row.spec.effective_ops : ((row.spec && row.spec.ops) || []);
        ops.forEach(applyOpToDom);
      });
    }).catch(function (err) { console.warn('[doclayer-patch] fetch threw', err); });
  }

  // ---- Live apply (called from comments.js after server 2xx) ----
  function applyPatchLive(patch, patchId) {
    var ops = (patch.effective_ops && patch.effective_ops.length) ? patch.effective_ops : (patch.ops || []);
    ops.forEach(applyOpToDom);
    if (patchId) {
      trackPatch({
        id: patchId,
        spec: patch,
        applied_at: new Date().toISOString(),
        scenario_id: SCENARIO,
      });
    }
  }

  // ---- Undo ----
  // Server-authoritative: POST to /api/variants/undo, then on 200 perform a
  // canonical replay against the now-current applied patches. This avoids the
  // client synthesizing inverse ops (which silently no-ops on macro-only
  // patches whose ops[] is empty). Errors are mapped to typed Error.code so
  // callers can drive UI state (e.g. UNDO_WINDOW_EXPIRED → countdown.expired).
  function undoPatch(patchId) {
    if (!window.doclayerIdentity) return Promise.reject(taggedErr('NO_IDENTITY', 'no identity'));
    var supa = window.doclayerIdentity.getSupabase && window.doclayerIdentity.getSupabase();
    if (!supa) return Promise.reject(taggedErr('NO_SUPABASE', 'no supabase'));
    return supa.auth.getSession().then(function (res) {
      var token = res && res.data && res.data.session && res.data.session.access_token;
      var variantId = window.doclayerIdentity.getVariantId();
      return fetch(UNDO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? ('Bearer ' + token) : '',
        },
        body: JSON.stringify({ patch_id: patchId, variant_id: variantId }),
      });
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var code = (j && j.error) || ('http_' + r.status);
          var msg;
          if (r.status === 410 || code === 'UNDO_WINDOW_EXPIRED' || code === 'NOT_APPLIED') {
            msg = 'undo window has expired';
            code = 'UNDO_WINDOW_EXPIRED';
          } else if (r.status === 401 || r.status === 403) {
            msg = "you're not signed in for this variant";
          } else if (r.status === 412 || code === 'PRECONDITION_FAILED') {
            msg = 'state has changed — refresh to see the latest';
          } else {
            msg = "couldn't undo (" + code + ')';
          }
          throw taggedErr(code, msg, r.status);
        });
      }
      return r.json().then(function (j) {
        // Server-authoritative replay: prefer re-fetching the canonical
        // applied-patch list and re-applying from scratch. This is the same
        // code path as initial replay, just triggered explicitly. We don't
        // diff against j.doc directly because cssVar/microcopy DOM application
        // is path-keyed, not state-keyed — replaying patches is simpler.
        return fetchAndReplay().then(function () { return j; });
      });
    });
  }

  function taggedErr(code, msg, status) {
    var e = new Error(msg || code);
    e.code = code;
    if (typeof status === 'number') e.status = status;
    return e;
  }

  // ---- History query for popover ----
  function getPatchHistoryAtPath(schemaPath) {
    var ids = pathHistory.get(schemaPath) || [];
    return ids.map(function (id) { return appliedPatches.get(id); }).filter(Boolean);
  }

  // ---- Hover popover on [data-patchable] elements ----
  function ensurePopover() {
    if (popoverEl) return popoverEl;
    popoverEl = document.createElement('div');
    popoverEl.className = 'patch-stack-popover';
    popoverEl.style.display = 'none';
    popoverEl.addEventListener('mouseenter', function () { if (popoverTimer) clearTimeout(popoverTimer); });
    popoverEl.addEventListener('mouseleave', hidePopover);
    document.body.appendChild(popoverEl);
    document.addEventListener('click', function (e) {
      if (popoverEl && popoverEl.style.display !== 'none' && !popoverEl.contains(e.target)) hidePopover();
    });
    return popoverEl;
  }

  function schemaPathForElement(el) {
    var key = el.getAttribute('data-patchable');
    if (!key) return null;
    var type = el.getAttribute('data-patchable-type') || 'microcopy';
    if (type === 'visible') return '/variant/visibility/' + key;
    if (type === 'block') return null; // block-level — out of scope
    // Default: microcopy. Could be a css-var bound element too; the page can
    // disambiguate by also matching cssVars paths in history.
    return '/variant/microcopy/' + key;
  }

  function renderPopover(history, currentEl) {
    if (!history.length) {
      popoverEl.innerHTML = '<div class="psp-empty">no patches here yet</div>';
      return;
    }
    var rows = history.map(function (h) {
      var when = h.appliedAt ? new Date(h.appliedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      var status = h.supersededById ? 'superseded' : 'applied';
      // Macro envelope badge: surface the kind, and for block ops include the
      // first 8 chars of blockId so it's clear *which* block was inserted/deleted.
      var macroBadge = '';
      if (h.macro && typeof h.macro === 'object') {
        var kind = h.macro.kind || 'macro';
        var label = 'macro: ' + kind;
        if ((kind === 'insert_block' || kind === 'delete_block') && h.macro.params) {
          var blockId = h.macro.params.blockId || h.macro.params.block_id;
          if (blockId) {
            var verb = (kind === 'insert_block') ? 'insert block' : 'delete block';
            label = verb + ' ' + String(blockId).slice(0, 8);
          }
        }
        macroBadge = '<span class="psp-macro-badge" title="' + escapeHtml(kind) + '">' + escapeHtml(label) + '</span>';
      }
      return '<div class="psp-row psp-' + status + '">' +
        '<span class="psp-when">' + escapeHtml(when) + '</span>' +
        '<span class="psp-intent">' + escapeHtml(h.intent) + macroBadge + '</span>' +
        '<span class="psp-author">' + escapeHtml(h.author || '') + '</span>' +
        '<span class="psp-badge psp-badge-' + status + '">' + status + '</span>' +
        '</div>';
    }).join('');
    var current = currentEl ? (currentEl.textContent || '').slice(0, 80) : '';
    popoverEl.innerHTML =
      '<div class="psp-head">current value</div>' +
      '<div class="psp-current">' + escapeHtml(current) + '</div>' +
      '<div class="psp-head">patch stack · ' + history.length + '</div>' +
      rows;
  }

  function positionPopover(x, y) {
    var W = 320, H = 200;
    var vw = window.innerWidth, vh = window.innerHeight;
    var bx = (x + 14 + W < vw) ? (x + 14) : (x - 14 - W);
    var by = (y + 14 + H < vh) ? (y + 14) : Math.max(8, y - 14 - H);
    popoverEl.style.left = Math.max(8, Math.min(bx, vw - W - 8)) + 'px';
    popoverEl.style.top = Math.max(8, by) + 'px';
  }

  function showPopover(el, x, y) {
    var path = schemaPathForElement(el);
    if (!path) return;
    var history = getPatchHistoryAtPath(path);
    if (!history.length) return;
    ensurePopover();
    renderPopover(history, el);
    positionPopover(x, y);
    popoverEl.style.display = 'block';
    popoverFor = el;
  }

  function hidePopover() {
    if (popoverTimer) { clearTimeout(popoverTimer); popoverTimer = null; }
    if (popoverEl) popoverEl.style.display = 'none';
    popoverFor = null;
  }

  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var el = t.closest('[data-patchable]');
    if (!el) return;
    if (popoverFor === el) return;
    if (popoverTimer) clearTimeout(popoverTimer);
    var x = e.clientX, y = e.clientY;
    popoverTimer = setTimeout(function () { showPopover(el, x, y); }, 400);
  });
  document.addEventListener('mouseout', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var el = t.closest('[data-patchable]');
    if (!el) return;
    if (popoverTimer) { clearTimeout(popoverTimer); popoverTimer = null; }
    // Slight delay so the cursor can land on the popover.
    setTimeout(function () {
      if (popoverEl && !popoverEl.matches(':hover') && popoverFor === el) hidePopover();
    }, 150);
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  // ---- Bootstrap ----
  // Kick off registry load immediately — independent of identity, so an
  // anonymous viewer who later signs in and applies a patch via
  // applyPatchLive() has the registry ready synchronously.
  loadCssVarRegistry();
  var readyPromise = new Promise(function (resolve) {
    function go() {
      // Wait for identity to settle (it dispatches doclayer:identity-ready).
      var done = false;
      function attempt() {
        if (done) return;
        done = true;
        fetchAndReplay().then(resolve, resolve);
      }
      if (window.doclayerIdentity && window.doclayerIdentity.get && window.doclayerIdentity.get()) {
        attempt();
      } else {
        document.addEventListener('doclayer:identity-ready', attempt, { once: true });
        // Fallback after 2s for anonymous viewers.
        setTimeout(attempt, 2000);
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  });

  window.doclayerPatchRenderer = {
    applyPatchLive: applyPatchLive,
    undoPatch: undoPatch,
    getPatchHistoryAtPath: getPatchHistoryAtPath,
    getAppliedPatches: function () { return Array.from(appliedPatches.values()); },
    fetchAndReplay: fetchAndReplay,
    getCssVarRegistry: function () { return cssVarRegistry ? cssVarRegistry.slice() : []; },
    ready: readyPromise,
  };
})();
