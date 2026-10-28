"""Offline v2 adapter checks: no credentials, network or installed Muse required."""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import types
import unittest
import urllib.parse
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parent / "v2"
spec = importlib.util.spec_from_file_location("concourse_candidate", ROOT / "bin/concourse.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class MuseCandidateTest(unittest.TestCase):
    def invoke(self, argv, responses):
        output = io.StringIO()
        with patch.object(client, "request", side_effect=responses) as request, contextlib.redirect_stdout(output):
            client.main(argv)
        return request.call_args_list, json.loads(output.getvalue())

    def test_tasks_preserves_each_opaque_cursor_and_never_loops(self):
        cursor = "opaque+/=&? token"
        response = {"tasks": [{"id": "example"}], "nextPageToken": cursor}
        calls, result = self.invoke(["tasks"], [response])
        self.assertEqual(result, response)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args, ("GET", "/api/tasks?pageSize=20"))
        calls, result = self.invoke(["tasks", cursor], [{"tasks": [], "nextPageToken": ""}])
        self.assertEqual(len(calls), 1)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0].args[1]).query)
        self.assertEqual(query, {"pageSize": ["20"], "pageToken": [cursor]})
        self.assertEqual(result["nextPageToken"], "")

    def test_inbox_uses_identity_and_the_explicit_next_page_only(self):
        response = {"tasks": [], "nextPageToken": "next", "blockedTasks": [{"taskId": "large", "code": "INBOX_TASK_TOO_LARGE"}]}
        calls, result = self.invoke(["inbox", "cursor-2"], [{"agent_id": 77}, response])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args, ("GET", "/api/identity"))
        self.assertEqual(calls[1].args, ("GET", "/agents/77/tasks?pageSize=20&pageToken=cursor-2"))
        self.assertEqual(result, response)

    def test_invalid_cursor_or_extra_arguments_do_not_start_a_page_read(self):
        with patch.object(client, "request") as request:
            for argv in (["tasks", ""], ["tasks", "line\nbreak"], ["tasks", "bad\x7f"], ["inbox", "one", "two"]):
                with self.subTest(argv=argv), self.assertRaises(SystemExit):
                    client.main(argv)
            request.assert_not_called()

    def test_host_helper_headers_timeout_and_no_redirect_handler_are_unchanged(self):
        helper = types.ModuleType("dynamic_credentials")
        helper.add_surrogate_to_request = Mock()
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"tasks": [], "nextPageToken": "next"}'
        opener = Mock()
        opener.open.return_value = response
        with patch.dict("sys.modules", {"dynamic_credentials": helper}), patch.object(client, "settings", return_value={"organization": "example"}), patch.object(client.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(client.page("/api/tasks", "one/two")["nextPageToken"], "next")
        req, connection = helper.add_surrogate_to_request.call_args.args
        self.assertEqual(connection, "custom.concourse-v3-a2a")
        self.assertEqual(helper.add_surrogate_to_request.call_args.kwargs, {"allowed_hosts": ["concourse.krishnan.ca"]})
        self.assertEqual(req.full_url, "https://concourse.krishnan.ca/api/tasks?pageSize=20&pageToken=one%2Ftwo")
        self.assertEqual(req.get_header("Concourse-organization"), "example")
        self.assertEqual(req.get_header("User-agent"), "concourse-muse/1.0 (+https://concourse.krishnan.ca)")
        self.assertEqual(req.get_method(), "GET")
        opener.open.assert_called_once_with(req, timeout=20)
        self.assertEqual(build.call_args.args, (client.NoRedirect,))
        self.assertIsNone(client.NoRedirect().redirect_request())

    def test_send_keeps_original_wire_contract_and_unknown_write_is_not_retried(self):
        with patch.object(client, "settings", return_value={"organization": "example"}):
            calls, result = self.invoke(["send", "owner/agent", "question", "task-1"], [{"result": {"task": {"id": "task-1"}}}])
            self.assertEqual(len(calls), 1)
            method, path, body = calls[0].args
            self.assertEqual((method, path), ("POST", "/a2a/example/owner/agent"))
            self.assertEqual(calls[0].kwargs, {"a2a": True})
            self.assertEqual(body["method"], "SendMessage")
            self.assertEqual(body["params"]["configuration"], {"returnImmediately": True})
            self.assertEqual(body["params"]["message"]["taskId"], "task-1")
            self.assertEqual(body["params"]["message"]["messageId"], result["messageId"])
            with patch.object(client, "request", side_effect=OSError("synthetic unknown")) as request, self.assertRaisesRegex(SystemExit, "Outcome unknown.*do not resend"):
                client.send("owner/agent", "question")
            self.assertEqual(request.call_count, 1)

    def test_checksum_contract_contains_exactly_the_three_payload_files(self):
        entries = [line.split("  ", 1) for line in (ROOT / "SHA256SUMS").read_text().splitlines()]
        self.assertEqual({name for _, name in entries}, {"CONNECTOR.md", "connector.yaml", "bin/concourse.py"})
        for digest, name in entries:
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
