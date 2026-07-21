# Audio Movie Studio Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the product as Audio Movie Studio and ship an elegant closed-beta Three.js landing page for authors, filmmakers, and developers without breaking existing DRAMATIS integrations.

**Architecture:** Keep the zero-build, zero-runtime-dependency Node server. Serve a new public site from `studio/landing/` at `/`, retain the production console from `studio/app/` at `/studio`, and share a hand-authored SVG logo system between them. Load a pinned Three.js browser module dynamically so the semantic page and static SVG fallback work without WebGL or network access.

**Tech Stack:** Node.js 20+, `node:http`, vanilla HTML/CSS/ES modules, SVG, Three.js browser ESM, `node:test`, existing smoke runner.

## Global Constraints

- Display name is exactly **Audio Movie Studio**; compact identifier is `audiomoviestudio`.
- Launch state is **Closed beta** and all three audiences—authors, filmmakers, developers—must be addressed.
- Preserve `dramatis` as a CLI alias and preserve `DRAMATIS_*` environment variables, API headers, cache identities, stored paths, and engine tags.
- No purple anywhere. Use carbon `#0D1116`, stage `#080C10`, graphite `#141A21`, raised graphite `#1C242E`, cyan `#3EC5CF`, silver `#DCE4E8`, steel `#8CA1B5`, and restrained amber `#D99A3D`.
- Respect `prefers-reduced-motion`; the landing page remains complete without JavaScript, Three.js, WebGL, or CDN access.
- Do not introduce runtime npm dependencies or a build step.
- Do not invent testimonials, customer logos, metrics, or product availability.

---

### Task 1: Route Separation and Identity Contract

**Files:**
- Create: `test/brand-routes.test.mjs`
- Modify: `studio/server.mjs`
- Move: `studio/app/index.html` to `studio/app/studio.html`

**Interfaces:**
- Produces: `GET /` landing HTML, `GET /studio` console HTML, `/landing/*` static assets, existing root-level console assets.
- Preserves: every `/api/*`, `/media/*`, `/actors/*`, `/bookart/*`, and `/corpus/*` route.

- [ ] **Step 1: Write a failing route test**

Create a `node:test` case that spawns `studio/server.mjs` on an unused port, asserts `/` contains `Audio Movie Studio` and `CLOSED BETA`, asserts `/studio` contains `id="main"`, and asserts `/api/books` still returns JSON.

- [ ] **Step 2: Verify the route test fails**

Run: `node --test test/brand-routes.test.mjs`

Expected: FAIL because `/` still serves the old console and `/studio` is 404.

- [ ] **Step 3: Implement separate static roots**

In `studio/server.mjs`, define `LANDING = path.join(root, 'studio', 'landing')`. Replace `serveStatic` with a traversal-safe helper that accepts an explicit root. Route `/` to `LANDING/index.html`, `/landing/<file>` to `LANDING/<file>`, `/studio` to `APP/studio.html`, and all existing console asset paths to `APP`. Add image and SVG content types.

- [ ] **Step 4: Verify the identity route contract**

Run: `node --test test/brand-routes.test.mjs`

Expected: PASS for landing, console, and API assertions.

- [ ] **Step 5: Commit**

Run: `git add studio/server.mjs studio/app/studio.html test/brand-routes.test.mjs && git commit -m "Add landing and studio route separation"`

### Task 2: Logo System and Studio Rebrand

**Files:**
- Create: `studio/shared/logo-mark.svg`
- Create: `studio/shared/logo-horizontal.svg`
- Create: `studio/shared/logo-stacked.svg`
- Modify: `studio/app/studio.html`
- Modify: `studio/app/studio.css`
- Modify: `studio/app/app.js`
- Modify: `studio/server.mjs`
- Modify: `studio/smoke.mjs`

**Interfaces:**
- Produces: reusable static logo variants at `/shared/logo-*.svg` and visible Audio Movie Studio console identity.
- Consumes: `/studio` routing from Task 1.

