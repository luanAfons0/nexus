"""Small, read-only boundaries for the GitHub and Linear integrations.

The runtime accepts their normalized JSON contract, while these adapters are
responsible only for fetching that contract.  Both collaborators are
injectable so tests can use fixtures without credentials or network access.
Neither adapter exposes a mutation operation.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any, Callable


class IntegrationAdapterError(RuntimeError):
    """A provider could not return read-only metadata."""


GITHUB_FIELDS = "number,title,state,url,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner"


class GitHubReadOnlyAdapter:
    """Fetch pull-request metadata using only read-only ``gh`` commands."""

    def __init__(self, runner: Callable[..., Any] | None = None) -> None:
        self.runner = runner or subprocess.run

    def resolve(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        repository = str(query.get("repository") or query.get("repo") or "").strip()
        if not repository:
            raise IntegrationAdapterError("GitHub enrichment needs a repository")
        number = query.get("number") or query.get("pull_request")
        branch = query.get("branch") or query.get("head_branch") or query.get("source_branch")
        commit = query.get("commit") or query.get("commit_sha") or query.get("head_sha")
        if number:
            command = ["gh", "pr", "view", str(number), "--repo", repository, "--json", GITHUB_FIELDS]
        elif branch:
            command = ["gh", "pr", "list", "--repo", repository, "--head", str(branch), "--state", "all", "--json", GITHUB_FIELDS]
        elif commit:
            command = ["gh", "api", f"repos/{repository}/commits/{commit}/pulls", "--method", "GET", "--jq", "."]
        else:
            raise IntegrationAdapterError("GitHub enrichment needs a pull request, branch, or commit")
        try:
            result = self.runner(command, capture_output=True, text=True, check=False, timeout=20)
        except (OSError, subprocess.SubprocessError) as exc:
            raise IntegrationAdapterError(f"GitHub read-only query failed: {exc}") from exc
        if getattr(result, "returncode", 1) != 0:
            raise IntegrationAdapterError(str(getattr(result, "stderr", "") or "GitHub read-only query failed").strip())
        try:
            value = json.loads(getattr(result, "stdout", ""))
        except json.JSONDecodeError as exc:
            raise IntegrationAdapterError("GitHub returned invalid JSON") from exc
        records = value if isinstance(value, list) else [value]
        return [record for record in records if isinstance(record, dict)]


class LinearReadOnlyAdapter:
    """Fetch Linear issue and attachment metadata through a read-only query."""

    ENDPOINT = "https://api.linear.app/graphql"
    QUERY = """
      query DailyWorklogIssue($identifier: String!) {
        issue(identifier: $identifier) {
          identifier title url
          state { name }
          attachments { nodes { url title } }
        }
      }
    """

    def __init__(self, requester: Callable[[urllib.request.Request], Any] | None = None, token: str | None = None) -> None:
        self.requester = requester or urllib.request.urlopen
        self.token = token or os.environ.get("LINEAR_API_KEY")

    def resolve(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        identifier = str(query.get("identifier") or query.get("key") or "").strip()
        if not identifier:
            raise IntegrationAdapterError("Linear enrichment needs an issue identifier")
        if not self.token:
            raise IntegrationAdapterError("Linear authentication is unavailable")
        body = json.dumps({"query": self.QUERY, "variables": {"identifier": identifier}}).encode()
        request = urllib.request.Request(self.ENDPOINT, data=body, method="POST", headers={
            "Authorization": self.token, "Content-Type": "application/json",
        })
        try:
            with self.requester(request) as response:
                value = json.loads(response.read().decode())
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise IntegrationAdapterError(f"Linear read-only query failed: {exc}") from exc
        if value.get("errors"):
            raise IntegrationAdapterError("Linear read-only query returned an error")
        issue = (value.get("data") or {}).get("issue")
        if not issue:
            return []
        state = issue.get("state") if isinstance(issue.get("state"), dict) else {}
        attachments = (issue.get("attachments") or {}).get("nodes", [])
        return [{
            "identifier": issue.get("identifier"), "title": issue.get("title"), "url": issue.get("url"),
            "status": state.get("name"), "pull_requests": [item for item in attachments if isinstance(item, dict)],
        }]
