from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import contextlib
import io
import json
import shutil
import tempfile
import time
import unittest

import discovery_audit as da

SECRET = "AcmeSecretCustomer"
SENT = "SENTINEL_ACME_XYZ"
CTX = {"instance": "default", "enabledCompanyIds": [1878, 2],
       "defaultCompanyId": 2, "includeArchived": True, "brokerRevision": "dev"}


def cap(i, op="search", model="res.partner", extra_req=None, rows=None, resp=None,
        err=False, cat="2026-10-10 11:00:00 UTC", ctx=None):
    req = {"model": model}
    if extra_req:
        req.update(extra_req)
    if resp is None:
        resp = [rows if rows is not None else []]
    return {"schemaVersion": 1, "id": f"capture-{i:03d}", "capturedAtUtc": cat,
            "operation": op, "request": req,
            "context": dict(CTX) if ctx is None else ctx,
            "isError": err, "response": resp}


def evcap(i, payload, meta=None, kind="attachments", **kw):
    resp = [payload] if meta is None else [payload, meta]
    return cap(i, op="evidence", resp=resp, extra_req={"kind": kind}, **kw)


class T(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp())
        self.repo = self.t / "repo"
        self.ind = self.repo / "private" / "odoo-discovery"
        self.ind.mkdir(parents=True)
        self._old = da.REPO
        da.REPO = self.repo
        self.out = self.repo / "private" / "manifest.json"

    def tearDown(self):
        da.REPO = self._old
        shutil.rmtree(self.t, ignore_errors=True)

    def w(self, name, obj=None, raw=None):
        p = self.ind / name
        p.write_bytes(raw if raw is not None else json.dumps(obj).encode())
        return p

    def cli(self, *a):
        return da.main(list(a))

    def run_cli(self, *a):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = da.main(list(a))
        return rc, out.getvalue(), err.getvalue()

    def manifest(self):
        return json.loads(self.out.read_text())

    def test_malformed(self):
        self.w("capture-001.json", raw=b"{not json")
        self.w("capture-002.json", cap(2))
        rc, _, _ = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        m = self.manifest()
        e1 = [c for c in m["captures"] if c["file"] == "capture-001.json"][0]
        self.assertIn("malformed JSON", e1["validationErrors"])
        self.assertEqual(e1["pagination"]["completeness"], "unknown")

    def test_duplicate(self):
        self.w("capture-001.json", cap(1))
        d = cap(1)
        self.w("capture-002.json", d)  # same id, different stem
        rc = self.cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertFalse(self.out.exists())

    def test_short_and_full_page_unknown(self):
        full = [{"id": i + 1, "name": "x"} for i in range(5)]
        short = [{"id": 1}]
        self.w("capture-001.json", cap(1, extra_req={"limit": 5, "offset": 0}, rows=full))
        self.w("capture-002.json", cap(2, extra_req={"limit": 5, "offset": 0}, rows=short))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        m = self.manifest()
        for c in m["captures"]:
            self.assertEqual(c["pagination"]["completeness"], "unknown")
            self.assertEqual(c["pagination"]["reason"], "no-explicit-paging")
        self.assertEqual([c["pagination"]["rowCount"] for c in m["captures"]], [5, 1])

    def test_search_count_meta_never_complete(self):
        # count == 1 metadata is never the underlying count
        self.w("capture-001.json", cap(1, rows=[{"id": 1}], resp=[[{"id": 1}], {"count": 1}]))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        c = self.manifest()["captures"][0]
        self.assertEqual(c["pagination"]["completeness"], "unknown")

    def test_error_presence_no_text(self):
        self.w("capture-001.json", cap(1, err=True, resp=["boom-secret-failure-text"]))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        m = self.manifest()
        c = m["captures"][0]
        self.assertTrue(c["errorPresence"])
        self.assertNotIn("boom-secret-failure-text", self.out.read_text())

    def test_evidence_attachment_shapes(self):
        rows = [{"id": 1}, {"id": 2}]
        self.w("capture-001.json", evcap(1, {"rows": rows, "offset": 0, "has_more": False}))
        self.w("capture-002.json", evcap(2, {"rows": rows, "offset": 0, "has_more": True}))
        self.w("capture-003.json", evcap(3, {"rows": rows, "offset": 5, "has_more": False}))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        m = self.manifest()
        by = {c["file"]: c for c in m["captures"]}
        self.assertEqual(by["capture-001.json"]["pagination"]["completeness"], "complete")
        self.assertEqual(by["capture-002.json"]["pagination"]["completeness"], "incomplete")
        self.assertNotEqual(by["capture-003.json"]["pagination"]["completeness"], "complete")

    def test_evidence_chatter_shapes(self):
        rows = [{"id": 1}, {"id": 2}]
        self.w("capture-001.json", evcap(1, {"rows": rows, "offset": 0, "complete": True,
                                             "has_more": False, "visible_total": 2}, kind="chatter"))
        self.w("capture-002.json", evcap(2, {"rows": [{"id": 1}], "offset": 0,
                                             "has_more": False, "complete": True, "visible_total": 5}, kind="chatter"))
        self.w("capture-003.json", evcap(3, {"rows": rows, "offset": 3, "complete": True,
                                             "visible_total": 2}, kind="chatter"))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        m = self.manifest()
        by = {c["file"]: c for c in m["captures"]}
        self.assertEqual(by["capture-001.json"]["pagination"]["completeness"], "complete")
        self.assertEqual(by["capture-002.json"]["pagination"]["completeness"], "unknown")
        self.assertNotEqual(by["capture-003.json"]["pagination"]["completeness"], "complete")

    def test_evidence_tracking_always_unknown(self):
        payload = {"rows": [{"id": 1}], "offset": 0, "tracking_offset": 0,
                   "has_more": False, "next_offset": -1, "may_have_more_messages": True,
                   "next_message_offset": 100, "message_visible_total": 101,
                   "source_message_ids": [1]}
        self.w("capture-001.json", evcap(1, payload, kind="tracking"))
        self.w("capture-002.json", evcap(2, payload, {"has_more": False}, kind="tracking"))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        for c in self.manifest()["captures"]:
            self.assertEqual(c["pagination"]["completeness"], "unknown")

    def test_invalid_capture_never_complete(self):
        invalid = evcap(1, {"rows": [{"id": 1}], "offset": 0, "has_more": False})
        invalid["schemaVersion"] = True
        self.w("capture-001.json", invalid)
        malformed_op = cap(2)
        malformed_op["operation"] = []
        self.w("capture-002.json", malformed_op)
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 2)
        for capture in self.manifest()["captures"]:
            self.assertEqual(capture["pagination"]["completeness"], "unknown")

    def test_determinism(self):
        self.w("capture-002.json", cap(2, rows=[{"id": 2, "name": SECRET}]))
        self.w("capture-001.json", cap(1, rows=[{"id": 1}]))
        o2 = self.repo / "private" / "m2.json"
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        first = self.out.read_bytes()
        self.assertNotIn(b"generatedAtUtc", first)
        time.sleep(1.05)
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(o2)), 0)
        self.assertEqual(first, o2.read_bytes())

    def test_bytecode_caches_ignored(self):
        self.w("capture-001.json", cap(1))
        cache = self.ind / "__pycache__"
        cache.mkdir()
        (cache / "capture-999.json").write_text(json.dumps(cap(999)))
        (cache / "mod.pyc").write_bytes(b"\x00")
        (self.ind / "stray.pyc").write_bytes(b"\x00")
        pcache = self.ind / ".pytest_cache"
        pcache.mkdir()
        (pcache / "capture-998.json").write_text(json.dumps(cap(998)))
        rc = self.cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 0)
        m = self.manifest()
        self.assertEqual(m["fileCount"], 1)

    def test_privacy(self):
        rows = [{"id": 1, "name": SECRET, "ref": SECRET}]
        self.w("capture-001.json", cap(1, extra_req={"domain": [["name", "=", SECRET]],
                                   "fields": ["name"]}, rows=rows))
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(self.out)), 0)
        txt = self.out.read_text()
        self.assertNotIn(SECRET, txt)
        # hashes present instead of literals
        c = self.manifest()["captures"][0]
        self.assertTrue(c["queryHash"] and c["domainHash"])

    def test_sentinel_no_disclosure(self):
        bad = cap(1, extra_req={"order": SENT},
                  cat=SENT, resp=[SENT])
        bad["id"] = SENT
        self.w("capture-001.json", bad)
        dup = cap(2)
        dup["id"] = SENT
        self.w("capture-002.json", dup)
        sent_file = self.ind / ("capture-" + SENT + ".json")
        sent_file.write_bytes(json.dumps(cap(7)).encode())
        rc, so, se = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertNotIn(SENT, so + se)
        self.assertFalse(self.out.exists())  # duplicate path: no manifest
        (self.ind / "capture-002.json").unlink()  # drop duplicate; exercise bad values
        rc, so, se = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        blob = so + se + self.out.read_text()
        self.assertNotIn(SENT, blob)
        self.assertIn("queryHash", blob)

    def test_strict_validation(self):
        bodies = {
            "capture-001.json": cap(1, cat="not a time"),
            "capture-002.json": dict(cap(2), schemaVersion=True),
            "capture-003.json": cap(3, ctx={"instance": "", "enabledCompanyIds": [],
                                            "defaultCompanyId": 9, "includeArchived": "yes",
                                            "brokerRevision": ""}),
            "capture-004.json": cap(4, op="count", resp=[{"n": 3}]),
            "capture-005.json": cap(5, op="count", resp=[True]),
            "capture-006.json": cap(6, model="NoDotModel"),
            "capture-007.json": cap(7),
        }
        bodies["capture-007.json"]["id"] = "capture-999"
        for n, b in bodies.items():
            self.w(n, b)
        rc, _, _ = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        m = self.manifest()  # diagnostic manifest still written
        by = {c["file"]: c for c in m["captures"]}
        self.assertIn("invalid capturedAtUtc", by["capture-001.json"]["validationErrors"])
        self.assertIn("unsupported schemaVersion", by["capture-002.json"]["validationErrors"])
        self.assertIn("invalid context", by["capture-003.json"]["validationErrors"])
        self.assertIn("invalid count payload", by["capture-004.json"]["validationErrors"])
        self.assertIn("invalid count payload", by["capture-005.json"]["validationErrors"])
        self.assertIn("invalid request.model", by["capture-006.json"]["validationErrors"])
        self.assertIn("invalid id", by["capture-007.json"]["validationErrors"])
        self.assertEqual(by["capture-001.json"]["capturedAtUtc"], "")
        self.assertEqual(by["capture-006.json"]["model"], "")
        for c in m["captures"]:
            self.assertEqual(c["pagination"]["completeness"], "unknown")

    def test_bad_filename_rejected(self):
        self.w("capture-AB.json", cap(1))
        self.w("capture-1.json", cap(2))
        rc, _, _ = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        m = self.manifest()
        for c in m["captures"]:
            self.assertIn("invalid filename", c["validationErrors"])

    def test_missing_empty_nondir_input(self):
        missing = self.repo / "private" / "nope"
        rc, _, _ = self.run_cli("--input-dir", str(missing), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertFalse(self.out.exists())
        notdir = self.t / "afile"
        notdir.write_text("x")
        rc, _, _ = self.run_cli("--input-dir", str(notdir), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertFalse(self.out.exists())
        emptydir = self.repo / "private" / "empty"
        emptydir.mkdir()
        rc, _, _ = self.run_cli("--input-dir", str(emptydir), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertFalse(self.out.exists())

    def test_path_containment(self):
        self.w("capture-001.json", cap(1))
        outside = self.t / "elsewhere.json"
        self.assertEqual(self.cli("--input-dir", str(self.ind), "--output", str(outside)), 2)
        self.assertFalse(outside.exists())

    def test_symlink_refused(self):
        self.w("capture-001.json", cap(1))
        (self.ind / "evil-link").symlink_to(self.ind / "capture-001.json")
        rc, so, se = self.run_cli("--input-dir", str(self.ind), "--output", str(self.out))
        self.assertEqual(rc, 2)
        self.assertFalse(self.out.exists())
        self.assertNotIn("evil-link", so + se)


if __name__ == "__main__":
    unittest.main()
