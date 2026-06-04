import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1]
out = sys.argv[2]
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 760, "height": 620})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url, wait_until="networkidle")
    pg.wait_for_timeout(5000)
    pg.screenshot(path=out)
    b.close()
print("errors:", errs[:3])
