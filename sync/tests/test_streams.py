import numpy as np

from splitset_sync.streams import (best_efforts, derive_details, downsample, encode_polyline,
                                   km_splits, simplify_route)


def steady_run(km: float = 5.0, pace_s_per_km: float = 300.0, hz: int = 1):
    """A perfectly even run sampled at `hz`: returns (tsec, dist) arrays."""
    total_s = km * pace_s_per_km
    tsec = np.arange(0, total_s + 1e-9, 1 / hz)
    dist = tsec * (1000.0 / pace_s_per_km)
    return tsec, dist


def as_streams(tsec, dist, hr=None, alt=None, lat=None, lng=None):
    out = [{"type": "time", "data": [float(t) for t in tsec]},
           {"type": "distance", "data": [float(d) for d in dist]}]
    if hr is not None:
        out.append({"type": "heartrate", "data": list(hr)})
    if alt is not None:
        out.append({"type": "altitude", "data": list(alt)})
    if lat is not None:
        out.append({"type": "latlng", "data": list(lat), "data2": list(lng)})
    return out


def test_best_efforts_on_even_5k():
    tsec, dist = steady_run()
    eff = best_efforts(dist, tsec)
    assert eff["1000"] == 300.0
    assert eff["1609"] == 482.8
    assert eff["3000"] == 900.0
    assert eff["5000"] == 1500.0
    assert "10000" not in eff


def test_km_splits_on_even_5k_with_hr_and_climb():
    tsec, dist = steady_run()
    hr = np.full(len(tsec), 150.0)
    alt = np.linspace(0, 50, len(tsec))          # 10 m up per km
    splits = km_splits(dist, tsec, hr, alt)
    assert [s["k"] for s in splits] == [1, 2, 3, 4, 5]
    assert all(s["t"] == 300.0 for s in splits)
    assert all(s["hr"] == 150 for s in splits)
    assert all(s["el"] == 10 for s in splits)


def test_km_splits_without_hr_or_alt():
    tsec, dist = steady_run(km=2.5)
    splits = km_splits(dist, tsec, None, None)
    assert len(splits) == 2
    assert splits[0]["hr"] is None and splits[0]["el"] is None


def test_polyline_matches_google_reference_vector():
    pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    assert encode_polyline(pts) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_simplify_route_spacing_and_endpoints():
    n = 1000
    dist = np.arange(n, dtype=float)                 # one metre per sample
    pts = [(0.0 + i * 1e-5, 0.0) for i in range(n)]
    route = simplify_route(pts, dist)
    assert route[0] == pts[0] and route[-1] == pts[-1]
    assert len(route) <= n / 12 + 2


def test_derive_details_forces_monotonic_distance():
    tsec, dist = steady_run()
    dist = dist.copy()
    dist[700] = dist[690] - 5                        # GPS jitter stepping backwards
    rec = derive_details(as_streams(tsec, dist), "i1")
    assert rec["has_streams"]
    assert len(rec["splits"]) == 5


def test_derive_details_builds_route_with_gaps():
    tsec, dist = steady_run()
    n = len(tsec)
    lat = [None if i % 50 == 3 else -37.8 + i * 1e-5 for i in range(n)]
    lng = [None if i % 50 == 3 else 144.9 + i * 1e-5 for i in range(n)]
    rec = derive_details(as_streams(tsec, dist, lat=lat, lng=lng), "i2")
    assert rec["polyline"]
    lo_lat, lo_lng, hi_lat, hi_lng = rec["bbox"]
    assert lo_lat < hi_lat and lo_lng < hi_lng
    assert abs(lo_lat - (-37.8)) < 1e-4 and abs(hi_lng - (144.9 + (n - 1) * 1e-5)) < 1e-4


def test_derive_details_no_streams_when_short_or_missing():
    assert derive_details(None, "i3")["has_streams"] is False
    assert derive_details([], "i3")["has_streams"] is False
    tsec, dist = steady_run(km=0.005)                # 1.5 s of data
    assert derive_details(as_streams(tsec, dist), "i3")["has_streams"] is False
    misaligned = [{"type": "time", "data": list(range(100))}, {"type": "distance", "data": list(range(50))}]
    assert derive_details(misaligned, "i3")["has_streams"] is False


def test_derive_details_drops_misaligned_hr():
    tsec, dist = steady_run(km=1.0)
    streams = as_streams(tsec, dist) + [{"type": "heartrate", "data": [140] * 10}]
    rec = derive_details(streams, "i4")
    assert rec["splits"][0]["hr"] is None


def test_downsample_every_10s():
    tsec, dist = steady_run()
    s = downsample(tsec, dist, None, None, 10)
    assert s["t"][:3] == [0, 10, 20] and s["t"][-1] == 1500
    assert len(s["t"]) == 151 and len(s["d"]) == 151
    assert s["hr"] is None and s["alt"] is None
    assert downsample(tsec, dist, None, None, 0) is None


def test_downsample_keeps_nulls():
    tsec, dist = steady_run(km=0.1)
    hr = np.full(len(tsec), np.nan)
    hr[0] = 120
    s = downsample(tsec, dist, hr, None, 10)
    assert s["hr"][0] == 120 and s["hr"][1] is None
