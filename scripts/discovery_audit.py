"""Offline evidence-audit tooling (Phase 1, developer only, stdlib only)."""
import argparse
import fnmatch
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OPS = {"search", "read", "count", "evidence"}
STEM_RE = re.compile(r"capture-\d{3,}")
FILE_RE = re.compile(r"capture-\d{3,}\.json")
MODEL_RE = re.compile(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+")
UTC_FMT = "%Y-%m-%d %H:%M:%S UTC"
_MISSING = object()


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def h(obj):
    return hashlib.sha256(canon(obj)).hexdigest()


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    return 2


def build_parser():
    p = argparse.ArgumentParser(description="Audit offline Odoo discovery captures.")
    p.add_argument("--input-dir", default="private/odoo-discovery")
    p.add_argument("--output", required=True)
    return p


def _ignored(path, root):
    try:
        rel = path.relative_to(root)
    except ValueError:
        return True
    if "__pycache__" in rel.parts or ".pytest_cache" in rel.parts:
        return True
    if path.name.endswith((".pyc", ".pyo", ".pyd")):
        return True
    return False


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)

    inp = Path(args.input_dir)
    out = Path(args.output)
    inp_res = inp.resolve() if inp.is_absolute() else (Path.cwd() / inp).resolve()
    out_res = out.resolve() if out.is_absolute() else (Path.cwd() / out).resolve()
    repo = REPO.resolve()
    priv = repo / "private"

    try:
        inp_res.relative_to(repo)
    except ValueError:
        return fail("input dir must be inside repo")
    try:
        out_res.relative_to(priv)
    except ValueError:
        return fail("output must be under <repo>/private/")

    if not inp_res.exists() or not inp_res.is_dir():
        return fail("input dir is not a directory")
    for p in sorted(inp_res.rglob("*"), key=lambda q: q.name.encode()):
        if _ignored(p, inp_res):
            continue
        if p.is_symlink():
            return fail("symlink in input dir")
    names = sorted(
        (p.name for p in inp_res.iterdir() if p.is_file() and not p.is_symlink()
         and not _ignored(p, inp_res)
         and fnmatch.fnmatch(p.name, "capture-*.json")),
        key=lambda s: s.encode(),
    )
    if not names:
        return fail("no capture files matched")
    in_paths = [inp_res / n for n in names]
    if out_res in set(in_paths):
        return fail("output must not overwrite a capture input")
    if fnmatch.fnmatch(out_res.name, "capture-*.json"):
        return fail("output name collides with capture-*.json inputs")

    # Read + parse all files first (for duplicate detection).
    blobs = []
    for p in in_paths:
        raw = p.read_bytes()
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception:
            doc = None
        blobs.append((p, raw, doc))

    ids = [d.get("id") for _, _, d in blobs if isinstance(d, dict) and isinstance(d.get("id"), str)]
    seen, dup = set(), False
    for i in ids:
        if i in seen:
            dup = True
        seen.add(i)
    if dup:
        return fail("duplicate capture id")

    captures = []
    for path, raw, doc in blobs:
        captures.append(audit_one(path.name, raw, doc))

    captures.sort(key=lambda c: (c["id"], c["file"]))
    summary = {"complete": 0, "incomplete": 0, "unknown": 0}
    for c in captures:
        summary[c["pagination"]["completeness"]] += 1
    manifest = {
        "captures": captures,
        "completenessSummary": summary,
        "duplicatesRejected": [],
        "fileCount": len(captures),
        "inputDir": str(inp_res.relative_to(repo)) if inp_res != repo else ".",
        "manifestVersion": 1,
    }
    text = json.dumps(manifest, sort_keys=True, indent=2) + "\n"
    out_res.parent.mkdir(parents=True, exist_ok=True)
    out_res.write_text(text, encoding="utf-8")
    n_err = sum(len(c["validationErrors"]) for c in captures)
    print(f"wrote manifest files={len(captures)} errors={n_err}")
    if n_err:
        return 2
    return 0


def _strict_utc(s):
    if not isinstance(s, str) or not s:
        return False
    try:
        parsed = datetime.strptime(s, UTC_FMT)
    except Exception:
        return False
    return parsed.strftime(UTC_FMT) == s


