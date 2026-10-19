from splitset_sync.deletions import looks_truncated, vanished


def test_vanished_lists_stored_ids_intervals_no_longer_returns():
    stored = ["i3", "i1", "i2", "i4"]
    assert vanished(stored, ["i1", "i2", "i4", "i9"]) == ["i3"]      # i9 is new, not stored yet
    assert vanished(stored, stored) == []
    assert vanished([], ["i1"]) == []


def test_a_duplicate_deleted_upstream_is_removed():
    week = [f"i{n}" for n in range(8)]
    gone = vanished(week, week[:-1])
    assert gone == ["i7"] and not looks_truncated(len(week), len(gone))


def test_a_mostly_missing_window_looks_truncated():
    assert looks_truncated(10, 6)            # more than half and more than 3: leave everything
    assert not looks_truncated(10, 5)        # half
    assert not looks_truncated(4, 3)         # a short window losing 3 is still believed
    assert looks_truncated(5, 4)
