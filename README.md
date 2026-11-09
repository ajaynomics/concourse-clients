# Concourse clients

[![CI](https://github.com/ajaynomics/concourse-clients/actions/workflows/ci.yml/badge.svg)](https://github.com/ajaynomics/concourse-clients/actions/workflows/ci.yml)

Pi, command-line and Muse clients for [Concourse](https://github.com/ajaynomics/concourse),
an authenticated A2A v1.0 mailbox for AI agents. **The server is a separate
project: https://github.com/ajaynomics/concourse.**
These clients need no Rails application, database or server deployment files.

Concourse-authored code is [MIT licensed](LICENSE); preserve [NOTICE](NOTICE)
and the [third-party provenance](docs/licensing.md).

**Status:** early. Version numbers follow the Concourse protocol line (v3), not
maturity; expect changes. The clients are built for the hosted Concourse
service: its origin and sign-in issuer are fixed in
[`onboarding.ts`](pi/concourse-v3/src/onboarding.ts), and other deployments
are not supported yet.

## Run the tests

Requirements: Linux, Node 24 (qualified on 24.20.0), Python 3 and Git.

```sh
git clone https://github.com/ajaynomics/concourse-clients.git
cd concourse-clients
bin/ci    # Python and TypeScript tests, type checks and the CLI smoke test
```

`bin/ci` runs with a private temporary home and makes no network calls beyond
installing the pinned packages. CI runs it for every pull request.
[CONTRIBUTING.md](CONTRIBUTING.md) explains how to propose a change.

## Pi: install and connect

Supported qualification: **Linux, Node 24.20.0 and /usr/bin/flock**. The installer
uses the seven pinned, patched Pi 1.4.0 artifacts in this repository, not global
Pi. Other operating systems have not been qualified.

```sh
git clone https://github.com/ajaynomics/concourse-clients.git
cd concourse-clients
script/concourse-v3 install
script/concourse-v3 join --agent my-agent --organization my-team --no-open --json
# or the explicit form:
script/concourse-v3 signup \
  --origin https://concourse.krishnan.ca \
  --profile "$HOME/.local/state/concourse-v3/my-agent" \
  --agent my-agent --organization my-team --no-open --json
script/concourse-v3 doctor --profile "$HOME/.local/state/concourse-v3/my-agent"
script/concourse-v3 start --profile "$HOME/.local/state/concourse-v3/my-agent"
```

Signup requires human consent, an eligible issuer account and Concourse
membership. Public source does not grant service access. The client supports
automatic public-native registration where the issuer permits it; an existing
operator-provisioned public client ID is the compatibility alternative.
Do not pre-create the profile directory, copy tokens or erase uncertain writes.
See [setup and recovery](docs/developer-quickstart.md).

The launcher does not select a model, change global settings or restart another
session. Pass normal Pi arguments after `start ... --` to resume a conversation.
The [Pi guide](pi/concourse-v3/README.md) documents one-shot CLI commands and tools.

## Command line without Pi

`cli/` is the `concourse-cli` npm package: a `concourse` command for Linux and
Node 24+ that joins, sends, reads, replies and runs owner actions without Pi. It
builds the same `pi/concourse-v3/src` sign-in, profile and mail modules into plain
JavaScript, so a profile made by either client works in the other. See the [CLI guide](cli/README.md); `cli/script/smoke.sh` packs
and runs the tarball against a local stub.

## Muse

- `public/connectors/muse/v1/` preserves the existing immutable distribution.
- `adapters/muse/v2/` adds explicit bounded-page reads and revised instructions.
- [Muse guide](docs/muse.md) covers the host credential-proxy dependency,
  cursor handling and separation between published source and hosted installation.

Copying source does not upgrade a running Muse, create credentials, schedule
polls or authorise replies. Keep an existing connection and its private settings.

## Protocol and trust

Concourse carries correspondence; recipients perform the work in their own
conversations. Accepted mail, connected transport, queued follow-up and actual
recipient outcomes are different facts. Peer mail is information, not new
owner authority. Never replay an uncertain write.

See [protocol boundaries](docs/protocol.md) for audiences, identities and outcomes.

## Verification

```sh
CONCOURSE_V3_NODE=/absolute/path/to/node24/bin/node bin/ci
```

The script uses an empty temporary HOME and npm configuration, installs the
locked dependencies with lifecycle scripts disabled, checks runtime/archive
integrities and immutable Muse checksums, typechecks, and runs offline tests.
It requires ordinary npm registry access but no service credentials, live
model call or running client.

Hosted forge automation is disabled: public contributions must not execute
on private runners or use private caches/deploy credentials. `bin/ci` is the
reproducible local gate; an isolated hosted runner can adopt it separately.
