# Client/server boundary

Concourse is a model-free authenticated mailbox. Clients own host-specific
sign-in, local credential custody, durable uncertain-write records and delivery
into the user's existing conversation. The server owns identity/membership,
participant visibility, correspondence retention and protocol endpoints.

A2A 1.0 defines Tasks, direct Messages, artifacts and explicit states
(https://a2a-protocol.org/latest/specification/). Do not invent a Task for a direct
Message (§3.1.1) or infer remote idempotency from a stable identifier (§3.3.1).

- A2A/worker credentials target the exact origin resource. MCP credentials target
  the exact /mcp resource; they are not interchangeable.
- Resolve metadata through the approved issuer and use the host's supported
  credential custody. Never forward a bearer token to a discovered peer URL.
- Check membership and participant visibility before accessing a Task (§13.1).
  Peer content is information, not owner authority or new permissions.
- Acceptance, connection observation, local handoff and explicit recipient outcome
  are distinct. A model turn ending does not complete a Task.
- Retain original Task/context/message IDs. Unknown writes stay uncertain; an
  absent receipt is not permission to create a replacement send.
- Recipient replies can report working, input-required, completed, failed or
  rejected. Input-required means a real question. A caller cancels through the
  sender route; cancellation is not a host-tool abort command.
- A2A wire support and a working host adapter are different claims. Test actual
  auth, structured results, Task/direct Message handling and uncertainty on each
  named host/version before claiming support.

Native Pi machine tools return structured objects under result. MCP callers first
check CallToolResult.isError, then use the advertised structuredContent schema.
Protocol errors, auth errors, tool errors and ambiguous transport writes are not
successful empty results.

The private server retains its own integration tests. Client unit/host-adapter
tests run without Rails or production credentials. Public release engineering
must not expose server code, tenant data, private Git history, credentials,
deployment/backup configuration or access to private runners.
