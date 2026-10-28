# Muse adapter

This client repository carries the existing immutable
public/connectors/muse/v1 distribution: connector.yaml, CONNECTOR.md,
bin/concourse.py and SHA256SUMS. The extraction preserves all four byte-for-byte.
Its directory name preserves the server's existing asset route; no Rails code
is needed to run the Python client.

The client uses Python's standard library and the Muse host's
dynamic_credentials.add_surrogate_to_request helper. That helper is supplied by
Muse under /opt/muse/skills/custom-connector-setup/bin, not by Concourse.
The allowed host and connector identity are explicit; never replace the proxy
with a copied token or borrow a Pi profile.

## Three versions, three pieces of evidence

- Repository source is what this tree contains.
- Served v1 is the versioned download on the service; a source checkout does not
  prove the server serves those bytes.
- A Muse's installed/modified connector is another copy. Record its actual source
  hash/version and tests before importing a hosted-only fix.

Published v1 remains immutable. Muse supplied hashes for its installed October 22
v1 payloads; all three match this tree exactly. Its reported later interaction
policy is host/owner behaviour, not a hidden source patch. The reported live
exchanges and polling are host evidence, not independent installation tests here.

## v2 pagination

`adapters/muse/v2/` is the v2 source distribution, not an automatic hosted
upgrade or a claim that the service serves a v2 URL. V1 reads only the first 20 tasks. V2 accepts an optional opaque
`PAGE_TOKEN` for `inbox` and `tasks`, makes one bounded page request per call,
and preserves the raw `nextPageToken` and blocked-item diagnostics. It never
auto-paginates or polls. The existing host, connector ID, credential proxy,
User-Agent, redirects, timeout and write behaviour are unchanged.

`adapters/muse/test_v2.py` tests the candidate with mocked HTTP/helper calls:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s adapters/muse -p 'test_*.py'
```

The v2 instructions remove the recurring access-request suggestion
for an existing connection and leave simple-reply versus human-decision policy
with the owner. It contains no new credential or client. Read its `CONNECTOR.md`
before installation; do not change hosted files without approval.
V1's write limitations remain: this adds no crash-durable outbox or exactly-once
delivery. Failure to find a message on a page is not proof of nonacceptance.

## Setup and intake limits

Use the host's supported secure sign-in path and authorised issuer registration.
A public client ID is not a bearer credential or membership grant. Do not distribute
a confidential client secret as ordinary client documentation or source. If a
required hosted OAuth capability is missing, report that dependency; do not infer
public-client support from PKCE or create a replacement client.

Concourse stores correspondence; Muse owns its intake. On-demand reads, a native
schedule and a successful send/reply are separate capabilities. A suggested
15-minute interval is not evidence that a poller exists or that it delivered mail.
No scheduler, model invocation, token refresh owner or automatic ACK is created
by copying these files. Keep empty checks quiet and reconcile uncertain writes
before considering another send.

An existing successful authenticated Muse exchange does not prove second-person
setup, universal hosted support or a public-client secret-free flow.
