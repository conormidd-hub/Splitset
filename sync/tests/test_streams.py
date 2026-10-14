import numpy as np

from splitset_sync.streams import (best_efforts, derive_details, downsample, encode_polyline,
                                   km_splits, simplify_route, simplify_route_indices)


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


# ---------------------------------------------------------------- cadence, route_d

def decode_polyline(encoded: str, precision: int = 5) -> list[tuple[float, float]]:
    """Reference decoder for the tests only (the app uses @mapbox/polyline)."""
    factor = 10 ** precision
    out: list[tuple[float, float]] = []
    lat = lng = 0
    i = 0
    while i < len(encoded):
        vals = []
        for _ in range(2):
            result = shift = 0
            while True:
                b = ord(encoded[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lng += vals[1]
        out.append((lat / factor, lng / factor))
    return out


def test_decoder_round_trips_the_encoder():
    pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    assert decode_polyline(encode_polyline(pts)) == pts


def test_downsample_always_has_a_cad_key():
    tsec, dist = steady_run()
    s = downsample(tsec, dist, None, None, 10)
    assert "cad" in s and s["cad"] is None
    assert set(s) == {"t", "d", "hr", "alt", "cad"}


def test_downsample_cad_ints_with_zero_as_null():
    tsec, dist = steady_run(km=0.2)                  # 60 s -> samples at 0, 10, ..., 60
    cad = np.full(len(tsec), 171.4)
    cad[0] = 0                                       # standing at the start
    cad[20] = np.nan                                 # dropout
    s = downsample(tsec, dist, None, None, 10, cad=cad)
    assert s["cad"][0] is None and s["cad"][2] is None
    assert s["cad"][1] == 171 and all(isinstance(v, int) for v in s["cad"] if v is not None)
    assert len(s["cad"]) == len(s["t"])


def test_derive_details_doubles_per_leg_cadence_for_runs_only():
    tsec, dist = steady_run(km=1.0)
    n = len(tsec)
    per_leg = [0] * 5 + [85 + (i % 3) for i in range(n - 5)]
    streams = as_streams(tsec, dist) + [{"type": "cadence", "data": per_leg}]
    run = derive_details(streams, "i5", is_run=True)["samples"]["cad"]
    ride = derive_details(streams, "i5", is_run=False)["samples"]["cad"]
    default = derive_details(streams, "i5")["samples"]["cad"]
    assert run[0] is None and ride[0] is None                     # the zero at t=0
    assert all(170 <= v <= 174 for v in run[1:])
    assert all(85 <= v <= 87 for v in ride[1:])
    assert default == ride                                        # is_run defaults to False


def test_derive_details_keeps_full_step_cadence_for_runs():
    tsec, dist = steady_run(km=1.0)
    full = [172] * len(tsec)
    streams = as_streams(tsec, dist) + [{"type": "cadence", "data": full}]
    cad = derive_details(streams, "i6", is_run=True)["samples"]["cad"]
    assert all(v == 172 for v in cad)


def test_derive_details_cad_is_null_without_a_cadence_stream():
    tsec, dist = steady_run(km=1.0)
    s = derive_details(as_streams(tsec, dist), "i7", is_run=True)["samples"]
    assert "cad" in s and s["cad"] is None


def test_derive_details_drops_misaligned_cadence():
    tsec, dist = steady_run(km=1.0)
    streams = as_streams(tsec, dist) + [{"type": "cadence", "data": [85] * 10}]
    assert derive_details(streams, "i8", is_run=True)["samples"]["cad"] is None


def test_simplify_route_indices_are_increasing_and_match_simplify_route():
    n = 1000
    dist = np.arange(n, dtype=float)
    pts = [(0.0 + i * 1e-5, 0.0) for i in range(n)]
    keep = simplify_route_indices(pts, dist)
    assert keep[0] == 0 and keep[-1] == n - 1
    assert all(b > a for a, b in zip(keep, keep[1:]))
    assert simplify_route(pts, dist) == [pts[i] for i in keep]


def test_route_d_has_one_entry_per_polyline_point_and_is_monotonic():
    tsec, dist = steady_run()
    n = len(tsec)
    lat = [None if i % 50 == 3 else -37.8 + i * 1e-5 for i in range(n)]
    lng = [None if i % 50 == 3 else 144.9 + i * 1e-5 for i in range(n)]
    rec = derive_details(as_streams(tsec, dist, lat=lat, lng=lng), "i9")
    route_d = rec["samples"]["route_d"]
    assert len(route_d) == len(decode_polyline(rec["polyline"]))
    assert route_d[0] == 0 and route_d[-1] == int(dist[-1])
    assert all(b >= a for a, b in zip(route_d, route_d[1:]))
    assert all(isinstance(v, int) for v in route_d)


def test_route_d_survives_the_point_cap_on_a_long_run():
    tsec, dist = steady_run(km=30.0)                 # ~2500 points at 12 m -> capped at 1801
    n = len(tsec)
    lat = [-37.8 + i * 1e-5 for i in range(n)]
    lng = [144.9 + i * 1e-5 for i in range(n)]
    rec = derive_details(as_streams(tsec, dist, lat=lat, lng=lng), "i10")
    pts = decode_polyline(rec["polyline"])
    route_d = rec["samples"]["route_d"]
    assert len(pts) == 1801 and len(route_d) == 1801
    assert all(b > a for a, b in zip(route_d, route_d[1:]))
    assert route_d[-1] == int(dist[-1])


def test_route_d_absent_without_a_route_or_without_samples():
    tsec, dist = steady_run(km=1.0)
    assert "route_d" not in derive_details(as_streams(tsec, dist), "i11")["samples"]
    n = len(tsec)
    lat = [-37.8 + i * 1e-5 for i in range(n)]
    lng = [144.9 + i * 1e-5 for i in range(n)]
    rec = derive_details(as_streams(tsec, dist, lat=lat, lng=lng), "i12", sample_every_s=0)
    assert rec["polyline"] and rec["samples"] is None
