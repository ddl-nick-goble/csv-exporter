"""Unit tests for pure helpers in app.py.

These functions don't reach upstream — they're list/dict shape adapters,
a JWT TTL decoder, and a small policy-ref enumerator. Together they
cover the logic layer that drives every request handler.
"""
import base64
import json
import time

import pytest

import app


# ── _unwrap_list ──────────────────────────────────────────────────────────────
class TestUnwrapList:
    def test_list_passthrough(self):
        assert app._unwrap_list([1, 2, 3], ["projects"]) == [1, 2, 3]

    def test_dict_first_matching_key(self):
        data = {"projects": [{"id": "p"}], "data": [{"id": "x"}]}
        assert app._unwrap_list(data, ["projects", "data"]) == [{"id": "p"}]

    def test_dict_falls_through_keys(self):
        data = {"items": [{"id": "i"}]}
        assert app._unwrap_list(data, ["projects", "data", "items"]) == [{"id": "i"}]

    def test_dict_no_matching_key_returns_empty(self):
        assert app._unwrap_list({"other": [1]}, ["projects"]) == []

    def test_dict_matching_key_not_a_list(self):
        assert app._unwrap_list({"projects": "oops"}, ["projects"]) == []

    def test_none_returns_empty(self):
        assert app._unwrap_list(None, ["projects"]) == []

    def test_string_returns_empty(self):
        assert app._unwrap_list("nope", ["projects"]) == []


# ── _jwt_ttl ──────────────────────────────────────────────────────────────────
def _make_jwt(payload):
    """Build a JWT-shaped string the helper can decode. Only the middle
    segment is parsed; header and signature are ignored."""
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{encoded}.sig"


class TestJwtTtl:
    def test_returns_seconds_until_exp(self):
        token = _make_jwt({"exp": time.time() + 600})
        ttl = app._jwt_ttl(token, default=1.0)
        assert 590 < ttl < 605, "should return ~600s minus a couple of seconds clock drift"

    def test_expired_token_returns_floor(self):
        token = _make_jwt({"exp": time.time() - 100})
        # The helper clamps the floor to 30 so the cache always gets a small
        # positive lifetime even on expired-at-mint tokens.
        assert app._jwt_ttl(token, default=999.0) == 30.0

    def test_missing_exp_returns_default(self):
        token = _make_jwt({"sub": "u"})
        assert app._jwt_ttl(token, default=240.0) == 240.0

    def test_malformed_token_returns_default(self):
        assert app._jwt_ttl("not-a-jwt", default=99.0) == 99.0


# ── _bundle_policy_refs ───────────────────────────────────────────────────────
class TestBundlePolicyRefs:
    def test_modern_policies_field(self):
        bundle = {"policies": [
            {"policyId": "a", "policyVersionId": "av"},
            {"policyId": "b", "policyVersionId": "bv"},
        ]}
        refs = app._bundle_policy_refs(bundle)
        assert refs == [
            {"policyId": "a", "policyVersionId": "av"},
            {"policyId": "b", "policyVersionId": "bv"},
        ]

    def test_dedup_within_policies(self):
        bundle = {"policies": [
            {"policyId": "a", "policyVersionId": "v1"},
            {"policyId": "a", "policyVersionId": "v1"},
        ]}
        assert app._bundle_policy_refs(bundle) == [
            {"policyId": "a", "policyVersionId": "v1"},
        ]

    def test_dedup_treats_different_versions_as_different_refs(self):
        bundle = {"policies": [
            {"policyId": "a", "policyVersionId": "v1"},
            {"policyId": "a", "policyVersionId": "v2"},
        ]}
        assert app._bundle_policy_refs(bundle) == [
            {"policyId": "a", "policyVersionId": "v1"},
            {"policyId": "a", "policyVersionId": "v2"},
        ]

    def test_skips_entries_without_policy_id(self):
        bundle = {"policies": [{"policyVersionId": "vv"}, {"policyId": "good"}]}
        assert app._bundle_policy_refs(bundle) == [
            {"policyId": "good", "policyVersionId": None},
        ]

    def test_legacy_top_level_policy_id_fallback(self):
        bundle = {"policyId": "legacy", "policyVersionId": "v"}
        assert app._bundle_policy_refs(bundle) == [
            {"policyId": "legacy", "policyVersionId": "v"},
        ]

    def test_modern_field_wins_over_legacy(self):
        bundle = {
            "policyId": "legacy",
            "policies": [{"policyId": "modern", "policyVersionId": "v"}],
        }
        assert app._bundle_policy_refs(bundle) == [
            {"policyId": "modern", "policyVersionId": "v"},
        ]

    def test_no_policies_returns_empty(self):
        assert app._bundle_policy_refs({}) == []


# ── _projects_from_bundles ────────────────────────────────────────────────────
class TestProjectsFromBundles:
    def test_groups_bundles_by_project(self):
        bundles = [
            {"projectId": "p1", "projectName": "Alpha", "projectOwner": "nick"},
            {"projectId": "p1", "projectName": "Alpha", "projectOwner": "nick"},
            {"projectId": "p2", "projectName": "Beta",  "projectOwner": "jane"},
        ]
        out = sorted(app._projects_from_bundles(bundles), key=lambda p: p["id"])
        assert out == [
            {"id": "p1", "name": "Alpha", "owner_username": "nick"},
            {"id": "p2", "name": "Beta",  "owner_username": "jane"},
        ]

    def test_skips_bundles_without_project_id(self):
        bundles = [
            {"projectName": "ghost"},                    # no id
            {"projectId": "p1", "projectName": "real"},  # ok
        ]
        out = app._projects_from_bundles(bundles)
        assert [p["id"] for p in out] == ["p1"]

    def test_falls_back_to_unnamed(self):
        bundles = [{"projectId": "p1"}]
        out = app._projects_from_bundles(bundles)
        assert out[0]["name"] == "(unnamed)"
        assert out[0]["owner_username"] == ""

    def test_picks_up_nested_project_id_shape(self):
        bundles = [{"project": {"id": "p1"}, "projectName": "n"}]
        out = app._projects_from_bundles(bundles)
        assert [p["id"] for p in out] == ["p1"]

    def test_empty_input(self):
        assert app._projects_from_bundles([]) == []


