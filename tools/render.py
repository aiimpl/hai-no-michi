"""Recording: open the page with ?render, call __renderAt(frame) frame by frame, and capture at 2x resolution including the HUD.
  python tools/render.py <output dir> [start end fps]      e.g. python tools/render.py out/frames 0 900 30
If interrupted, existing frames are skipped and rendering resumes (the page re-runs physics up to that time).
Chrome runs in an off-screen window (headless WebGL is slow or stalls).
"""
import functools
import http.server
import json
import os
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_address[1]


def main():
    out = sys.argv[1]
    f0 = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    f1 = int(sys.argv[3]) if len(sys.argv) > 3 else 900
    fps = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    only = [int(x) for x in os.environ.get("ONLY", "").split(",") if x]
    os.makedirs(out, exist_ok=True)
    frames = only or [f for f in range(f0, f1) if not os.path.exists(os.path.join(out, f"{f:05d}.png"))]
    if not frames:
        print("all frames exist")
        return
    port = serve()
    log = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=False, args=["--window-position=-3000,0", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 1350, "height": 1080}, device_scale_factor=2)
        pg.on("pageerror", lambda e: log.append(f"[pageerror] {e}"))
        pg.on("console", lambda m: log.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        pg.goto(f"http://127.0.0.1:{port}/index.html?render")
        pg.wait_for_function("window.__ready === true", timeout=120000)
        pg.evaluate("document.fonts.ready")
        t0 = time.time()
        meta = []
        for n, f in enumerate(frames):
            r = pg.evaluate(f"window.__renderAt({f}, {fps})")
            pg.screenshot(path=os.path.join(out, f"{f:05d}.png"))
            meta.append({"f": f, **r})
            if n % 30 == 0:
                el = time.time() - t0
                print(f"frame {f}  {r}  {el / (n + 1):.2f}s/frame", flush=True)
        b.close()
    # on resume, merge with the earlier records so meta covers every frame
    mp = os.path.join(out, "meta.json")
    old = {m["f"]: m for m in json.load(open(mp))} if os.path.exists(mp) else {}
    old.update({m["f"]: m for m in meta})
    json.dump([old[k] for k in sorted(old)], open(mp, "w"))
    for line in log[:20]:
        print(line)


main()