- [ ] **Step 1: Extend the brand route test**

Assert each `/shared/logo-*.svg` request returns `200`, `image/svg+xml`, and SVG text containing the brand title; assert `/studio` contains `Audio Movie Studio` and does not contain the old logo image path.

- [ ] **Step 2: Verify the asset assertions fail**

Run: `node --test test/brand-routes.test.mjs`

Expected: FAIL with 404 responses for `/shared/logo-*.svg`.

- [ ] **Step 3: Draw the Soundstage Aperture SVG family**

Create a simple aperture ring, three waveform blades, negative-space play direction, and cyan recording light using only SVG paths, masks, and gradients. Horizontal and stacked lockups must embed the words `AUDIO MOVIE` and `STUDIO`; the mark must remain readable in a 32×32 viewport.

- [ ] **Step 4: Rebrand the production console**

Update the document title, sidebar logo, alt text, visible DRAMATIS copy, CSS comments, and server startup log. Retain the existing graphite/cyan console layout. Serve `studio/shared/` through the static router. Update the smoke check to request `/studio` and assert `Audio Movie Studio`.

- [ ] **Step 5: Run focused verification**

Run: `node --test test/brand-routes.test.mjs`

Run: `node studio/smoke.mjs`

Expected: all checks PASS.

- [ ] **Step 6: Commit**

Run: `git add studio/shared studio/app studio/server.mjs studio/smoke.mjs test/brand-routes.test.mjs && git commit -m "Rebrand the production studio"`

### Task 3: Cinematic Closed-Beta Landing Page

**Files:**
- Create: `studio/landing/index.html`
- Create: `studio/landing/landing.css`
- Create: `studio/landing/landing.js`
- Create: `studio/landing/hero-scene.js`
- Modify: `test/brand-routes.test.mjs`

**Interfaces:**
- `hero-scene.js` exports `mountHeroScene(canvas: HTMLCanvasElement): Promise<{ destroy(): void } | null>`.
- `landing.js` owns navigation, reduced-motion detection, scroll reveals, stem controls, and dynamically imports `hero-scene.js` only when appropriate.
- The static SVG hero remains visible unless `mountHeroScene` completes successfully.

- [ ] **Step 1: Add semantic content and fallback tests**

Assert the landing HTML includes the exact headline, all three audience labels, the six pipeline stages, four audio stems, `Request beta access`, `/studio`, a static SVG logo, a `<canvas>`, and a `<noscript>`-compatible content structure. Assert the CSS contains a `prefers-reduced-motion` block.

- [ ] **Step 2: Verify landing content tests fail**

Run: `node --test test/brand-routes.test.mjs`

Expected: FAIL because the detailed landing assets do not exist.

- [ ] **Step 3: Build the semantic page and premium layout**

Implement a sticky glass header, full-height hero, three audience cards, six-stage pipeline, layered stem console, persistent-character section, local-first proof points, and final closed-beta CTA. Use fluid type via `clamp()`, restrained amber only for beta access, and responsive breakpoints at 960px and 680px.

- [ ] **Step 4: Build the progressive interaction layer**

Implement IntersectionObserver reveals, mobile navigation, active stem selection, a lightweight pointer glow, and cleanup. Use native controls and real links; `Request beta access` should use a non-fabricated `mailto:` link until a beta backend exists.

- [ ] **Step 5: Build the Three.js Soundstage Aperture**

Dynamically import pinned Three.js from `https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js`. Construct the aperture from extruded rings, metallic waveform blades, a cyan emissive signal element, sparse dust points, and restrained pointer/scroll parallax. Cap renderer pixel ratio at 1.75, pause when the tab is hidden, resize with ResizeObserver, and return a disposer that releases geometry, materials, renderer, and listeners.

- [ ] **Step 6: Verify semantic and runtime routes**

Run: `node --test test/brand-routes.test.mjs`

Expected: all brand and fallback assertions PASS.

- [ ] **Step 7: Commit**

