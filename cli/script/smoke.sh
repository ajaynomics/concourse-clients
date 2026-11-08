#!/bin/sh
# Pack this package, install the tarball into an empty directory and run it on
# plain Node. Installing fetches the pinned SDK from the npm registry; every
# command then talks only to a local self-signed HTTPS stub, never a real service.
set -eu
CLI=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=$(command -v "${CONCOURSE_V3_NODE:-node}")
umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/concourse-cli-smoke.XXXXXX")
STUB=
trap 'if [ -n "$STUB" ]; then kill "$STUB" 2>/dev/null || true; fi; rm -rf -- "$WORK"' EXIT HUP INT TERM
fail() { printf 'smoke: %s\n' "$*" >&2; exit 1; }

cd "$CLI"
npm pack --silent --pack-destination "$WORK" >/dev/null
TARBALL=$(ls "$WORK"/concourse-cli-*.tgz)
mkdir "$WORK/app" "$WORK/home"
cd "$WORK/app"
printf '{"name":"smoke","private":true}\n' > package.json
npm install --silent --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null
BIN="$WORK/app/node_modules/.bin/concourse"
[ ! -e node_modules/@earendil-works ] && [ ! -e node_modules/typebox ] || fail "Pi packages were installed"

"$BIN" --help | grep -q '^Usage: concourse COMMAND' || fail "--help"
[ "$("$BIN" --version)" = "$("$NODE" -p "require('$CLI/package.json').version")" ] || fail "--version"
set +e; "$BIN" frobnicate >/dev/null 2>&1; code=$?; set -e
[ "$code" = 64 ] || fail "usage error exit $code"

# A synthetic Concourse: identity for one token, 401 for any other, one A2A peer.
cd "$WORK"
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 >/dev/null 2>&1
cat > stub.mjs <<'EOF'
import { createServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
const identity = { release_line: 3, organization: "smoke", owner: "owner", handle: "healthy", oauth_client_id: "synthetic-client", agent_id: 1, network_agent: "concourse/network-1" };
const server = createServer({ key: readFileSync("key.pem"), cert: readFileSync("cert.pem") }, (req, res) => {
  const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== "Bearer synthetic-smoke-token") return send(401, { error: "unauthorized" });
  const base = `https://127.0.0.1:${server.address().port}/a2a/smoke/peer/agent`;
  if (req.url === "/api/identity") return send(200, identity);
  if (req.url === "/a2a/smoke/peer/agent/.well-known/agent-card.json") return send(200, { name: "peer/agent", description: "Stub", version: "1.0.0", supportedInterfaces: [{ url: base, protocolBinding: "JSONRPC", protocolVersion: "1.0" }], capabilities: {}, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] });
  if (req.method === "POST" && req.url === "/a2a/smoke/peer/agent") {
    let body = ""; req.on("data", c => { body += c; });
    return req.on("end", () => send(200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { task: { id: "00000000-0000-4000-8000-0000000000aa", contextId: "c1", status: { state: "TASK_STATE_SUBMITTED" } } } }));
  }
  send(404, {});
});
server.listen(0, "127.0.0.1", () => writeFileSync("port", String(server.address().port)));
EOF
"$NODE" stub.mjs & STUB=$!
i=0; while [ ! -s port ]; do i=$((i + 1)); [ "$i" -lt 100 ] || fail "stub did not start"; sleep 0.1; done
PORT=$(cat port)

expires=$(( $(date +%s) * 1000 + 3600000 ))
profile() { # NAME TOKEN PORT
  d="$WORK/home/.local/state/concourse-v3/$1"; mkdir -p "$d"
  printf '{"version":3,"origin":"https://127.0.0.1:%s","organization":"smoke","owner":"owner","agent":"%s","oauthClientId":"synthetic-client","issuer":"https://issuer.invalid","tokenEndpoint":"https://issuer.invalid/token","auth":{"kind":"client_credentials","clientSecret":"synthetic-not-a-credential"}}' "$3" "$1" > "$d/config.json"
  printf '{"access":"%s","expires":%s,"resource":"https://127.0.0.1:%s","issuer":"https://issuer.invalid","clientId":"synthetic-client"}' "$2" "$expires" "$3" > "$d/tokens.json"
}
profile healthy synthetic-smoke-token "$PORT"
profile revoked synthetic-revoked-token "$PORT"
profile offline synthetic-smoke-token 9
run() { HOME="$WORK/home" NODE_EXTRA_CA_CERTS="$WORK/cert.pem" "$BIN" "$@"; }

[ "$(run doctor --profile healthy | head -1)" = "Healthy: smoke/owner/healthy at https://127.0.0.1:$PORT" ] || fail "healthy doctor"
run send peer/agent "Smoke test" --profile healthy | grep -q '^Sent to peer/agent\. Task 00000000-0000-4000-8000-0000000000aa is submitted\.$' || fail "send through the installed SDK"
for case in "revoked HTTP_REFUSED_401" "offline TRANSPORT_FAILED"; do
  set -- $case
  set +e; out=$(run doctor --profile "$1" --json 2>/dev/null); code=$?; set -e
  [ "$code" = 1 ] || fail "$1 doctor exit $code"
  printf '%s\n' "$out" | "$NODE" -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); if (v.phase !== "blocked" || v.error !== process.argv[1]) process.exit(1)' "$2" || fail "$1 doctor output: $out"
  set +e; human=$(run doctor --profile "$1" 2>&1); set -e
  printf '%s\n' "$human" | head -1 | grep -qx "Error: $2" || fail "$1 human output: $human"
  ! printf '%s\n' "$human" | grep -q '    at ' || fail "$1 printed a stack trace"
done
printf 'smoke: ok %s (%s files) on Node %s\n' "$(basename "$TARBALL")" "$(tar -tzf "$TARBALL" | wc -l)" "$("$NODE" -v)"
