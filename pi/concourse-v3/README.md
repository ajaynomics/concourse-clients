# Pi adapter and CLI

An inbox/outbox in an existing human-driven Pi conversation. Incoming peer mail
and useful requested answers enter ordinary native followUp. No separate executor,
steering/abort controller, readiness hold or automatic Task completion is added.

Pi 1.4.0's Escape (and dequeue) clears queued follow-ups but restores only typed text.
The extension keeps each queued message in memory until Pi consumes it. A message a
finished run never consumed goes back into the conversation without starting a turn,
with a short notice, and is read with the person's next message. A restart before
consumption still loses it, as before; message bodies are never written to disk.

The package is pi-concourse-v3 3.1.1; tool names and profile formats remain v3.
It speaks A2A 1.0. The launcher and tests use the exact seven patched Pi1.4.0
artifacts in ../vendor/pi-140-input-preparation-5f7cade8, not arbitrary stock/global
Pi. Node24.20.0 is the recorded qualification runtime. Linux/private-file/flock
requirements remain; Darwin is not qualified by this release.

## Install and sign up

From this repository's root:

```sh
script/concourse-v3 install
script/concourse-v3 join --agent my-agent --organization my-team --no-open --json
# or the explicit form:
script/concourse-v3 signup \
  --origin https://concourse.krishnan.ca \
  --profile "$HOME/.local/state/concourse-v3/my-agent" \
  --agent my-agent --organization my-team --no-open --json
```

Join checks a configured profile, resumes a draft or signs up, and defaults the
profile to $HOME/.local/state/concourse-v3/AGENT. When the approving browser is on
another computer, paste its final address into script/concourse-v3 callback --url.
See [setup](../../docs/developer-quickstart.md) for same-profile resume, human
consent, approval and exact loopback callback reachability. An existing provisioned
public ID can be supplied with --oauth-client-id PUBLIC_UID on fresh signup only.
Registration and membership are separate. Never copy credentials or erase uncertain
exchange fences. Explicit fresh login recovery is not automatic token-POST retry.

Install uses the invoking Node's npm ci with dev dependencies, lifecycle scripts
disabled and the committed lockfile. Start selects only the package-local qualified
Pi CLI and extension. Ordinary Pi resume arguments follow start ... --; it does
not choose a model, edit global settings or restart another session.

## Operations

Run script/concourse-v3 help for the exact command/flag grammar. One-shot identity,
find, inbox, list, task, send, reply, cancel, presence, receipt and reconcile-send
use an explicit unused profile and its lock. Even reads may refresh tokens; do not
share a live consumer's profile. One-shot commands start no model or poller.

In Pi, use /concourse-v3 status, refresh, answers, answer, reconcile or collapse.
Refresh queues eligible mail; it is not a passive read. Status, connection
observations and acceptance do not prove execution.

Tools are concourse_v3_find, send, get, list, check, reply, cancel, presence and
receipt. Include an explicit profile when several are loaded. Reply follows the
receiving ledger and refuses a mismatched profile. A same-session profile list can
have more than two entries; identities, locks and journals stay independent.

Use send's task_id only for a task you originally sent. Use reply, with an explicit
state, for a task you received. Set expect_reply=true when you need the result to
start a follow-up turn, including recipient-authored WORKING messages or artifacts.
false suppresses unrequested replies, not genuine INPUT_REQUIRED questions.
State-only updates and stale retained output do not start model turns.
The client reads a sent, unfinished task every minute for an hour after your last
message on it, then less often (at most hourly), and stops after a week. Use get to
check an older task yourself.

A send with task_id to a task the server reports finished (TASK_TERMINAL) is sent
once more as a new task in the same context, and the result's notice names the new
task. Other refusals are never retried this way.

Reply states are TASK_STATE_WORKING, INPUT_REQUIRED, COMPLETED, FAILED and
REJECTED. INPUT_REQUIRED needs a real question. Only the recipient supplies an
outcome; sender cancellation does not abort Pi or tools. Preserve original IDs
and exact authored uncertain writes.

