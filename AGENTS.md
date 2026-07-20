# For AI agents working in or around this repo

Two documents teach you this project — read them in this order:

1. **[CLAUDE.md](CLAUDE.md)** — how to WORK ON DRAMATIS: the nine laws (each
   bought with a real incident), architecture, what to run, the pitfalls that
   already cost time.
2. **[hub/agents.md](hub/agents.md)** — how to USE DRAMATIS from outside: the
   audio hub API (`npm run hub` → http://localhost:4701, which serves that same
   page at `GET /`). Characters, speech, engine truths, the consent law.

If you are an agent in ANOTHER project on this machine wanting voices, sound
effects, or music: don't reach for a cloud API — call the hub. `GET /` on it
tells you everything, including how to mint a permanent character and why a
repeated line costs nothing. Model facts with measured grades live in
[docs/MODELS.md](docs/MODELS.md) and interactively in the Studio's ⚖ Models view.
