"""mitmproxy addon: capture CIFI's Nakama traffic and pull the server-side tables out of it.

WHY THIS EXISTS
---------------
Loop mods ("modules") are not in the APK and not in the save. Proven, not assumed: "Stelzi"
appears zero times in the 813k-line IL2CPP dump and zero times in the metadata string table, and
the save carries only aggregates (AllTimeHighestLoopModLevels) with no per-mod entries. So the
definitions come from the server, and the only way to map them is to watch the client fetch them.

The backend is Nakama (NakamaConfig : ScriptableObject in the dump), which is open-source with a
documented protocol -- storage objects over HTTP/JSON and a realtime WebSocket. That makes the
capture interpretable rather than a reverse-engineering project of its own.

SECRETS
-------
A live session carries an auth token and a device id. Raw flows go to the gitignored
tools/gamefiles/ tree; the DISTILLED output written here is redacted (see redact()) so it is safe
to look at and to paste into an issue. Never commit the raw flow file.

USAGE
-----
    mitmdump -s tools/capture/nakama_capture.py -w tools/gamefiles/capture/flows.mitm

Writes alongside the flow file:
    nakama-calls.json     every Nakama request/response, redacted
    nakama-tables.json    just the storage objects, decoded, keyed by collection/key
"""

import json
import os
import re
from datetime import datetime, timezone

from mitmproxy import http, ctx

OUT_DIR = os.path.join("tools", "gamefiles", "capture")
CALLS_PATH = os.path.join(OUT_DIR, "nakama-calls.json")
TABLES_PATH = os.path.join(OUT_DIR, "nakama-tables.json")

# Anything matching these is replaced before it reaches disk in the distilled output.
SECRET_KEYS = re.compile(
    r"token|password|secret|signature|session|refresh|device.?id|vars|email|udid|apple|google",
    re.I,
)
SECRET_HEADERS = {"authorization", "cookie", "set-cookie", "x-session", "x-auth"}

calls = []
tables = {}


def _is_nakama(flow: http.HTTPFlow) -> bool:
    """Nakama exposes /v2/... (account, storage, rpc, session) over HTTP."""
    return "/v2/" in flow.request.path or "nakama" in flow.request.pretty_host.lower()


def redact(value):
    """Recursively blank anything that looks like a credential. Structure is preserved so the
    shape of a response is still legible -- it is the schema we are after, not the secrets."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out[k] = "<redacted>" if SECRET_KEYS.search(str(k)) else redact(v)
        return out
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str) and len(value) > 400:
        # Long opaque blobs are usually tokens or the encoded save; keep a fingerprint only.
        return f"<{len(value)} chars omitted>"
    return value


def _decode(raw: bytes):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf8"))
    except Exception:
        text = raw.decode("utf8", "replace")
        return text if len(text) <= 400 else f"<{len(raw)} bytes, not JSON>"


def _collect_storage(body):
    """Nakama returns storage reads as {"objects":[{collection,key,value,...}]}. `value` is a
    JSON *string*, so decode it a second time -- that inner document is the actual table."""
    if not isinstance(body, dict):
        return
    for obj in body.get("objects") or []:
        if not isinstance(obj, dict):
            continue
        collection = obj.get("collection")
        key = obj.get("key")
        if collection is None or key is None:
            continue
        value = obj.get("value")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except Exception:
                pass
        tables[f"{collection}/{key}"] = value
        ctx.log.info(f"[nakama] storage object: {collection}/{key}")


def _flush():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(CALLS_PATH, "w", encoding="utf8") as f:
        json.dump({"captured": datetime.now(timezone.utc).isoformat(), "calls": calls}, f, indent=1)
    with open(TABLES_PATH, "w", encoding="utf8") as f:
        json.dump({"captured": datetime.now(timezone.utc).isoformat(), "tables": tables}, f, indent=1)


def response(flow: http.HTTPFlow):
    if not _is_nakama(flow):
        return

    req_body = _decode(flow.request.raw_content)
    res_body = _decode(flow.response.raw_content) if flow.response else None

    # Storage tables are read from the UNREDACTED body -- redaction is for the log we keep.
    _collect_storage(res_body)

    calls.append({
        "method": flow.request.method,
        "host": flow.request.pretty_host,
        "path": flow.request.path.split("?")[0],
        "query": {k: ("<redacted>" if SECRET_KEYS.search(k) else v)
                  for k, v in flow.request.query.items()},
        "status": flow.response.status_code if flow.response else None,
        "request": redact(req_body),
        "response": redact(res_body),
    })
    ctx.log.info(f"[nakama] {flow.request.method} {flow.request.path.split('?')[0]} -> "
                 f"{flow.response.status_code if flow.response else '?'}")
    _flush()


def websocket_message(flow):
    """Nakama's realtime channel. Match responses can carry table pushes too."""
    if not flow.websocket:
        return
    msg = flow.websocket.messages[-1]
    body = _decode(msg.content if isinstance(msg.content, bytes) else str(msg.content).encode())
    _collect_storage(body)
    calls.append({
        "method": "WS",
        "host": flow.request.pretty_host,
        "path": flow.request.path.split("?")[0],
        "fromClient": msg.from_client,
        "message": redact(body),
    })
    _flush()


def done():
    ctx.log.info(f"[nakama] wrote {len(calls)} call(s) and {len(tables)} storage table(s)")
