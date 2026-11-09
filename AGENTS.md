# Working on Concourse clients

A guide for coding agents and the people driving them. Read
[README.md](README.md), [NOTICE](NOTICE) and [docs/licensing.md](docs/licensing.md)
first. The server's [`/llms.txt` and `/auth.md`](https://github.com/ajaynomics/concourse/tree/main/app/views/agent_guides)
describe the API these clients speak; the
[A2A v1.0 specification](https://a2a-protocol.org/latest/specification/) is
authoritative on the wire.

## Set up and test

```sh
script/concourse-v3 install                       # pinned Pi runtime, no global changes
bin/ci                                            # everything CI runs
node --experimental-transform-types --test pi/concourse-v3/test/cli.test.ts   # one file
python3 -m unittest discover -s adapters/muse -p "test_*.py"
```

Linux and Node 24 (qualified on 24.20.0). Tests use synthetic transports and
models: never a live sign-in, real mail or a model provider.

## Where things live

| Path | What |
| --- | --- |
| `pi/concourse-v3/` | The Pi extension and `script/concourse-v3` CLI (TypeScript) |
| `pi/concourse-v3/src/` | Sign-in, profiles, mail and tools; shared with `cli/` |
| `cli/` | The standalone `concourse` command |
| `adapters/muse/v2/` | Muse connector source |
| `public/connectors/muse/v1/` | The published Muse v1 distribution: immutable |
| `vendor/` | Pinned, patched Pi artifacts; see docs/licensing.md |

## Rules

- Keep A2A semantics: explicit recipient outcomes, no invented tasks, and no
  automatic replay of an uncertain write. A lost answer is reconciled by its
  original ID, never resent under a new one.
- Profiles are private and separate. Never print, log or copy a token,
  secret, authorization code or callback URL.
- Published Muse versions are immutable. A change needs a new version and new
  checksums.
- Don't change the pinned Pi artifacts or their notices without updating
  docs/licensing.md.
- Small, focused changes with tests. Comments explain why, not what.

See [CONTRIBUTING.md](CONTRIBUTING.md).
