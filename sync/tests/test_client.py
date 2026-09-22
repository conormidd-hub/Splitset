import pytest
import responses

from splitset_sync.intervals_client import (API_ROOT, IntervalsAuthError, IntervalsClient, IntervalsError,
                                            normalise_athlete_id)


def test_athlete_id_gets_its_leading_i():
    assert normalise_athlete_id("123456") == "i123456"
    assert normalise_athlete_id(" i123456 ") == "i123456"
    assert normalise_athlete_id(123456) == "i123456"


@responses.activate
def test_fetch_activities_sends_window_and_basic_auth():
    responses.get(f"{API_ROOT}/athlete/i1/activities", json=[{"id": "i9"}])
    with IntervalsClient("1", "secret") as c:
        acts = c.fetch_activities("2026-01-01", "2026-02-01")
    assert acts == [{"id": "i9"}]
    req = responses.calls[0].request
    assert "oldest=2026-01-01" in req.url and "newest=2026-02-01" in req.url
    assert req.headers["Authorization"].startswith("Basic ")


@responses.activate
def test_401_raises_auth_error():
    responses.get(f"{API_ROOT}/athlete/i1/activities", status=401)
    with pytest.raises(IntervalsAuthError):
        IntervalsClient("i1", "bad").fetch_activities("2026-01-01", "2026-02-01")


@responses.activate
def test_403_raises_auth_error_on_wellness():
    responses.get(f"{API_ROOT}/athlete/i1/wellness", status=403)
    with pytest.raises(IntervalsAuthError):
        IntervalsClient("i1", "bad").fetch_wellness("2026-01-01", "2026-02-01")


@responses.activate
def test_streams_404_returns_none():
    responses.get(f"{API_ROOT}/activity/i9/streams", status=404)
    assert IntervalsClient("i1", "k").fetch_streams("i9") is None


@responses.activate
def test_streams_ok_returns_list():
    responses.get(f"{API_ROOT}/activity/i9/streams", json=[{"type": "time", "data": [0, 1]}])
    assert IntervalsClient("i1", "k").fetch_streams("i9") == [{"type": "time", "data": [0, 1]}]


@responses.activate
def test_server_error_raises_plain_error():
    responses.get(f"{API_ROOT}/athlete/i1/activities", status=500, body="boom")
    with pytest.raises(IntervalsError):
        IntervalsClient("i1", "k").fetch_activities("2026-01-01", "2026-02-01")


@responses.activate
def test_non_list_payload_raises():
    responses.get(f"{API_ROOT}/athlete/i1/activities", json={"error": "nope"})
    with pytest.raises(IntervalsError):
        IntervalsClient("i1", "k").fetch_activities("2026-01-01", "2026-02-01")
