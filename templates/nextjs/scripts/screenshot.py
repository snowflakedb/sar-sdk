"""Screenshot the running app for the design review (references/design.md).

    # from the project root (the folder with app.yml):
    uv run --with playwright python scripts/screenshot.py http://localhost:3000/

Saves desktop and mobile shots, in light and dark, to a temporary directory and prints each path.
Waits for loading skeletons (`.animate-pulse`) to disappear, not a fixed delay, but takes the
shot anyway after 90s, so an always-on pulse (a "live" dot) can't stop the review.
"""

import sys
import tempfile
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

SHOTS = [
    ("desktop", 1280, 900, "light"),
    ("dark", 1280, 900, "dark"),
    ("mobile", 390, 844, "light"),
    ("mobile-dark", 390, 844, "dark"),
]


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000/"
    out = Path(tempfile.mkdtemp(prefix="app-screenshots-"))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, width, height, scheme in SHOTS:
            context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=scheme)
            # Set the stored theme too: an app whose DEFAULT_THEME is 'light' or 'dark' ignores color_scheme.
            context.add_init_script(f"localStorage.setItem('theme', '{scheme}')")
            page = context.new_page()
            page.goto(url)
            try:
                # First loads of slow queries can take 30s or more.
                page.wait_for_function("!document.querySelector('.animate-pulse')", timeout=90_000)
            except PlaywrightTimeout:
                print(f"{name}: still loading after 90s; taking the shot anyway", file=sys.stderr)
            page.wait_for_timeout(1500)  # let entrance animations finish
            path = out / f"app-{name}.png"
            page.screenshot(path=str(path))
            print(path)
            context.close()
        browser.close()


if __name__ == "__main__":
    main()
