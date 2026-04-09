"""Fetch PR or commit metadata and diff via the `gh` CLI."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse


@dataclass
class ChangeFile:
    path: str
    additions: int
    deletions: int


@dataclass
class ChangeContext:
    """A code change to present — either a PR or a single commit."""

    kind: Literal["pr", "commit"]
    ref: str  # display ref: "PR #42" or short SHA like "885fbd6"
    title: str
    body: str
    author: str
    url: str
    files: list[ChangeFile]
    diff: str
    # PR-only fields; empty for commits.
    number: int = 0
    base_ref: str = ""
    head_ref: str = ""

    def summary_for_prompt(self) -> str:
        """Compact textual summary for stuffing into an LLM prompt."""
        file_lines = "\n".join(
            f"  - {f.path} (+{f.additions}/-{f.deletions})" for f in self.files
        )
        if self.kind == "pr":
            header = (
                f"PR #{self.number}: {self.title}\n"
                f"Author: {self.author}\n"
                f"Branch: {self.head_ref} -> {self.base_ref}\n"
            )
        else:
            header = f"Commit {self.ref}: {self.title}\nAuthor: {self.author}\n"
        return (
            f"{header}"
            f"URL: {self.url}\n\n"
            f"Description:\n{self.body or '(no description)'}\n\n"
            f"Files changed:\n{file_lines}\n"
        )


# Backward-compatible alias (external code may still import PRContext).
PRContext = ChangeContext


def _run_gh(args: list[str]) -> str:
    result = subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gh {' '.join(args)} failed: {result.stderr.strip()}"
        )
    return result.stdout


def fetch_pr(pr_number: int, repo: str | None = None) -> ChangeContext:
    """Fetch a PR's metadata + full diff via the gh CLI.

    If `repo` is None, assumes cwd is inside the target repo.
    """
    fields = "number,title,body,author,baseRefName,headRefName,url,files"
    view_args = ["pr", "view", str(pr_number), "--json", fields]
    diff_args = ["pr", "diff", str(pr_number)]
    if repo:
        view_args.extend(["--repo", repo])
        diff_args.extend(["--repo", repo])

    raw = _run_gh(view_args)
    data = json.loads(raw)
    diff = _run_gh(diff_args)

    files = [
        ChangeFile(
            path=f["path"],
            additions=f.get("additions", 0),
            deletions=f.get("deletions", 0),
        )
        for f in data.get("files", [])
    ]

    return ChangeContext(
        kind="pr",
        ref=f"PR #{data['number']}",
        title=data["title"],
        body=data.get("body") or "",
        author=data["author"]["login"],
        url=data["url"],
        files=files,
        diff=diff,
        number=data["number"],
        base_ref=data["baseRefName"],
        head_ref=data["headRefName"],
    )


_COMMIT_URL_RE = re.compile(
    r"^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/commit/(?P<sha>[0-9a-f]{7,40})"
)
_PR_URL_RE = re.compile(
    r"^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)"
)
_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def parse_ref(arg: str) -> tuple[str, dict]:
    """Classify a user-supplied ref string.

    Returns (kind, payload) where:
      - kind="pr": payload = {"number": int, "repo": str|None}
      - kind="commit": payload = {"sha": str, "repo": str|None}
    """
    arg = arg.strip()
    # Bare integer → PR in current repo.
    if arg.isdigit():
        return "pr", {"number": int(arg), "repo": None}

    # GitHub URLs.
    if arg.startswith(("http://", "https://")):
        parsed = urlparse(arg)
        if parsed.netloc not in ("github.com", "www.github.com"):
            raise ValueError(f"unsupported URL host: {parsed.netloc}")
        m = _PR_URL_RE.match(arg)
        if m:
            return "pr", {
                "number": int(m.group("num")),
                "repo": f"{m.group('owner')}/{m.group('repo')}",
            }
        m = _COMMIT_URL_RE.match(arg)
        if m:
            return "commit", {
                "sha": m.group("sha"),
                "repo": f"{m.group('owner')}/{m.group('repo')}",
            }
        raise ValueError(f"unrecognized GitHub URL: {arg}")

    # Bare SHA → commit in current repo.
    if _SHA_RE.match(arg):
        return "commit", {"sha": arg, "repo": None}

    raise ValueError(
        f"could not classify ref {arg!r} — expected a PR number, SHA, or GitHub URL"
    )


def _current_repo_slug() -> str:
    """Resolve the GitHub owner/repo for the cwd via `gh repo view`."""
    out = _run_gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    return out.strip()


def fetch_commit(sha: str, repo: str | None = None) -> ChangeContext:
    """Fetch commit metadata + diff via the GitHub API (`gh api`).

    If `repo` is None, resolves it from the current working directory's
    linked GitHub repo.
    """
    if repo is None:
        repo = _current_repo_slug()

    raw = _run_gh(["api", f"repos/{repo}/commits/{sha}"])
    data = json.loads(raw)

    full_sha = data["sha"]
    short_sha = full_sha[:7]
    message = data["commit"]["message"]
    title, _, body = message.partition("\n")
    body = body.lstrip("\n")

    author_info = data.get("author") or {}
    author = author_info.get("login") or data["commit"]["author"]["name"]

    files_data = data.get("files", [])
    files = [
        ChangeFile(
            path=f["filename"],
            additions=f.get("additions", 0),
            deletions=f.get("deletions", 0),
        )
        for f in files_data
    ]

    # Reconstruct a unified diff by concatenating each file's patch with a
    # `diff --git` header so downstream prompts see familiar formatting.
    diff_chunks: list[str] = []
    for f in files_data:
        patch = f.get("patch")
        if not patch:
            continue
        path = f["filename"]
        diff_chunks.append(
            f"diff --git a/{path} b/{path}\n"
            f"--- a/{path}\n+++ b/{path}\n"
            f"{patch}\n"
        )
    diff = "".join(diff_chunks)

    return ChangeContext(
        kind="commit",
        ref=short_sha,
        title=title,
        body=body,
        author=author,
        url=data.get("html_url", f"https://github.com/{repo}/commit/{full_sha}"),
        files=files,
        diff=diff,
    )
