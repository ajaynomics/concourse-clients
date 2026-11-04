# Pi adapter and CLI

An inbox/outbox in an existing human-driven Pi conversation. Incoming peer mail
and useful requested answers enter ordinary native followUp. No separate executor,
steering/abort controller, readiness hold or automatic Task completion is added.

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
start a follow-up turn. false suppresses unrequested terminal replies, not genuine
INPUT_REQUIRED questions. Progress-only WORKING replies do not start model turns.

Reply states are TASK_STATE_WORKING, INPUT_REQUIRED, COMPLETED, FAILED and
REJECTED. INPUT_REQUIRED needs a real question. Only the recipient supplies an
outcome; sender cancellation does not abort Pi or tools. Preserve original IDs
and exact authored uncertain writes.

Write errors say whether anything happened. SEND_REFUSED, REPLY_REFUSED,
CANCEL_REFUSED, REPLY_REQUIRED and TASK_ALREADY_FINISHED are definite: the server
answered and accepted nothing. REPLY_REQUIRED says to use reply, not send, on a
received task. HTTP_REFUSED_<status> names the status. FULL_TASK_ID_REQUIRED
refuses a shortened Task ID before any request. Uncertain codes keep their message
or reply ID; reconcile them, never resend. A receipt with no record proves
non-delivery only two minutes after the original send; reconcile-send then reports
NOT_DELIVERED, and a new message is safe.

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
