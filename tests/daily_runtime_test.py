#!/usr/bin/env python3
import contextlib
import io
import json
import http.client
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from unittest import mock
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "dailyctl"
sys.path.insert(0, str(ROOT))


class DailyRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.env = os.environ.copy()
        self.env.update({
            "HOME": str(base / "home"),
            "NEXUS_HOME": str(base / "nexus"),
            "XDG_CONFIG_HOME": str(base / "config"),
            "XDG_DATA_HOME": str(base / "data"),
            "XDG_STATE_HOME": str(base / "state"),
            "XDG_BIN_HOME": str(base / "bin"),
            "DAILY_WORKLOG_TEST_MODE": "1",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, input=None, check=True):
        result = subprocess.run(
            [str(CLI), *args], input=input, text=True,
            capture_output=True, env=self.env, cwd=ROOT,
        )
        if check and result.returncode != 0:
            self.fail(f"{result.args}\nstdout={result.stdout}\nstderr={result.stderr}")
        return result

    def json(self, *args, input=None):
        result = self.run_cli("--json", *args, input=input)
        return json.loads(result.stdout)

    def free_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def http_request(self, port, method, path, *, headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def bootstrap(self, port, url, *, accept=None):
        token = parse_qs(urlparse(url).query)["token"][0]
        headers = {"Accept": accept} if accept else None
        return self.http_request(port, "GET", f"/bootstrap?token={token}", headers=headers)

    def wait_for_exit(self, pid, timeout=2):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.process_alive(pid):
                return True
            time.sleep(0.02)
        return False

    @staticmethod
    def process_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def stop_server(self, info):
        if not info:
            return
        pid = info.get("pid")
        if pid and self.process_alive(pid):
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
            self.wait_for_exit(pid)

    def test_setup_and_manual_entry_persist_with_private_state(self):
        setup = self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        self.assertEqual(setup["status"], "changed")
        entry = self.json(
            "note", "Fixed the daily runtime", "--state", "Done",
            "--at", "2026-08-13T15:20:00-03:00", "--linear", "FN-123",
        )
        self.assertEqual(entry["status"], "changed")
        report = self.json("report")
        self.assertEqual(report["entries"][0]["text"], "Fixed the daily runtime")
        db = Path(self.env["XDG_DATA_HOME"]) / "daily-worklog" / "daily.sqlite3"
        self.assertEqual(db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(db.stat().st_uid, os.getuid())

    def test_lifecycle_is_idempotent_and_uses_monday_meeting_date(self):
        self.json("setup", "--at", "2026-08-14T14:00:00-03:00", "--project", str(ROOT))
        stopped = self.json("stop", "--at", "2026-08-14T18:00:00-03:00")
        self.assertEqual(stopped["status"], "changed")
        self.assertEqual(self.json("stop", "--at", "2026-08-14T18:01:00-03:00")["status"], "noop")
        resumed = self.json("continue", "--at", "2026-08-17T09:00:00-03:00")
        self.assertEqual(resumed["status"], "changed")
        self.assertEqual(resumed["reporting_period"]["meeting_date"], "2026-08-17")
        archived = self.json("start", "--at", "2026-08-17T10:00:00-03:00")
        self.assertEqual(archived["status"], "changed")
        self.assertEqual(archived["archived_meeting_date"], "2026-08-17")

    def test_capture_filters_projects_deduplicates_and_redacts(self):
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        event = {
            "agent": "claude", "session_id": "s1", "turn_id": "t1",
            "completion_time": "2026-08-13T15:00:00-03:00", "project_root": str(ROOT),
            "kind": "completed_turn", "final_response": "Implemented token=secret-value and fixed the bug",
        }
        first = self.json("capture", input=json.dumps(event))
        again = self.json("capture", input=json.dumps(event))
        self.assertEqual(first["status"], "changed")
        self.assertEqual(again["status"], "noop")
        pending = self.json("curate-export")
        self.assertEqual(len(pending["candidates"]), 1)
        self.assertNotIn("secret-value", json.dumps(pending))
        outside = dict(event, turn_id="t2", project_root="/tmp/not-tracked")
        self.assertEqual(self.json("capture", input=json.dumps(outside))["status"], "discarded")

    def test_curation_is_all_or_nothing_and_present_hides_evidence(self):
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        event = {
            "agent": "codex", "session_id": "s2", "turn_id": "t2",
            "completion_time": "2026-08-13T15:00:00-03:00", "project_root": str(ROOT),
            "kind": "completed_turn", "final_response": "Implemented the report endpoint",
            "linear": ["FN-456"], "pull_requests": ["https://github.com/acme/repo/pull/7"],
        }
        self.json("capture", input=json.dumps(event))
        bad = self.run_cli("--json", "curate-commit", input=json.dumps({"proposals": [{"candidate_id": "bad"}]}), check=False)
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(self.json("report")["entries"], [])
        committed = self.json("curate-commit", input=json.dumps({"proposals": [{
            "candidate_id": 1, "text": "Implemented the report endpoint", "state": "Done",
        }]}))
        self.assertEqual(committed["status"], "changed")
        present = self.json("present")
        self.assertNotIn("source_evidence", json.dumps(present))
        self.assertIn("FN-456", json.dumps(present))

    def test_enrichment_resolves_evidence_and_preserves_multiple_pull_requests(self):
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        self.json(
            "note", "Delivered the report enrichment", "--state", "Done",
            "--at", "2026-08-13T15:20:00-03:00", "--linear", "FN-123",
            "--pr", "https://github.com/acme/report/pull/7",
        )
        result = self.json("enrich", input=json.dumps({
            "references": [{
                "kind": "pull_request", "identifier": "acme/report#7",
                "repository": "acme/report", "branch": "feature/enrichment", "commit": "abc123",
            }, {"kind": "linear", "identifier": "FN-123"}],
            "github": {"status": "ok", "pull_requests": [
                {"repository": "acme/report", "number": 7, "title": "Add enrichment", "state": "OPEN",
                 "base_branch": "staging", "head_branch": "feature/enrichment", "head_sha": "abc123",
                 "url": "https://github.com/acme/report/pull/7"},
                {"repository": "acme/report", "number": 8, "title": "Promote enrichment", "state": "MERGED",
                 "base_branch": "production", "head_branch": "feature/enrichment", "head_sha": "def456",
                 "url": "https://github.com/acme/report/pull/8"},
            ]},
            "linear": [{"identifier": "FN-123", "title": "Read-only enrichment", "status": "In Progress",
                        "url": "https://linear.app/acme/issue/FN-123/read-only-enrichment",
                        "pull_requests": [{"repository": "acme/report", "number": 9, "title": "Ship enrichment",
                                           "state": "OPEN", "base_branch": "production",
                                           "url": "https://github.com/acme/report/pull/9"}]}],
        }))
        self.assertTrue(result["read_only"])
        self.assertEqual(result["external_writes"], 0)
        report = self.json("report")
        refs = report["entries"][0]["references"]
        by_id = {ref["identifier"]: ref for ref in refs}
        self.assertEqual(set(by_id), {"FN-123", "acme/report#7", "acme/report#8", "acme/report#9"})
        self.assertEqual(by_id["FN-123"]["title"], "Read-only enrichment")
        self.assertEqual(by_id["FN-123"]["status"], "In Progress")
        self.assertEqual(by_id["acme/report#7"]["target_branch"], "staging")
        self.assertEqual(by_id["acme/report#8"]["status"], "MERGED")
        self.assertEqual(by_id["acme/report#9"]["target_branch"], "production")

    def test_enrichment_uses_stale_cache_and_keeps_failures_out_of_present_mode(self):
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        self.json("note", "Fixed the delivery link", "--at", "2026-08-13T15:20:00-03:00", "--pr", "https://github.com/acme/report/pull/7")
        self.json("enrich", input=json.dumps({
            "references": [{"kind": "pull_request", "identifier": "acme/report#7"}],
            "github": {"status": "ok", "pull_requests": [{"repository": "acme/report", "number": 7,
                "title": "Cached delivery", "state": "OPEN", "base_branch": "staging",
                "url": "https://github.com/acme/report/pull/7"}]},
        }))
        degraded = self.json("enrich", input=json.dumps({
            "offline": True, "cache_ttl_seconds": 0,
            "references": [{"kind": "pull_request", "identifier": "acme/report#7"}],
            "github": {"status": "rate_limited", "message": "token=should-not-leak"},
            "linear": {"status": "expired_auth", "message": "authorization expired"},
        }))
        self.assertTrue(degraded["read_only"])
        self.assertEqual(degraded["external_writes"], 0)
        self.assertEqual({item["code"] for item in degraded["diagnostics"]}, {"rate_limited", "expired_auth", "stale_cache"})
        report = self.json("report")
        self.assertEqual(report["entries"][0]["references"][0]["title"], "Cached delivery")
        present = self.json("present")
        self.assertNotIn("diagnostics", json.dumps(present))
        self.assertNotIn("rate_limited", json.dumps(present))
        self.assertNotIn("should-not-leak", json.dumps(self.json("report")))

    def test_missing_integration_metadata_is_non_blocking(self):
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT))
        self.json("note", "Investigated the missing pull request", "--at", "2026-08-13T15:20:00-03:00", "--pr", "https://github.com/acme/report/pull/7")
        result = self.json("enrich", input=json.dumps({
            "references": [{"kind": "pull_request", "identifier": "acme/report#7"}],
            "github": {"status": "ok", "pull_requests": [{"number": 7}]},
        }))
        self.assertEqual(result["status"], "noop")
        self.assertEqual(result["diagnostics"][0]["code"], "missing_metadata")
        self.assertEqual(len(self.json("report")["entries"]), 1)
        self.assertNotIn("missing_metadata", json.dumps(self.json("present")))

    def test_view_reuses_healthy_server_and_bootstrap_is_single_use(self):
        port = self.free_port()
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT), "--port", str(port))
        self.env["DAILY_WORKLOG_NO_BROWSER"] = "1"
        first = self.json("view")
        info_path = Path(self.env["XDG_STATE_HOME"]) / "daily-worklog" / "server.json"
        info = json.loads(info_path.read_text())
        try:
            second = self.json("view")
            self.assertEqual(second["status"], "noop")
            self.assertEqual(second["pid"], first["pid"])
            self.assertEqual(info["pid"], first["pid"])

            try:
                local_addresses = {
                    result[4][0]
                    for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM)
                    if not result[4][0].startswith("127.")
                }
            except OSError:
                local_addresses = set()
            for address in local_addresses:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
                    client.settimeout(0.2)
                    self.assertNotEqual(client.connect_ex((address, port)), 0, f"server exposed on {address}")

            status, _, _ = self.http_request(port, "GET", "/")
            self.assertEqual(status, 401)
            status, headers, body = self.bootstrap(port, first["url"])
            self.assertEqual(status, 200)
            self.assertIn("HttpOnly", headers["Set-Cookie"])
            self.assertIn("SameSite=Strict", headers["Set-Cookie"])
            self.assertEqual(json.loads(body)["mode"], "prepare")
            status, _, _ = self.http_request(port, "GET", "/", headers={"Cookie": headers["Set-Cookie"].split(";", 1)[0]})
            self.assertEqual(status, 200)

            fresh = self.json("view")
            status, html_headers, _ = self.bootstrap(port, fresh["url"], accept="text/html")
            self.assertEqual(status, 303)
            self.assertEqual(html_headers["Location"], "/")

            token = parse_qs(urlparse(first["url"]).query)["token"][0]
            status, _, _ = self.http_request(port, "GET", f"/bootstrap?token={token}")
            self.assertEqual(status, 403)
        finally:
            self.stop_server(info)

    def test_view_reports_foreign_port_collision_without_disturbing_owner(self):
        port = self.free_port()
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT), "--port", str(port))
        with socket.socket() as owner:
            owner.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            owner.bind(("127.0.0.1", port))
            owner.listen()
            result = self.run_cli("--json", "view", check=False)
            self.assertEqual(result.returncode, 2)
            self.assertIn("already in use", json.loads(result.stdout)["error"])
            self.assertEqual(owner.getsockname()[1], port)

    def test_authenticated_shutdown_is_immediate_and_idle_server_expires(self):
        port = self.free_port()
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT), "--port", str(port))
        self.env.update({"DAILY_WORKLOG_NO_BROWSER": "1", "DAILY_WORKLOG_IDLE_SECONDS": "0.15"})
        result = self.json("view")
        info_path = Path(self.env["XDG_STATE_HOME"]) / "daily-worklog" / "server.json"
        info = json.loads(info_path.read_text())
        try:
            status, headers, body = self.bootstrap(port, result["url"])
            self.assertEqual(status, 200)
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            csrf = json.loads(body)["csrf"]
            time.sleep(0.3)
            self.assertTrue(self.wait_for_exit(info["pid"]), "idle server did not stop")

            # The timeout test also proves that a process can be stopped; a
            # fresh server exercises the authenticated immediate shutdown path.
            self.env["DAILY_WORKLOG_IDLE_SECONDS"] = "7200"
            result = self.json("view")
            info = json.loads(info_path.read_text())
            status, headers, body = self.bootstrap(port, result["url"])
            self.assertEqual(status, 200)
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            csrf = json.loads(body)["csrf"]
            status, _, _ = self.http_request(
                port,
                "POST",
                "/api/shutdown",
                headers={
                    "Content-Type": "application/json",
                    "Cookie": cookie,
                    "Origin": f"http://127.0.0.1:{port}",
                },
                body=json.dumps({"csrf": csrf}),
            )
            self.assertEqual(status, 200)
            self.assertTrue(self.wait_for_exit(info["pid"]), "shutdown did not stop server")
        finally:
            self.stop_server(info)

    def test_browser_failure_is_reported_without_stopping_server(self):
        port = self.free_port()
        self.json("setup", "--at", "2026-08-13T14:00:00-03:00", "--project", str(ROOT), "--port", str(port), "--browser", "configured-browser")
        info_path = Path(self.env["XDG_STATE_HOME"]) / "daily-worklog" / "server.json"
        output = io.StringIO()
        browser = mock.Mock()
        browser.open.return_value = False
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ResourceWarning)
            with mock.patch.dict(os.environ, self.env, clear=False), mock.patch("daily.runtime.webbrowser.get", return_value=browser), mock.patch("daily.runtime.webbrowser.open", return_value=False), contextlib.redirect_stdout(output):
                from daily import runtime
                self.assertEqual(runtime.main(["--json", "view"]), 0)
        result = json.loads(output.getvalue())
        info = json.loads(info_path.read_text())
        try:
            self.assertFalse(result["browser"]["opened"])
            self.assertIn("configured browser", result["browser"]["error"])
            status, _, _ = self.http_request(port, "GET", "/health")
            self.assertEqual(status, 200)
        finally:
            self.stop_server(info)


if __name__ == "__main__":
    unittest.main()
