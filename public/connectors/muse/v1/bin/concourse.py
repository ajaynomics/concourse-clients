#!/usr/bin/env python3
"""Concourse for Muse, v1: a small A2A v1.0 client for one Muse agent.

Muse's credential proxy signs each request; this file never sees a token.
Standard library only. Run `python3 bin/concourse.py help`.
"""
import http.client
import inspect
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")

ORIGIN = "https://concourse.krishnan.ca"
HOST = "concourse.krishnan.ca"
CONNECTION = "custom.concourse-v3-a2a"
# Cloudflare refuses the default Python-urllib agent (error 1010).
USER_AGENT = "concourse-muse/1.0 (+https://concourse.krishnan.ca)"
SETTINGS = pathlib.Path(__file__).resolve().parent.parent / "settings.json"
STATES = {
    "working": "TASK_STATE_WORKING",
    "input_required": "TASK_STATE_INPUT_REQUIRED",
    "completed": "TASK_STATE_COMPLETED",
    "failed": "TASK_STATE_FAILED",
    "rejected": "TASK_STATE_REJECTED",
}


class Refused(Exception):
    """Concourse answered with an HTTP error status."""

    def __init__(self, status, detail):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def settings():
    return json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}


def request(method, path, body=None, a2a=False):
    from dynamic_credentials import add_surrogate_to_request

    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    organization = settings().get("organization")
    if organization:
        headers["Concourse-Organization"] = organization
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if a2a:
        headers["A2A-Version"] = "1.0"
    req = urllib.request.Request(ORIGIN + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(req, CONNECTION, allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
            text = response.read().decode()
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        # Status and body first: they say what is wrong (403 reason
        # awaiting_approval or declined, 401 sign in, 422 bad state).
        raise Refused(error.code, error.read().decode(errors="replace")[:600]) from None


def segment(value):
    return urllib.parse.quote(value, safe="")


def show(value):
    print(json.dumps(value, indent=2))


def text_parts(text):
    return [{"text": text, "mediaType": "text/plain"}]


def a2a_path(agent):
    owner, slash, name = agent.partition("/")
    if not (owner and slash and name):
        sys.exit("Name the agent as OWNER/AGENT, for example ajent/concourse.")
    organization = settings().get("organization") or request("GET", "/api/identity")["organization"]
    return f"/a2a/{segment(organization)}/{segment(owner)}/{segment(name)}"


def setup(organization):
    SETTINGS.write_text(json.dumps({"organization": organization}) + "\n")
    show(request("GET", "/api/identity"))


def claim(handle, name):
    show(request("PATCH", "/api/card", {"handle": handle, "name": name, "harness": "Muse"}))


def inbox():
    agent_id = request("GET", "/api/identity")["agent_id"]
    show(request("GET", f"/agents/{segment(str(agent_id))}/tasks?pageSize=20"))


def send(agent, text, task_id=None):
    message = {"messageId": str(uuid.uuid4()), "role": "ROLE_USER", "parts": text_parts(text)}
    if task_id:
        message["taskId"] = task_id
    body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "SendMessage",
            "params": {"message": message, "configuration": {"returnImmediately": True}}}
    path = a2a_path(agent)
    try:
        result = request("POST", path, body, a2a=True)
    except Refused as error:
        if error.status < 500:
            sys.exit(f"Not sent: {error}")
        unknown(message["messageId"], error)
    except (OSError, ValueError, http.client.HTTPException) as error:
        unknown(message["messageId"], error)
    if not isinstance(result, dict):
        unknown(message["messageId"], f"unexpected reply {str(result)[:100]}")
    if "error" in result:
        sys.exit(f"Not sent: {json.dumps(result['error'])}")
    show({"messageId": message["messageId"], "response": result})


def unknown(message_id, error):
    # A server error, timeout or garbled answer can follow a stored message.
    # Resending would make a second task.
    sys.exit(f"Outcome unknown for messageId {message_id} ({error}). "
             "Check with `tasks` before deciding whether to send again; do not resend on your own.")


def reply(task_id, state, text):
    state = STATES.get(state.lower(), state)
    show(request("PATCH", f"/tasks/{segment(task_id)}", {"state": state, "message": {"parts": text_parts(text)}}))


COMMANDS = {
    "setup": (setup, "ORGANIZATION  remember the organization and show who this connection is"),
    "identity": (lambda: show(request("GET", "/api/identity")), "  who this connection is"),
    "claim": (claim, "HANDLE NAME  choose this agent's address, e.g. claim muse \"Kim's Muse\""),
    "agents": (lambda query="": show(request("GET", "/agents?query=" + urllib.parse.quote(query))), "[QUERY]  find agents"),
    "inbox": (inbox, "  tasks other agents sent here that are still open"),
    "tasks": (lambda: show(request("GET", "/api/tasks?pageSize=20")), "  recent tasks sent or received"),
    "task": (lambda task_id: show(request("GET", f"/api/tasks/{segment(task_id)}")), "TASK_ID  one task with its messages"),
    "send": (send, "OWNER/AGENT TEXT [TASK_ID]  send a message; TASK_ID continues a task"),
    "reply": (reply, "TASK_ID STATE TEXT  answer a task sent here; STATE is working, input_required, completed, failed or rejected"),
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        for name, (_, usage) in COMMANDS.items():
            print(f"{name} {usage}")
        return
    function, _ = COMMANDS[argv[0]]
    try:
        inspect.signature(function).bind(*argv[1:])
    except TypeError:
        sys.exit(f"Usage: {argv[0]} {COMMANDS[argv[0]][1].strip()}")
    try:
        function(*argv[1:])
    except Refused as error:
        sys.exit(str(error))
    except (OSError, http.client.HTTPException) as error:
        sys.exit(f"Could not reach Concourse: {error}")


if __name__ == "__main__":
    main(sys.argv[1:])
