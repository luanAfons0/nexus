import json
import unittest

from daily.integrations import GitHubReadOnlyAdapter, LinearReadOnlyAdapter


class _Result:
    returncode = 0
    stderr = ""

    def __init__(self, value):
        self.stdout = json.dumps(value)


class _Response:
    def __init__(self, value):
        self.value = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.value


class IntegrationAdapterTests(unittest.TestCase):
    def test_github_adapter_queries_only_read_operations(self):
        calls = []

        def runner(command, **_kwargs):
            calls.append(command)
            return _Result([{"number": 7, "repository": "acme/report"}])

        records = GitHubReadOnlyAdapter(runner).resolve({"repository": "acme/report", "branch": "feature/report"})
        self.assertEqual(records[0]["number"], 7)
        self.assertEqual(calls[0][:3], ["gh", "pr", "list"])
        self.assertNotIn(calls[0][1], {"close", "comment", "edit", "merge", "review"})

    def test_linear_adapter_returns_fixture_and_linked_attachments(self):
        requests = []

        def requester(request):
            requests.append(request)
            return _Response({"data": {"issue": {
                "identifier": "FN-123", "title": "Read-only enrichment", "url": "https://linear.app/acme/issue/FN-123",
                "state": {"name": "In Progress"}, "attachments": {"nodes": [{"url": "https://github.com/acme/report/pull/7", "title": "Ship"}]},
            }}})

        records = LinearReadOnlyAdapter(requester, token="fixture-token").resolve({"identifier": "FN-123"})
        self.assertEqual(records[0]["status"], "In Progress")
        self.assertEqual(records[0]["pull_requests"][0]["title"], "Ship")
        self.assertEqual(requests[0].get_method(), "POST")
        self.assertIn("query DailyWorklogIssue", requests[0].data.decode())


if __name__ == "__main__":
    unittest.main()