# ── _fetch_evidence_for_bundle ────────────────────────────────────────────────
class TestFetchEvidenceForBundle:
    def test_no_policy_refs(self, monkeypatch):
        monkeypatch.setattr(app, "_compute_policy", lambda *a, **kw: pytest.fail("should not call"))
        bid, computed = app._fetch_evidence_for_bundle({"id": "b1"})
        assert bid == "b1"
        assert computed == []

    def test_single_policy(self, monkeypatch):
        calls = []

        def fake(bid, pid, ver):
            calls.append((bid, pid, ver))
            return {"policy": {"id": pid}, "results": []}

        monkeypatch.setattr(app, "_compute_policy", fake)
        bid, computed = app._fetch_evidence_for_bundle({
            "id": "b1",
            "policies": [{"policyId": "p1", "policyVersionId": "v1"}],
        })
        assert bid == "b1"
        assert calls == [("b1", "p1", "v1")]
        assert len(computed) == 1

    def test_multi_policy_fans_out(self, monkeypatch):
        seen_pids = set()

        def fake(bid, pid, ver):
            seen_pids.add(pid)
            return {"policy": {"id": pid}}

        monkeypatch.setattr(app, "_compute_policy", fake)
        bid, computed = app._fetch_evidence_for_bundle({
            "id": "b1",
            "policies": [
                {"policyId": "p1", "policyVersionId": "v1"},
                {"policyId": "p2", "policyVersionId": "v2"},
                {"policyId": "p3", "policyVersionId": "v3"},
            ],
        })
        assert seen_pids == {"p1", "p2", "p3"}
        assert len(computed) == 3

    def test_skips_policies_that_return_none(self, monkeypatch):
        def fake(bid, pid, ver):
            return None if pid == "blocked" else {"policy": {"id": pid}}

        monkeypatch.setattr(app, "_compute_policy", fake)
        bid, computed = app._fetch_evidence_for_bundle({
            "id": "b",
            "policies": [
                {"policyId": "ok", "policyVersionId": "v"},
                {"policyId": "blocked", "policyVersionId": "v"},
            ],
        })
        ids = sorted(c["policy"]["id"] for c in computed)
        assert ids == ["ok"]

    def test_per_policy_exception_does_not_abort_others(self, monkeypatch):
        def fake(bid, pid, ver):
            if pid == "boom":
                raise RuntimeError("upstream blew up")
            return {"policy": {"id": pid}}

        monkeypatch.setattr(app, "_compute_policy", fake)
        bid, computed = app._fetch_evidence_for_bundle({
            "id": "b",
            "policies": [
                {"policyId": "ok1", "policyVersionId": "v"},
                {"policyId": "boom", "policyVersionId": "v"},
                {"policyId": "ok2", "policyVersionId": "v"},
            ],
        })
        ids = sorted(c["policy"]["id"] for c in computed)
        assert ids == ["ok1", "ok2"]


# ── _fetch_policies_for_bundles ───────────────────────────────────────────────
class TestFetchPoliciesForBundles:
    def test_dedupes_policy_ids_across_bundles(self, monkeypatch):
        fetched = []

        def fake(pid):
            fetched.append(pid)
            return {"id": pid, "name": pid}

        monkeypatch.setattr(app, "_fetch_policy", fake)
        bundles = [
            {"policies": [{"policyId": "a"}, {"policyId": "b"}]},
            {"policies": [{"policyId": "b"}, {"policyId": "c"}]},
        ]
        out = app._fetch_policies_for_bundles(bundles)
        assert sorted(p["id"] for p in out) == ["a", "b", "c"]
        # Each unique pid fetched exactly once.
        assert sorted(fetched) == ["a", "b", "c"]

    def test_skips_none_returns(self, monkeypatch):
        monkeypatch.setattr(app, "_fetch_policy",
                            lambda pid: None if pid == "denied" else {"id": pid})
        bundles = [{"policies": [{"policyId": "ok"}, {"policyId": "denied"}]}]
        out = app._fetch_policies_for_bundles(bundles)
        assert [p["id"] for p in out] == ["ok"]

    def test_swallows_individual_fetch_errors(self, monkeypatch):
        def fake(pid):
            if pid == "boom":
                raise RuntimeError("network!")
            return {"id": pid}

        monkeypatch.setattr(app, "_fetch_policy", fake)
        bundles = [{"policies": [{"policyId": "ok"}, {"policyId": "boom"}]}]
        out = app._fetch_policies_for_bundles(bundles)
        assert [p["id"] for p in out] == ["ok"]

    def test_empty_input(self, monkeypatch):
        monkeypatch.setattr(app, "_fetch_policy",
                            lambda pid: pytest.fail("should not fetch"))
        assert app._fetch_policies_for_bundles([]) == []
