"""Offline source-release boundary checks; no service or model calls."""
import base64
import hashlib
import json
import pathlib
import re
import subprocess
import tarfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
VENDOR = ROOT / "pi/vendor/pi-140-input-preparation-5f7cade8"


class SourceReleaseTest(unittest.TestCase):
    def test_tracked_tree_is_client_only_and_contains_no_local_state(self):
        paths = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"]).decode().split("\0")
        paths = [p for p in paths if p]
        self.assertTrue(paths, "stage the release source before checking the boundary")
        roots = {"AGENTS.md", "LICENSE", "NOTICE", "README.md", "JOIN-V3.md", ".gitignore", ".gitattributes"}
        prefixes = ("cli/", "pi/concourse-v3/", "pi/vendor/pi-140-input-preparation-5f7cade8/", "public/connectors/muse/v1/", "adapters/muse/", "docs/", "script/", "bin/", "test/")
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(path in roots or path.startswith(prefixes))
                self.assertFalse((ROOT / path).is_symlink())
                self.assertFalse(set(path.split("/")) & {"node_modules", "__pycache__", ".git", ".env", "tokens.json", "settings.json", "ledger.json"})

    def test_exact_seven_runtime_archives_and_safe_members(self):
        manifest = json.loads((VENDOR / "manifest.json").read_text())
        entries = manifest["packages"]
        self.assertEqual(len(entries), 7)
        self.assertEqual(len({e["name"] for e in entries}), 7)
        lock = json.loads((ROOT / "pi/concourse-v3/package-lock.json").read_text())["packages"]
        for entry in entries:
            with self.subTest(package=entry["name"]):
                path = VENDOR / entry["tarball"]
                digest = "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
                self.assertEqual(digest, entry["integrity"])
                pinned = lock["node_modules/" + entry["name"]]
                self.assertEqual(pinned["integrity"], digest)
                self.assertEqual(pinned["resolved"], "file:../vendor/pi-140-input-preparation-5f7cade8/" + entry["tarball"])
                with tarfile.open(path, "r:gz") as archive:
                    members = archive.getmembers()
                    self.assertEqual(len(members), len({m.name for m in members}))
                    for member in members:
                        self.assertTrue(member.isfile(), member.name)
                        parts = pathlib.PurePosixPath(member.name).parts
                        self.assertTrue(parts and parts[0] == "package", member.name)
                        self.assertNotIn("..", parts)

    def test_immutable_muse_v1_and_new_v2_checksums(self):
        expected_v1 = {
            "CONNECTOR.md": "834390562830e399ebfd123df7c120ae83170f38f0818c2d3739c8bc7cbbaaba",
            "connector.yaml": "f1fd64626cbcfd75c428cb1a1a674b5ba27e1b53fad929dfc8444524fa4b8b0e",
            "bin/concourse.py": "e474b7f442b25ada8017c8602be8c65cf80deb31cee5406c3c8317740bba463c",
        }
        for relative in ["public/connectors/muse/v1", "adapters/muse/v2"]:
            root = ROOT / relative
            entries = dict((name, digest) for digest, name in (line.split("  ", 1) for line in (root / "SHA256SUMS").read_text().splitlines()))
            self.assertEqual(set(entries), set(expected_v1))
            if relative.endswith("v1"):
                self.assertEqual(entries, expected_v1)
            for name, digest in entries.items():
                self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), digest)

    def test_local_document_links_resolve(self):
        for path in [ROOT / "README.md", ROOT / "AGENTS.md", *ROOT.glob("docs/*.md"), ROOT / "pi/concourse-v3/README.md", ROOT / "cli/README.md", VENDOR / "README.md"]:
            for target in re.findall(r"\]\(([^)]+)\)", path.read_text()):
                if target.startswith(("https:", "http:", "mailto:", "#")):
                    continue
                self.assertTrue((path.parent / target.split("#")[0]).exists(), (path, target))

    def test_personal_names_are_not_used_as_synthetic_client_fixtures(self):
        for path in [*(ROOT / "pi/concourse-v3/test").glob("*.ts"), *(ROOT / "cli/test").glob("*.ts")]:
            text = path.read_text()
            for value in ["ajent/", 'owner: "ajent"', "ajay/", 'owner: "ajay"', "home-agents", "legacy-operator", "/srv/projects/", "/home/ajay"]:
                self.assertNotIn(value, text, str(path))


if __name__ == "__main__":
    unittest.main()
