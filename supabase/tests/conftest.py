"""In GitHub Actions, report each failing test, and any test file that fails to load, as an error
annotation, plus a one-line summary, so the reason shows on the pull request and in the check
run without opening the job log."""

from __future__ import annotations

import os
import sys

IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"


def _escape(text: str, prop: bool = False) -> str:
    # workflow-command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
    text = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return text.replace(":", "%3A").replace(",", "%2C") if prop else text


def _annotate(level: str, title: str, longrepr: object) -> None:
    lines = [line for line in str(longrepr).splitlines() if line.strip()]
    detail = "\n".join(lines[-12:])   # the assertion and its values come last
    sys.__stdout__.write(f"::{level} title={_escape(title, prop=True)}::{_escape(detail)}\n")
    sys.__stdout__.flush()


def pytest_runtest_logreport(report):
    if IN_ACTIONS and report.failed:
        _annotate("error", f"{report.nodeid} ({report.when})", report.longrepr)


def pytest_collectreport(report):
    if IN_ACTIONS and report.failed:
        _annotate("error", f"could not load {report.nodeid}", report.longrepr)


def pytest_sessionfinish(session, exitstatus):
    if IN_ACTIONS:
        _annotate("notice", "pytest", f"exit {int(exitstatus)}: {session.testscollected} collected, {session.testsfailed} failed")
