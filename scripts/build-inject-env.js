#!/usr/bin/env node
/* =============================================================
   Build step: produce a `dist/` directory with Supabase config
   injected into HTML files. Source `mocks/` is never mutated.

   Outputs:
     dist/mocks/*.html  — placeholders __SUPABASE_URL__ and
                          __SUPABASE_ANON_KEY__ replaced with
                          values from process.env (or
                          .env.development.local for `vercel dev`).
     dist/mocks/*       — all non-HTML assets copied through
                          unchanged (.js, .css, .json, etc.).
     dist/index.html    — small redirect into /mocks/.

   `vercel.json` sets `outputDirectory: "dist"` so the Vercel CDN
   serves from here. Service-role keys are NEVER read or emitted
   by this script — only the anon (publishable) key is injected.

   Safe to re-run: the dist/ directory is wiped and rebuilt each time.
   ============================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_MOCKS = path.join(ROOT, 'mocks');
const DIST = path.join(ROOT, 'dist');
const DIST_MOCKS = path.join(DIST, 'mocks');

function loadDotenvFallback() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) return;
  const dotenvPath = path.join(ROOT, '.env.development.local');
  if (!fs.existsSync(dotenvPath)) return;
  const txt = fs.readFileSync(dotenvPath, 'utf8');
  txt.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) return;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  });
}

function rimrafSync(p) {
  if (!fs.existsSync(p)) return;
  // Node 14+ has rmSync with recursive; fall back to rmdirSync otherwise.
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(p, { recursive: true, force: true });
  } else {
    fs.rmdirSync(p, { recursive: true });
  }
}

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function substitute(txt, subs) {
  for (const [needle, value] of Object.entries(subs)) {
    if (txt.indexOf(needle) === -1) continue;
    txt = txt.split(needle).join(value);
  }
  return txt;
}

function copyMocks(subs) {
  const entries = fs.readdirSync(SRC_MOCKS, { withFileTypes: true });
  let htmlCount = 0;
  let assetCount = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const src = path.join(SRC_MOCKS, ent.name);
    const dst = path.join(DIST_MOCKS, ent.name);
    if (ent.name.endsWith('.html')) {
      const txt = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(dst, substitute(txt, subs));
      htmlCount++;
    } else {
      fs.copyFileSync(src, dst);
      assetCount++;
    }
  }
  return { htmlCount, assetCount };
}

function writeRootRedirect() {
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<title>doclayer</title>' +
    '<meta http-equiv="refresh" content="0; url=/mocks/">' +
    '<link rel="canonical" href="/mocks/">' +
    '<p>redirecting to <a href="/mocks/">/mocks/</a>…</p>';
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
}

function main() {
  loadDotenvFallback();
  const url = process.env.SUPABASE_URL || '';
  const anon = process.env.SUPABASE_ANON_KEY || '';
  if (!url || !anon) {
    console.warn('[build-inject-env] SUPABASE_URL / SUPABASE_ANON_KEY not set — placeholders will remain. Mocks will run in local-fallback mode.');
  }
  // Defense in depth: refuse to proceed if a service role key has been pulled
  // into env. We only ever want the public anon key in the bundle.
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && anon && process.env.SUPABASE_SERVICE_ROLE_KEY === anon) {
    throw new Error('[build-inject-env] refusing to build: SUPABASE_ANON_KEY appears to equal SUPABASE_SERVICE_ROLE_KEY.');
  }

  rimrafSync(DIST);
  ensureDirSync(DIST_MOCKS);

  const subs = {
    '__SUPABASE_URL__': url,
    '__SUPABASE_ANON_KEY__': anon,
  };
  const { htmlCount, assetCount } = copyMocks(subs);
  writeRootRedirect();
  console.log('[build-inject-env] dist/ built. HTML:', htmlCount, '· assets:', assetCount);
}

main();