Run: `git add studio/landing test/brand-routes.test.mjs && git commit -m "Build cinematic closed beta landing page"`

### Task 4: Package, Installer, and Documentation Rebrand

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/HOW-DRAMATIS-WORKS.md`
- Modify: `docs/COST-REPORT.md`
- Modify: `docs/SYSTEM-REQUIREMENTS.md`
- Modify: `installer/dramatis-setup.iss`
- Modify: `installer/bootstrap.ps1`
- Modify: `installer/launch.cmd`
- Modify: `start-studio.cmd`
- Modify: user-visible comments/log labels in `bin/dramatis.mjs`, `hub/server.mjs`, and `hub/agents.md`
- Create: `test/brand-compat.test.mjs`

**Interfaces:**
- Produces: preferred `audiomoviestudio` CLI alias plus supported `dramatis` alias.
- Preserves: repository URLs unless the actual remote changes; all technical `DRAMATIS_*` and `X-Dramatis-*` compatibility identifiers.

- [ ] **Step 1: Write compatibility assertions**

Load `package.json` and assert `name === "audiomoviestudio"`, both bin aliases point to `bin/dramatis.mjs`, the description names Audio Movie Studio, and the source still contains known compatibility identifiers such as `DRAMATIS_PYTHON`.

- [ ] **Step 2: Verify compatibility assertions fail**

Run: `node --test test/brand-compat.test.mjs`

Expected: FAIL because package identity is still `dramatis`.

- [ ] **Step 3: Update package and installer identity**

Change display names, shortcut names, output installer filename, default installation folder, launcher window titles, and user-visible installer prose to Audio Movie Studio. Keep the stable Inno Setup AppId so existing installations upgrade instead of duplicating.

- [ ] **Step 4: Update public documentation and labels**

Replace product prose with Audio Movie Studio while retaining old CLI examples where they explain compatibility. Add a short compatibility note naming the legacy DRAMATIS identifiers. Do not mass-replace cache keys, environment variable names, headers, source paths, or historical research notes.

- [ ] **Step 5: Run compatibility verification**

Run: `node --test test/brand-compat.test.mjs`

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

Run: `git add package.json README.md docs installer start-studio.cmd bin/dramatis.mjs hub test/brand-compat.test.mjs && git commit -m "Complete Audio Movie Studio product rebrand"`

### Task 5: Full Visual and Functional Release Audit

**Files:**
- Modify as defects require: `studio/landing/*`, `studio/app/*`, `studio/server.mjs`, tests.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: screenshot evidence and a passing completion audit.

- [ ] **Step 1: Run automated release gates**

Run: `npm test`

Run: `node studio/smoke.mjs`

Run: `git diff --check`

Expected: all tests PASS and no whitespace errors.

- [ ] **Step 2: Inspect brand residue deliberately**

Run: `rg -n "DRAMATIS|Dramatis" studio README.md docs package.json installer start-studio.cmd bin hub`

Classify every remaining match as an intentional compatibility identifier, historical note, filename/path, or defect. Fix every user-visible defect; retain and document compatibility matches.

- [ ] **Step 3: Capture desktop and mobile renders**

Start the server and capture `/` at 1440×1000 and 390×844, plus `/studio` at 1440×1000. Verify hero hierarchy, Three.js/fallback composition, navigation, cards, pipeline, stem panel, CTA, typography, contrast, overflow, and logo clarity.

- [ ] **Step 4: Test degraded experience**

Disable JavaScript or block the Three.js CDN and verify the full landing copy, navigation, CTAs, and static Soundstage Aperture remain visible. Emulate reduced motion and confirm transitions and WebGL animation are disabled.

- [ ] **Step 5: Fix visual defects and rerun gates**

Apply focused fixes, then repeat `npm test`, `node studio/smoke.mjs`, and all three screenshots until no requirement is contradicted by rendered evidence.

- [ ] **Step 6: Commit final polish if required**

Run: `git add studio test && git commit -m "Polish Audio Movie Studio release"` only when Task 5 produced changes.