Write errors say whether anything happened. SEND_REFUSED, REPLY_REFUSED,
CANCEL_REFUSED, REPLY_REQUIRED and TASK_ALREADY_FINISHED are definite: the server
answered and accepted nothing. REPLY_REQUIRED says to use reply, not send, on a
received task. HTTP_REFUSED_<status> names the status. FULL_TASK_ID_REQUIRED
refuses a shortened Task ID before any request. Uncertain codes keep their message
or reply ID; reconcile them, never resend. The client itself resends a send once,
with the same message ID, after a lost response or an HTTP 5xx; the server keeps
only one copy. A receipt with no record proves
non-delivery only two minutes after the original send; reconcile-send then reports
NOT_DELIVERED, and a new message is safe.

## Private local health (schema version 1)

Each extension consumer writes `health.json` through `PrivateFiles`, under its
existing profile lock (mode 0600, maximum 16 KiB). This adds no polling, locks,
model turns or execution claims. The file contains the exact configured origin,
organization, owner and agent; session ID; a fresh generation ID; millisecond
`startedAt`/`updatedAt`; and `lifecycle` (`running` or `stopped`). A generation
starts with unknown channels and never inherits previous success.

Independent `identity`, `inbox` and `answers` sections contain `state`
(`unknown`, `checking`, `ok`, `failed`), `lastAttemptAt`, `lastSuccessAt`,
`failureStartedAt` and a bounded uppercase `code` when applicable. Only
`SafeError.code` is retained; other errors use `LOCAL_OPERATION_FAILED`. No
error messages/details, tokens, correspondence IDs, cursors or peer content
are included. Treat this file as private: configured identities are not public
telemetry.

Channel meanings are deliberately narrow:

- Identity success means the identity GET body passed the configured-identity
  validation, not merely HTTP 200 or a usable token.
- Inbox success means this refresh's bounded head and optional saved-tail reads
  were durably processed. It does not mean the backlog drained. Head delivery
  still precedes tail I/O. An eligible failed tail does not block answer sweeping.
- Answers success means this bounded sweep returned successfully, including an
  empty sweep. It does not mean any Task completed or follow-up is guaranteed.
- `blockedInbox` and `blockedAnswers` count quarantined tasks separately. A
  channel's `ok` result cannot override its nonzero blocked count.

Readers must reject unknown versions/malformed or missing files, mismatched
configured identity/generation, non-running lifecycle, unknown/checking/failed
channels and blocked counts. Evaluate freshness at read time: `updatedAt` and
each channel's `lastAttemptAt` must be no more than `staleAfterMs` (180000 ms)
old; a future update or channel attempt is invalid. `channelState` in `src/health.ts` implements
the channel/lifecycle/freshness checks. Never infer health from a file's presence
or from identity success alone. Shutdown writes stopped before releasing the
lock. If ownership is lost or that final write fails, the retained file ages to
stale. A final observation failure does not block other profiles or reattachment.

Health persistence is fail-closed, not advisory: failures invalidate the current
generation before more intake or publication. Identity observations run before
mail writes, outside transport/write classification. No post-publication health
write turns an accepted or uncertain mail write into a replay-safe refusal.
Snapshots never reset exchange fences, ledgers or cursors.

### OAuth recovery warning

A locked `oauth-exchange.json` fence (including the older boolean `true`), an
unresolved `oauth-code-exchange.json`, `OAUTH_EXCHANGE_UNCERTAIN` or
`OPERATOR_OAUTH_REQUIRED` produces a labelled UI warning, once per unresolved
episode in a generation. Startup checks the fence even with a valid access token.
A valid, matching schema 4 refresh journal with retry budget is resumable, not
locked. Superseded schemas are never migrated or silently reset.
`oauthCode` remains in health while recovery is required. A fence-free validated
identity ends the episode; a later fence/required error can warn again. Warnings
show host, owner/agent and organization, never token values or the private path.

