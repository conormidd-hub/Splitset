"""In GitHub Actions, report each failing test as an error annotation, so the reason shows on the
pull request and in the check run without opening the job log."""

from __future__ import annotations

import os
import sys


def _escape(text: str) -> str:
    # workflow-command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def pytest_runtest_logreport(report):
    if os.environ.get("GITHUB_ACTIONS") != "true" or not report.failed:
        return
    lines = [line for line in str(report.longrepr).splitlines() if line.strip()]
    detail = "\n".join(lines[-12:])   # the assertion and its values come last
    sys.__stdout__.write(f"::error title={_escape(report.nodeid)}::{_escape(detail)}\n")
    sys.__stdout__.flush()
