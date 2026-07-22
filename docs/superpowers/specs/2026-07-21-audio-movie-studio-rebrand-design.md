# Audio Movie Studio Rebrand Design

## Purpose

Rename DRAMATIS to **Audio Movie Studio** and present it as a closed-beta creative-production SaaS for authors, filmmakers, and developers. The new identity must preserve the product's cinematic-audio heritage while making its technical platform credible and immediately understandable.

## Brand Foundation

- **Display name:** Audio Movie Studio
- **Compact identifier:** `audiomoviestudio`
- **Positioning:** Turn written stories into full-cast cinematic audio and reusable production assets.
- **Launch state:** Closed beta
- **Primary audiences:** authors, filmmakers and narrative creators, and developers building with the audio hub
- **Personality:** cinematic first; modern, precise, and technically credible underneath
- **Tone:** confident, evocative, restrained, and professional; never playful, noisy, or breathlessly "AI"

### Core message

**Turn a manuscript into a movie for your ears.**

**Cast every character. Direct every line. Score every scene.**

Audio Movie Studio transforms manuscripts into full-cast cinematic productions with character voices, ambience, sound effects, score, and production-ready masters. Its audio platform also lets developers reuse persistent characters and generated assets in other experiences.

## Visual Identity

### Logo: Sonic Frame

The primary symbol combines three ideas in one compact geometric mark:

1. A cut-corner cinematic frame represents filmmaking and direction.
2. Five vertical waveform bars represent voice, sound design, and score.
3. Cyan corner cuts suggest a production timeline moving through the frame.

A small amber recording light provides a live-production cue. The icon must remain legible at favicon size and avoid detailed illustration, microphones, masks, film strips, literal reels, and generic play-button symbolism.

The wordmark uses **AUDIO MOVIE** as the dominant line and **STUDIO** below in widely tracked technical lettering. The preferred lockup is horizontal for the landing-page header and stacked for the Studio sidebar.

### Color system

The product's existing no-purple law remains absolute.

- Carbon: `#0D1116`
- Deep stage: `#080C10`
- Panel graphite: `#141A21`
- Raised graphite: `#1C242E`
- Signal cyan: `#3EC5CF`
- Cyan shadow: `#19606A`
- Warm silver: `#DCE4E8`
- Muted steel: `#8CA1B5`
- Controlled amber: `#D99A3D`, reserved for beta/access moments

The visual impression should come from depth, light, material, typography, and motion rather than a large number of colors.

### Typography

- Display: a condensed cinematic sans-serif, loaded from a dependable web-font source with a local fallback
- Interface/body: Inter with `system-ui` fallback
- Technical labels: compact uppercase tracking, used sparingly

## Landing Page

The landing page is a new public-facing route, separate from the production console. It should feel like entering a dark professional soundstage rather than visiting a generic AI SaaS template.

### Hero

The hero fills the first viewport. A Three.js scene renders the Sonic Frame as metallic, layered geometry suspended between manuscript pages and four production stems. Cyan energy travels through its waveform bars. Pointer movement produces restrained parallax, while scroll gently rotates the composition.

The content layer includes:

- `CLOSED BETA` status badge
- Audio Movie Studio wordmark
- Headline: **Turn a manuscript into a movie for your ears.**
- A concise explanation of the manuscript-to-cinematic-audio system
- Primary action: **Request beta access**
- Secondary action: **Explore the studio**

Motion must respect `prefers-reduced-motion`; on constrained devices or WebGL failure, the logo remains as a polished static SVG composition.

### Narrative flow

1. **One story, three ways in** — three audience cards for Authors, Filmmakers, and Developers.
2. **From page to production** — a horizontal production pipeline: Compile, Cast, Perform, Sound Design, Mix, Master.
3. **Direct every layer** — an elegant interactive stem visualization for dialogue, ambience, SFX, and score.
4. **Characters that stay cast** — explain permanent, reusable character voices and the audio hub.
5. **Local-first by design** — communicate privacy, free local defaults, caching, and deliberate premium routing.
6. **Closed-beta invitation** — a high-impact final panel with a concise access form or mail link, depending on available backend support.

### Interaction design

- Slow, physically plausible motion; no particle storm or constant camera flight
- Section reveals based on opacity, blur, and shallow translation
- Magnetic or luminous hover response on primary actions
- Fine waveform lines and timecode details as atmospheric texture
- No fake customer logos, invented testimonials, fabricated metrics, or unsupported availability claims

### Three.js implementation constraints

The existing Studio deliberately has no build step and no runtime npm dependencies. The landing page must respect that architecture. Three.js should be loaded as a browser ESM module from a pinned CDN version, with the experience implemented in focused static modules. The page must remain usable if the CDN or WebGL is unavailable.

## Product Rebrand Scope

### User-visible identity

Replace DRAMATIS branding with Audio Movie Studio in:

- Studio document title, logo, favicon, alt text, and visible explanatory copy
- landing page and metadata
- server startup messages
- installer display name, shortcuts, and product labels
- README and user-facing documentation
- smoke tests that assert visible product identity

### Compatibility policy

The first rebrand release must not break existing users or integrations.

- Keep the `dramatis` CLI executable as a supported compatibility alias.
- Add `audiomoviestudio` as the preferred CLI executable.
- Preserve existing `DRAMATIS_*` environment variables and document them as compatibility names until a dedicated migration is designed.
- Preserve existing API header names and internal cache identities; changing them would invalidate integrations or expensive cached work.
- Do not rename repository folders, source filenames, persisted book structures, or engine cache tags as part of the visual rebrand.

## Acceptance Criteria

1. The public landing page clearly names Audio Movie Studio, states closed-beta status, and addresses all three audiences.
2. The hero uses a performant Three.js Sonic Frame experience with reduced-motion and no-WebGL fallbacks.
3. The logo works as horizontal, stacked, icon, and favicon variants.
4. The production Studio is visibly rebranded without losing its graphite-and-cyan production-console character.
5. Existing `dramatis` CLI usage continues to work, while `audiomoviestudio` becomes available as the preferred command.
6. Compatibility-sensitive environment variables, headers, cache keys, and persisted paths remain unchanged.
7. No purple appears anywhere in the new UI.
8. Existing automated tests pass, and new landing-page/identity checks cover the primary routes and fallbacks.
9. Desktop and mobile screenshots show no overflow, illegible text, missing assets, or layout collisions.
