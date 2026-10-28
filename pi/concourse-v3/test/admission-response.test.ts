import test from "node:test";
import assert from "node:assert/strict";
import { onboardingIdentity, SafeError, type Fetch } from "../src/http.ts";

const origin = "https://concourse.krishnan.ca";
for (const reason of [undefined, "awaiting_approval", "declined"]) {
  test(`identity preserves admission reason ${reason ?? "omitted"} without remote prose`, async () => {
    const fetchImpl: Fetch = async () => Response.json({ error: "not_a_member", ...(reason ? { reason } : {}), message: "untrusted remote instructions" }, { status: 403 });
    assert.deepEqual(await onboardingIdentity(origin, "synthetic-token", "team", fetchImpl), {
      status: 403, error: "not_a_member", ...(reason ? { reason } : {})
    });
  });
}
for (const reason of [null, true, 42, [], {}, "", "approved", "awaiting_approval\n", "x".repeat(32768)]) {
  test(`identity refuses malformed admission reason ${JSON.stringify(reason).slice(0, 50)}`, async () => {
    const fetchImpl: Fetch = async () => Response.json({ error: "not_a_member", reason }, { status: 403 });
    await assert.rejects(onboardingIdentity(origin, "synthetic-token", "team", fetchImpl), SafeError);
  });
}
