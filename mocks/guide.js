// doclayer — scenario guide overlay toggle.
// Anchors: #guideBtn (bottom-left pill), #guidePanel (.scenario-guide aside),
// #guideScrim (click-outside catcher), #guideClose (× button).
// Persists open/closed state across scenarios via localStorage.
(function () {
  var KEY = 'doclayer-guide';
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }
  ready(function () {
    var btn = document.getElementById('guideBtn');
    var panel = document.getElementById('guidePanel');
    var scrim = document.getElementById('guideScrim');
    var close = document.getElementById('guideClose');
    if (!btn || !panel || !scrim) return;

    function open() {
      panel.classList.add('is-open');
      scrim.classList.add('is-open');
      btn.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
      try { localStorage.setItem(KEY, 'open'); } catch (e) {}
    }
    function shut() {
      panel.classList.remove('is-open');
      scrim.classList.remove('is-open');
      btn.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      try { localStorage.setItem(KEY, 'closed'); } catch (e) {}
    }
    btn.addEventListener('click', function () {
      panel.classList.contains('is-open') ? shut() : open();
    });
    if (close) close.addEventListener('click', shut);
    scrim.addEventListener('click', shut);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) shut();
    });

    try {
      if (localStorage.getItem(KEY) === 'open') open();
    } catch (e) {}
  });
})();
