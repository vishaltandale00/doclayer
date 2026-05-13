# Manual test steps

Tests that are not automated. Run these before each release.

## Cross-browser smoke (Phase 7 deliverable §7)

Per the plan: render two variants in Chrome + Safari, confirm both render. Playwright
is intentionally NOT installed in this project (too heavy for the v1 loop). When/if
Playwright lands, automate this from `tests/cross-browser.spec.ts`.

### Steps

1. Start the local dev server / serve the `mocks/` directory:
   ```
   cd doclayer
   npx http-server mocks -p 8080
   ```
2. Seed two variants via Supabase or via the app UI (each with at least one
   applied patch on a different scenario).
3. Open Chrome: `http://localhost:8080/variants.html`
   - Verify the gallery lists both variants.
   - Click each variant; confirm the corresponding patches render on the
     selected scenario pages.
4. Open Safari (latest stable): repeat step 3.
5. Pass criteria:
   - Both variants render without console errors in Chrome and Safari.
   - CSS custom-property patches visibly take effect (e.g. `--typing-speed-ms`
     changes the typewriter cadence).
   - Microcopy overrides appear in the DOM where `data-patchable` is set.

### Why manual

- Playwright is ~250MB installed and pulls a separate Chromium. The v1 loop
  prioritized validation pipeline + auth + supersession over headless cross-browser
  CI. The risk surface here (visual rendering differences) is low — the harness
  is pure HTML/CSS/JS without browser-specific APIs.
- If a future Phase adds CSS that uses browser-specific features (Houdini paint
  worklets, container queries with `style()` selectors, etc.), automate this
  with Playwright at that point.

## Magic-link auth flow (Phase 1 deliverable)

Not yet automated. Open the deployed app, request a magic link, click through,
confirm session is created. Repeat once for a second account to verify RLS.
