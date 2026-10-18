"""Browser check of the ProtocolOS /draft page (authoring mode) in the Next.js app.

Usage: BASE_URL=http://localhost:3767 python scripts/e2e_draft_next.py
Needs Playwright (for example the throwaway venv /tmp/pw). Exits 0 when every check passes.
Use localhost against `next dev`: it blocks dev resources for 127.0.0.1 (allowedDevOrigins), so the page never hydrates.

Checks (task-triallens-v2-draft-ui.md, acceptance 2-5):
- preset nsclc-pd1-chemo shows at least 3 drafted criteria, each with passing checks, a non-empty
  "Why this value" and a self-critique; insufficient cards show no value;
- the downloaded JSON deep-equals GET /api/draft/{draft_id};
- a free idea (a condition plus 3 known drugs) returns a result or a visible error within 150 s;
- screenshots at 1440x900 and 390x844, and no horizontal scroll at 390 px.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3767").rstrip("/")
OUT = Path(os.environ.get("SHOT_DIR", "/tmp/triallens-logs/v2/draft-ui"))
DRAFT_TIMEOUT_MS = 150_000
FREE_IDEA = ("small cell lung cancer", ["atezolizumab", "carboplatin", "etoposide"])

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def check_preset(page) -> str | None:
    page.goto(f"{BASE_URL}/draft")
    page.get_by_test_id("preset-nsclc-pd1-chemo").click()
    page.wait_for_selector('[data-testid="draft-result"], [data-testid="draft-error"]', timeout=DRAFT_TIMEOUT_MS)
    if page.get_by_test_id("draft-error").count():
        check(False, f"preset draft loaded (error: {page.get_by_test_id('draft-error').inner_text()})")
        return None
    drafted = page.locator('[data-testid="draft-criterion"][data-status="drafted"]')
    check(drafted.count() >= 3, f"at least 3 drafted criteria (found {drafted.count()})")
    for i in range(drafted.count()):
        card = drafted.nth(i)
        name = card.get_attribute("data-analyte")
        status = card.get_by_test_id("draft-checks").get_attribute("data-status")
        check(status in ("PASSED", "PASSED_WITH_WARNINGS"), f"{name}: checks status {status}")
        why = card.get_by_test_id("draft-why").locator("li")
        check(why.count() > 0 and why.first.inner_text().strip() != "", f"{name}: non-empty 'Why this value'")
        check(card.get_by_test_id("draft-critique").count() == 1, f"{name}: self-critique present")
        check(card.get_by_test_id("draft-value").count() == 1, f"{name}: proposed value shown")
    insufficient = page.locator('[data-testid="draft-criterion"][data-status="insufficient_evidence"]')
    for i in range(insufficient.count()):
        card = insufficient.nth(i)
        check(card.get_by_test_id("draft-value").count() == 0, f"{card.get_attribute('data-analyte')}: insufficient card has no value")
    check(page.get_by_test_id("blind-spot").count() == 1, "blind-spot footer present")
    return page.get_by_test_id("draft-summary").get_attribute("data-draft-id")


def check_download(page, draft_id: str) -> None:
    with page.expect_download() as info:
        page.get_by_test_id("draft-download").click()
    path = info.value.path()
    saved = json.loads(Path(path).read_text(encoding="utf-8"))
    api = page.request.get(f"{BASE_URL}/api/draft/{draft_id}").json()
    check(saved == api, f"downloaded JSON deep-equals /api/draft/{draft_id}")


def check_layout(browser) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for w, h in ((1440, 900), (390, 844)):
        page = browser.new_page(viewport={"width": w, "height": h})
        page.goto(f"{BASE_URL}/draft?preset=nsclc-pd1-chemo")
        page.wait_for_selector('[data-testid="draft-criterion"]', timeout=DRAFT_TIMEOUT_MS)
        shot = OUT / f"draft-{w}x{h}.png"
        page.screenshot(path=str(shot), full_page=True)
        print(f"     screenshot {shot}")
        if w == 390:
            sw, cw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            check(sw <= cw, f"no horizontal scroll at 390 px (scrollWidth {sw}, clientWidth {cw})")
        page.close()


def check_free_idea(page) -> None:
    condition, drugs = FREE_IDEA
    page.goto(f"{BASE_URL}/draft")
    page.get_by_test_id("idea-condition").fill(condition)
    box = page.get_by_test_id("idea-drugs")
    for d in drugs:
        box.fill(d)
        box.press("Enter")
    page.get_by_test_id("idea-setting-metastatic").click()
    start = time.monotonic()
    page.get_by_test_id("draft-submit").click()
    page.wait_for_selector('[data-testid="draft-result"], [data-testid="draft-error"]', timeout=DRAFT_TIMEOUT_MS)
    took = time.monotonic() - start
    outcome = "result" if page.get_by_test_id("draft-result").count() else f"error: {page.get_by_test_id('draft-error').inner_text()}"
    check(took <= 150, f"free idea answered in {took:.1f} s ({outcome})")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        draft_id = check_preset(page)
        if draft_id:
            check_download(page, draft_id)
        page.close()
        check_layout(browser)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        check_free_idea(page)
        browser.close()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
