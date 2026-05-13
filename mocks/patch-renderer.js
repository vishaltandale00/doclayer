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

  // ---- Cross-variant browse mode ----
  // When ?variant=<id> is in the URL, we fetch THAT variant's applied patches
  // instead of the signed-in user's, render a read-only banner, and disable
  // write affordances site-wide via body.variant-readonly.
  var BROWSE_VARIANT_ID = (function () {
    try {
      var u = new URLSearchParams(window.location.search);
      var v = u.get('variant');
      return v && /^[0-9a-fA-F-]{8,}$/.test(v) ? v : null;
    } catch (e) { return null; }
  })();
  var browseVariantMeta = null; // { email, id } once resolved

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
    // Cross-variant browse: prefer the URL-provided variant. Otherwise use the
    // signed-in user's variant.
    var variantId = BROWSE_VARIANT_ID
      || (window.doclayerIdentity.getVariantId && window.doclayerIdentity.getVariantId());
    if (!supa || !variantId) {
      // Still install the banner if a variant is requested but supabase is unavailable —
      // makes the read-only intent obvious even when fetches fail.
      if (BROWSE_VARIANT_ID) installBrowseBanner(BROWSE_VARIANT_ID, null);
      return regP;
    }

    return regP.then(function () {
      if (BROWSE_VARIANT_ID) {
        // Look up the owner's email-ish label for the banner. With no exposed
        // auth.users join we fall back to a slice of user_id.
        return supa.from('variants').select('id, user_id, name').eq('id', BROWSE_VARIANT_ID).maybeSingle()
          .then(function (vr) {
            var label = vr && vr.data ? ('viewer-' + String(vr.data.user_id).slice(0, 6)) : BROWSE_VARIANT_ID.slice(0, 8);
            // If it's the current user's own variant, use their email.
            var me = window.doclayerIdentity.get && window.doclayerIdentity.get();
            if (me && me.email && vr && vr.data && me.userId === vr.data.user_id) label = me.email;
            browseVariantMeta = { id: BROWSE_VARIANT_ID, email: label };
            installBrowseBanner(BROWSE_VARIANT_ID, label);
            return null;
          });
      }
      return null;
    }).then(function () {
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
      // Phase 6 prose escape hatch: replay accepted revision-variant swaps
      // from localStorage. Real Yjs is out of scope for v1 mocks; this is the
      // human-accept-in-live-editor simulation. Replay happens AFTER patches
      // so a patch that changes microcopy on the same element doesn't clobber
      // an accepted prose rewrite.
      replayAcceptedRevisions(variantId);
    }).catch(function (err) { console.warn('[doclayer-patch] fetch threw', err); });
  }

  // FNV-1a 32-bit hex. Non-crypto, drift detection only — used to detect that
  // the canonical prose at a data-prose target has changed since a revision
  // was accepted, so we don't overwrite NEW canonical with OLD suggested text.
  // ~6 lines; see comments.js for the matching helper used at accept time.
  function fnv1a32Hex(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // Read localStorage for any `doclayer:revision:<variantId>:<blockId>` keys
  // and swap textContent on matching `[data-prose]` elements. No-op outside
  // browse mode (we want each viewer's accepted rewrites to be local to
  // their own variant — browsing someone else's variant doesn't replay your
  // local accepts).
  //
  // P0-1 (defense-in-depth): refuse swap if target has structured descendants
  // (any [data-prose] / [data-patchable]) — otherwise textContent assignment
  // would destroy them and later patches/replays would no-op silently.
  //
  // P0-2: drift guard. localStorage entries are stored as JSON
  // `{ text, sourceHash, acceptedAt }` so we can compare hex32(currentText)
  // against the hash captured at accept time and SKIP if canonical changed.
  // Legacy plain-string entries (no hash) are accepted unconditionally for
  // backward compat.
  function replayAcceptedRevisions(variantId) {
    if (!variantId || typeof localStorage === 'undefined') return;
    var prefix = 'doclayer:revision:' + variantId + ':';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(prefix) !== 0) continue;
        var blockId = key.slice(prefix.length);
        var raw = localStorage.getItem(key);
        if (raw == null) continue;

        // Parse JSON envelope; fall back to legacy plain-string shape.
        var text = null, sourceHash = null;
        if (raw.charAt(0) === '{') {
          try {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
              text = parsed.text;
              sourceHash = typeof parsed.sourceHash === 'string' ? parsed.sourceHash : null;
            }
          } catch (e) { /* fall through to legacy */ }
        }
        if (text == null) { text = raw; sourceHash = null; }

        var el = document.querySelector('[data-prose="' + (window.CSS && CSS.escape ? CSS.escape(blockId) : blockId) + '"]');
        if (!el) continue;

        // Defense-in-depth (P0-1): refuse swap on container with structured
        // descendants. Skip + warn, do not surface bubble UI (we're replaying).
        if (el.querySelector('[data-prose], [data-patchable]')) {
          console.warn('[doclayer-patch] revision replay blocked — target has structured descendants', { blockId: blockId });
          el.dataset.revisionStale = '1';
          continue;
        }

        // P0-2 drift guard: compare current textContent hash to source hash
        // captured at accept time. Skip if they don't match (canonical drifted).
        if (sourceHash !== null) {
          var currentHash = fnv1a32Hex(el.textContent || '');
          if (currentHash !== sourceHash) {
            console.warn('[doclayer-patch] revision replay stale — canonical drifted since accept', { blockId: blockId, sourceHash: sourceHash, currentHash: currentHash });
            el.dataset.revisionStale = '1';
            continue;
          }
        }

        // P6: successful replay — clear any stale flag from a prior session.
        delete el.dataset.revisionStale;
        el.textContent = text;
      }
    } catch (e) {
      console.warn('[doclayer-patch] revision replay failed', e);
    }
  }

  // ---- Live apply (called from comments.js after server 2xx) ----
  function applyPatchLive(patch, patchId) {
    if (BROWSE_VARIANT_ID) {
      console.warn('[doclayer-patch] applyPatchLive blocked — read-only variant browse mode');
      return;
    }
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

  // ---- Cross-variant browse banner ----
  // Idempotent — safe to call multiple times. Adds body.variant-readonly so CSS
  // can suppress write affordances (comments.js apply button, feedback widget, etc.).
  // Rewrites internal scenario links to preserve ?variant=<id> so cross-page
  // navigation keeps you inside the browsed variant.
  function installBrowseBanner(variantId, label) {
    if (document.querySelector('.variant-readonly-banner')) return;
    document.body.classList.add('variant-readonly');
    var banner = document.createElement('div');
    banner.className = 'variant-readonly-banner';
    var displayLabel = label || ('viewer-' + String(variantId).slice(0, 6));
    banner.innerHTML =
      '<div class="vrb-inner">' +
        '<span class="vrb-dot" aria-hidden="true"></span>' +
        '<span class="vrb-text">browsing <b>' + escapeHtml(displayLabel) + '</b>\'s variant · read-only</span>' +
        '<a class="vrb-diff" href="variants.html#diff-' + escapeHtml(variantId) + '">diff vs. canonical →</a>' +
        '<a class="vrb-back" href="' + escapeHtml(stripVariantFromUrl()) + '">switch back to yours →</a>' +
      '</div>';
    document.body.insertBefore(banner, document.body.firstChild);
    // Rewrite all internal .html links currently in the DOM to preserve the
    // variant param so cross-scenario navigation stays in the browsed variant.
    rewriteAnchorsForBrowse(document, variantId);

    // Belt-and-suspenders: anything injected after install (comments.js,
    // identity modals, dynamically-built advance-pills, lifecycle ribbon)
    // needs the same rewrite — observe DOM mutations and rewrite new links.
    var linkObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (!node || node.nodeType !== 1) continue;
          // The node itself if it's an anchor:
          if (node.matches && node.matches('a[href]')) rewriteAnchorHrefForBrowse(node, variantId);
          // Descendant anchors:
          if (node.querySelectorAll) {
            var anchors = node.querySelectorAll('a[href]');
            for (var k = 0; k < anchors.length; k++) rewriteAnchorHrefForBrowse(anchors[k], variantId);
          }
        }
        // href attribute changes also need rewriting.
        if (m.type === 'attributes' && m.target && m.target.matches && m.target.matches('a[href]')) {
          rewriteAnchorHrefForBrowse(m.target, variantId);
        }
      }
    });
    linkObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    // Delegated click capture — catches anchors that JS may add+click in the
    // same tick (before the observer fires) or anchors built lazily via
    // event handlers. We intercept, mutate href, and let the browser proceed.
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      var a = t.closest && t.closest('a[href]');
      if (!a) return;
      rewriteAnchorHrefForBrowse(a, variantId);
    }, true /* capture, fires before navigation */);
  }

  // Decide whether an anchor needs the variant param appended, and append it
  // idempotently. Skips externals (http/mailto/js), hashes, the read-only
  // banner's own controls, and anchors that already carry ?variant=.
  function shouldAnnotateHrefForBrowse(href, a) {
    if (!href) return false;
    if (/^(https?:|mailto:|javascript:)/.test(href)) return false;
    if (href.charAt(0) === '#') return false;
    if (a && a.classList && (a.classList.contains('vrb-back') || a.classList.contains('vrb-diff'))) return false;
    if (!/\.html(\?|#|$)/.test(href)) return false;
    if (/[?&]variant=/.test(href)) return false;
    return true;
  }
  function rewriteAnchorHrefForBrowse(a, variantId) {
    var href = a.getAttribute('href') || '';
    if (!shouldAnnotateHrefForBrowse(href, a)) return;
    var sep = href.indexOf('?') === -1 ? '?' : '&';
    a.setAttribute('href', href + sep + 'variant=' + encodeURIComponent(variantId));
  }
  function rewriteAnchorsForBrowse(root, variantId) {
    var anchors = (root || document).querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) rewriteAnchorHrefForBrowse(anchors[i], variantId);
  }
  function stripVariantFromUrl() {
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete('variant');
      return u.pathname + (u.search ? u.search : '') + u.hash;
    } catch (e) { return window.location.pathname; }
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
    isBrowseMode: function () { return !!BROWSE_VARIANT_ID; },
    getBrowseVariantId: function () { return BROWSE_VARIANT_ID; },
    getBrowseVariantMeta: function () { return browseVariantMeta; },
    ready: readyPromise,
  };
})();