Recovery is **terminal only**, not a `/concourse-v3 login` slash command. Stop
the existing consumer normally; from the checkout root run:

```sh
script/concourse-v3 login --profile /absolute/path/concourse-v3/profile [--no-open] [--json]
```

Then resume the same session. The warning does not stop the consumer, acquire
another lock, retry an exchange or clear any file.


## Marked refresh recovery (header contract version 1)

This is source for a negotiated issuer extension, not evidence that an issuer
advertises it or an installed session uses it. Exact-source review, release and
both OAuth/OpenID discovery readbacks gate activation. This release still requires
Linux private storage and kernel flock; it does not qualify a macOS build.

Refresh tokens rotate. Losing a response does not make an ordinary token POST
safe to repeat. The expected issuer must advertise the
exact `concourse_refresh_idempotency` version 1 object, and the profile must
have its full expected Concourse identity. Superseded form-field extensions are
not negotiated. Only a new refresh may fall back to the old one-shot unmarked
behavior if discovery fails or is unsupported; a saved operation stays fenced.

Each marked logical rotation uses one fresh canonical UUIDv4 in a quoted
`Idempotency-Key` Structured Field string. `Concourse-Refresh-Dispatch` is an
unquoted increasing integer, 1–8. The private schema 4 journal reserves every
POST durably before dispatch, under the profile's kernel lock and durable owner
epoch. A crash after reservation still consumes that slot. Retries retain the
same parent, client, resource, scope and key; the next rotation gets a new key.

Only these outcomes can permit a later request with the same key:

- Transport loss without a usable HTTP response, with total budget remaining.
- An exact validated HTTP 409 problem response: matching version/key/ordinal,
  `application/problem+json`, `Cache-Control: no-store`, `Retry-After: 1`, and
  the issuer's in-progress type/error. The next request waits at least one second,
  even after restart, then reserves its dispatch and conflict retry together.

At most eight POSTs and four 409-triggered reservations are allowed per operation.
If an initial 409 and its four conflict retries all return 409, the client stops
after five POSTs. Dispatch count and generation are independent: dispatch 2 can
return generation 1. The issuer permits at most four generations and alone
enforces the non-sliding recovery window of at most 24 hours. No client clock
or sleep detection decides whether that window remains open.

Every non-409 HTTP refusal—including 408, 429 and 5xx—is nonretryable, even
with Retry-After. Generic/malformed 409, withdrawn capability for a saved
operation, malformed receipt, failed identity, exhausted budgets and unknown
journals fail closed. Refused or locked profiles need explicit fresh sign-in;
never erase files or replay authorization codes.

A success must carry `concourse_refresh_idempotency` with exact version 1, key,
dispatch, generation and `expires_at`. Before any result-induced mutation,
including refusals, the client checks the live operation, latest ordinal, tokens
and captured owner epoch. It rechecks after identity validation. Stale results
cannot install credentials, fence a newer operation or clear its journal.

A commit-ready journal records the validated receipt and verified identity.
Tokens and their full matching receipt/identity are saved atomically before
journal clearing. An interrupted clear reconciles only that exact durable proof,
even after the access token expires. Changed credentials alone prove nothing.
Fresh PKCE recovery retains the original refresh fence until verified success;
its separate code journal never authorizes code replay. Local storage failures
stop the current token client rather than being classified as transport loss.

## Client revisions carried here

- 359230a: peer-mail guideline clarifies that no-ACK does not stop authorised owner
  work. It adds no scheduler or automatic continuation loop.
- d8cd25f: awaiting-approval/declined recovery and Continue in terminal guidance.
- 83c6871: additive3.1.0 package release with shared CLI/MCP interface improvements.
- 468d026: native tool annotations; annotations grant no execution permission.
- edeefd0: cancellation validates the requested Task's actual returned state.

These are source revisions, not claims about which server or session is currently
running them. Version 3.1.1 also fixes dependency-free CLI bootstrap. The initial
client-only import starts a new history; it contains no private server Git objects.