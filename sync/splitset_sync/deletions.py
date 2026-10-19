"""Activities deleted on intervals.icu.

A sync fetches every activity in its date window. Stored activities in that window that
intervals.icu no longer returns were deleted there (a duplicate import, an accidental recording),
so the sync deletes them too and they stop counting: run stats, PBs, the recovery map (their
activity_details, efforts and workout_muscle_loads rows go with them, on delete cascade).

Pure, so it is tested without a database; db.activity_ids_in_window and db.delete_activities do
the reading and writing.
"""

from __future__ import annotations

from collections.abc import Iterable


def vanished(stored: Iterable[str], fetched_ids: Iterable[str]) -> list[str]:
    """Stored activity ids that intervals.icu didn't return, sorted."""
    keep = set(fetched_ids)
    return sorted(i for i in stored if i not in keep)


def looks_truncated(stored_count: int, gone: int) -> bool:
    """More than half of the window disappearing at once (and more than 3 activities) looks like a
    partial response rather than deletions, so the sync then removes nothing and says so."""
    return gone > 3 and gone * 2 > stored_count
