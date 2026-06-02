#!/usr/bin/env python3
"""
End-to-end check for `PORT=8501 bash react-vite/app.sh`:

Domino's VS Code workspace serves apps inside a sandboxed null-origin iframe.
The page survives that by being self-contained: Flask inlines the Vite JS/CSS
into index.html so there are no cross-origin subresource fetches. /api/* calls
still need ACAO since they're cross-origin from a null frame.

This test verifies:
  1. `app.sh` prints an "Open: <url>" line.
  2. The served / response contains zero `<script src="...">` and zero
     `<link rel="stylesheet" href="...">` tags — i.e. assets are inlined.
  3. The original bundled JS/CSS contents do appear inline in the HTML.
  4. /api/hello returns 200 with `Access-Control-Allow-Origin` set, even when
     the request comes from `Origin: null` (simulating the sandboxed iframe).

Exit 0 on success, non-zero on failure.
"""
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

PORT = int(os.environ.get("PORT", "8501"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_SH = os.path.join(ROOT, "app.sh")
BASE = f"http://127.0.0.1:{PORT}"
STARTUP_TIMEOUT_SEC = 180


def wait_for_ready(url, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise SystemExit(f"server did not respond at {url} within {timeout}s")


def get(url, origin=None):
    req = urllib.request.Request(url)
    if origin is not None:
        req.add_header("Origin", origin)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, dict(r.headers), r.read()


def main():
    env = {**os.environ, "PORT": str(PORT)}
    print(f"[e2e] starting: PORT={PORT} bash {APP_SH}")
    proc = subprocess.Popen(
        ["bash", APP_SH],
        env=env,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
        text=True,
        bufsize=1,
    )

    failures = []
    captured_url = None
    captured_lines = []
    try:
        # Tee stdout while watching for the "Open:" line. Stop watching once
        # the server is up; the rest of the lines are runtime logs we don't need.
        deadline = time.time() + STARTUP_TIMEOUT_SEC
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            captured_lines.append(line.rstrip())
            print(f"[app] {line.rstrip()}")
            m = re.search(r"Open:\s*(\S+)", line)
            if m:
                captured_url = m.group(1)
            if "Running on http://127.0.0.1" in line:
                break

        wait_for_ready(BASE + "/", 30)
        print(f"[e2e] server is up at {BASE}/")

        # 1. app.sh printed an Open URL.
        if not captured_url:
            failures.append("app.sh did not print an 'Open: <url>' line")
        else:
            print(f"[e2e] captured URL: {captured_url}")

        # 2. The served / response is self-contained: no <script src> or
        # <link rel="stylesheet"> pointing at separate asset files.
        status, _, body = get(BASE + "/", origin="null")
        html = body.decode("utf-8", "replace")
        print(f"[e2e] GET /                                          status={status}  ({len(body):,} bytes)")
        if status != 200:
            failures.append(f"index.html: status {status}")

        external_scripts = re.findall(r'<script[^>]*\ssrc="[^"]+"[^>]*>', html)
        if external_scripts:
            failures.append(
                f"index.html still has external <script src=...> tags "
                f"(inline failed): {external_scripts}"
            )
        external_styles = re.findall(
            r'<link[^>]*rel="stylesheet"[^>]*href="[^"]+"[^>]*>', html
        )
        if external_styles:
            failures.append(
                f"index.html still has external <link rel=stylesheet> tags "
                f"(inline failed): {external_styles}"
            )

        # 3. Inlined contents actually present — read a snippet of the
        # bundled JS straight off disk and confirm it appears in the response.
        dist_dir = os.path.join(ROOT, "frontend", "dist", "assets")
        try:
            js_file = next(f for f in os.listdir(dist_dir) if f.endswith(".js"))
            with open(os.path.join(dist_dir, js_file)) as f:
                js_head = f.read(200)
            if js_head[:80].strip() and js_head[:80].strip() not in html:
                failures.append(
                    f"bundled JS prefix not found inline in index.html "
                    f"(expected first ~80 chars of {js_file})"
                )
            else:
                print(f"[e2e] inline JS check: first ~80 chars of {js_file} present")
        except StopIteration:
            failures.append("no built JS file found under frontend/dist/assets/")

        # 4. /api still works as a normal fetch (Jupyter / local-dev path):
        # ACAO present, JSON body.
        status, headers, body = get(BASE + "/api/hello", origin="null")
        acao = headers.get("Access-Control-Allow-Origin")
        ctype = headers.get("Content-Type", "")
        print(f"[e2e] GET /api/hello                                 status={status}  ACAO={acao!r}")
        if status != 200:
            failures.append(f"/api/hello: status {status}")
        if not acao:
            failures.append("/api/hello: missing Access-Control-Allow-Origin")
        if "application/json" not in ctype:
            failures.append(f"/api/hello: expected JSON, got Content-Type={ctype!r}")

        # 5. /api with ?callback=<ident> returns JSONP (script-tag transport
        # used by the null-origin iframe in VS Code workspaces).
        status, headers, body = get(BASE + "/api/hello?callback=__jsonp_test")
        text = body.decode("utf-8", "replace")
        ctype = headers.get("Content-Type", "")
        print(f"[e2e] GET /api/hello?callback=__jsonp_test           status={status}  Content-Type={ctype!r}")
        if status != 200:
            failures.append(f"/api/hello?callback=...: status {status}")
        if "javascript" not in ctype:
            failures.append(f"/api/hello?callback=...: expected JS, got {ctype!r}")
        if not text.startswith("/**/__jsonp_test(") or not text.rstrip().endswith(");"):
            failures.append(f"/api/hello?callback=...: body not wrapped as JSONP: {text[:80]!r}")

        # 6. Callback validation: a malicious callback name must be ignored
        # (otherwise it'd be a JS-injection vector).
        status, headers, body = get(BASE + "/api/hello?callback=alert(1)")
        text = body.decode("utf-8", "replace")
        print(f"[e2e] GET /api/hello?callback=alert(1)               status={status}  starts={text[:20]!r}")
        if text.startswith("/**/alert(1)("):
            failures.append("callback=alert(1) was accepted - JSONP callback validation broken")

        # 7. The inlined HTML contains the fetch monkey-patch.
        if "__JSONP_FETCH_INSTALLED__" not in html:
            failures.append("fetch monkey-patch not present in inlined HTML")
        else:
            print("[e2e] fetch monkey-patch present in inlined HTML")

    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass

    if failures:
        print("\n[e2e] FAIL")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\n[e2e] PASS - / is self-contained (no external assets), /api works under Origin: null")


if __name__ == "__main__":
    main()
