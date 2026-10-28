# Qualified Pi 1.4.0 runtime

Seven unchanged archives pin source commit
`5f7cade86e49811fada9599833a72ca3da4c5852`, carrying the input-preparation fix
from `3127a8a5`. The manifest records versions, paths and SHA512 integrities.
The source patch, upstream MIT licence and full third-party notices are retained.

The fix keeps asynchronous input and prestart mail on Pi's native scheduling
path, including an input handler awaiting its triggering custom message. It
adds no executor, readiness gate, automatic abort/replay or acknowledgement.

The connector lock and startup plan require these exact artifacts. A different
runtime needs separate behavioural qualification; do not substitute stock or
global Pi merely to make installation succeed.

The package-specific MIT declaration for proxy-agent-negotiate@1.1.0 is
established; the copied sibling notice's copyright applicability is not.
[Licence provenance](../../../docs/licensing.md) records the distribution
decision and the remaining caveat without altering these qualified bytes.

Publishing this source does not change any installed runtime, provider,
account, profile or session.
