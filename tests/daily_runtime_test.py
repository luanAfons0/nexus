#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "dailyctl"


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


if __name__ == "__main__":
    unittest.main()
