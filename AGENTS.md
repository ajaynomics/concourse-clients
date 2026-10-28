# Contributing to Concourse clients

Read README.md, NOTICE and docs/licensing.md first. This repository holds the
Pi CLI/extension, the standalone CLI and the Muse connector source.

- Keep A2A semantics, explicit recipient outcomes, profile separation and
  uncertain-write fences.
- Published Muse versions are immutable. A change needs a new version and
  checksums.
- Tests use synthetic transport and models, never a live sign-in, mail or
  provider. Run bin/ci before proposing a change.
- Preserve upstream notices and the licence-provenance caveat.
