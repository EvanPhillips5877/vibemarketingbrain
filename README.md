# MarketingBrain

Private internal marketing operating system. Give it a mission ("50 new
TryoutBrain coaches under $20 each, $1,000 to experiment"); it plans,
creates, proposes, and, once approved, ships to Meta and Google, then learns
from what came back.

- Design and build plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Working rules for the codebase: [CLAUDE.md](CLAUDE.md)

## Status

Phase 1 of the build plan: skeleton, config, Google sign-in with an
allowlist, Postgres sessions, job scheduler wiring, CI, and the empty
command-center shell.

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm run migrate
pnpm run dev
```

Open http://localhost:5173 and sign in with an address from `ALLOWED_EMAILS`.