def audit_one(fname, raw, doc):
    stem = fname[:-5] if fname.endswith(".json") else fname
    sha = hashlib.sha256(raw).hexdigest()
    fname_ok = bool(FILE_RE.fullmatch(fname))
    base = {
        "capturedAtUtc": "",
        "domainHash": None,
        "errorPresence": False,
        "fieldCount": 0,
        "file": fname if fname_ok else "invalid-filename.json",
        "id": stem if fname_ok else "",
        "model": "",
        "operation": "",
        "pagination": {"completeness": "unknown", "limit": None, "offset": None,
                        "reason": "no-explicit-paging", "rowCount": None},
        "projectionHash": h([]),
        "queryHash": "",
        "scope": {},
        "sha256Hex": sha,
        "validationErrors": [],
    }
    if not fname_ok:
        base["validationErrors"].append("invalid filename")
    if not isinstance(doc, dict):
        base["validationErrors"].append("malformed JSON")
        return base
    errs = base["validationErrors"]

    if type(doc.get("schemaVersion")) is int and doc["schemaVersion"] == 1:
        pass
    else:
        errs.append("unsupported schemaVersion")
    cid = doc.get("id")
    if isinstance(cid, str) and STEM_RE.fullmatch(cid) and fname_ok and cid == stem:
        base["id"] = cid
    else:
        errs.append("invalid id")
    cat = doc.get("capturedAtUtc")
    if _strict_utc(cat):
        base["capturedAtUtc"] = cat
    else:
        errs.append("invalid capturedAtUtc")
    op = doc.get("operation")
    if isinstance(op, str) and op in OPS:
        base["operation"] = op
    else:
        errs.append("invalid operation")
    req = doc.get("request")
    if not (isinstance(req, dict) and isinstance(req.get("model"), str)
            and MODEL_RE.fullmatch(req["model"])):
        errs.append("invalid request.model")
        req = None
    else:
        base["model"] = req["model"]
    ctx = doc.get("context")
    scope = {}
    ctx_ok = isinstance(ctx, dict)
    if ctx_ok:
        inst = ctx.get("instance")
        rev = ctx.get("brokerRevision")
        ec = ctx.get("enabledCompanyIds")
        dc = ctx.get("defaultCompanyId")
        arch = ctx.get("includeArchived")
        if (isinstance(inst, str) and inst
                and isinstance(rev, str) and rev
                and isinstance(ec, list) and len(ec) > 0
                and all(type(x) is int and x > 0 for x in ec)
                and type(dc) is int and dc > 0 and dc in ec
                and type(arch) is bool):
            scope = {"instance": inst, "defaultCompanyId": dc,
                     "enabledCompanyIds": sorted(ec),
                     "includeArchived": arch, "brokerRevision": rev}
        else:
            errs.append("invalid context")
    else:
        errs.append("invalid context")
    base["scope"] = scope
    is_err = doc.get("isError")
    if type(is_err) is not bool:
        errs.append("invalid isError")
        is_err = False
    base["errorPresence"] = (is_err is True)
    resp = doc.get("response")
    if not isinstance(resp, list):
        errs.append("invalid response")
        resp = None

    if isinstance(req, dict):
        try:
            base["queryHash"] = h(req)
        except Exception:
            errs.append("unhashable request")
        fields = req.get("fields", None)
        if fields is None:
            pass
        elif isinstance(fields, list) and all(isinstance(f, str) for f in fields):
            base["fieldCount"] = len(fields)
            base["projectionHash"] = h(sorted(fields))
        else:
            errs.append("invalid request.fields")
        if "domain" in req:
            try:
                base["domainHash"] = h(req["domain"])
            except Exception:
                errs.append("unhashable request.domain")
        lim, off = req.get("limit"), req.get("offset")
        pg = base["pagination"]
        if type(lim) is int:
            pg["limit"] = lim
        if type(off) is int:
            pg["offset"] = off

    if resp is None:
        return base
    pg = base["pagination"]
    if base["errorPresence"]:
        pg["rowCount"] = None
        return base
    payload = resp[0] if resp else None
    meta = resp[1] if len(resp) > 1 else None
    opv = base["operation"]
    if opv in ("search", "read"):
        if not isinstance(payload, list):
            errs.append("invalid payload")
            return base
        for i, r in enumerate(payload):
            if not (isinstance(r, dict) and type(r.get("id")) is int and r["id"] > 0):
                errs.append(f"invalid record at index {i}")
                break
        pg["rowCount"] = len(payload)
        if isinstance(meta, dict) and meta.get("exhausted") is True:
            pg["completeness"] = "complete"
            pg["reason"] = "metadata-exhausted"
    elif opv == "count":
        if type(payload) is int and payload >= 0:
            pass
        else:
            errs.append("invalid count payload")
        pg["rowCount"] = None
        pg["reason"] = "count-operation-no-rows"
    elif opv == "evidence":
        if not (isinstance(payload, dict) and isinstance(payload.get("rows"), list)):
            errs.append("invalid evidence payload")
            return base
        rows = payload["rows"]
        for i, r in enumerate(rows):
            if not (isinstance(r, dict) and type(r.get("id")) is int and r["id"] > 0):
                errs.append(f"invalid record at index {i}")
                break
        pg["rowCount"] = len(rows)

        def ev(key):
            if isinstance(payload, dict) and key in payload:
                return payload[key]
            if isinstance(meta, dict) and key in meta:
                return meta[key]
            return _MISSING

        has_more = ev("has_more")
        complete = ev("complete")
        kind = req.get("kind") if isinstance(req, dict) else None
        if kind == "attachments":
            # attachment-style cursor
            off = ev("offset")
            if off == 0 and type(off) is int and has_more is False:
                pg["completeness"] = "complete"
                pg["reason"] = "attachments-exhausted"
            elif has_more is True:
                pg["completeness"] = "incomplete"
                pg["reason"] = "attachments-has-more"
        elif kind == "chatter":
            # chatter-style window
            off = ev("offset")
            vis = ev("visible_total")
            if (type(off) is int and off == 0 and complete is True
                    and type(vis) is int and vis >= 0):
                ids = {r["id"] for r in rows
                       if isinstance(r, dict) and type(r.get("id")) is int}
                if len(ids) >= vis:
                    pg["completeness"] = "complete"
                    pg["reason"] = "chatter-window-complete"
            elif has_more is True:
                pg["completeness"] = "incomplete"
                pg["reason"] = "chatter-has-more"
        elif kind != "tracking":
            errs.append("unsupported evidence kind")
        # tracking-style (two-dimensional cursors) and anything else: unknown
    if errs:
        pg["completeness"] = "unknown"
        pg["reason"] = "invalid-capture"
    return base


if __name__ == "__main__":
    sys.exit(main())
