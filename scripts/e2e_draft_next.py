"""Browser check of the ProtocolOS /draft page (authoring mode) in the Next.js app.

Usage: BASE_URL=http://localhost:3767 python scripts/e2e_draft_next.py
Needs Playwright (for example the throwaway venv /tmp/pw). Exits 0 when every check passes.
Use localhost against `next dev`: it blocks dev resources for 127.0.0.1 (allowedDevOrigins), so the page never hydrates.

Checks:
- /draft with no query opens the first preset (nsclc-pd1-chemo) with one request, without scrolling;
- that draft shows at least 3 drafted criteria, each with passing checks, a verdict chip and the precedent's own
  words in its compact row, and (once expanded) a non-empty "Why this value" and a self-critique; insufficient cards
  show the reason and no value;
- cards start compact except Review recommended and drafted Insufficient-evidence ones; a verdict-band link opens
  the card it points to;
- the verdict band counts every criterion, and no internal score tally is shown;
- preset el3-design-time puts the before/after table above the cards, counts its differing rows among the rows that
  state the same measure, and marks the renal row (GFR as written vs drafted CrCl) as a different measure;
- the downloaded JSON deep-equals GET /api/draft/{draft_id}; the Markdown download lists every criterion;
- a free idea (a condition plus 3 known drugs) returns a result or a visible error within 150 s;
- with the last drug still typed (no Enter), a click on a setting, a phase or "Draft criteria" lands on the first try;
- each preset click or idea sends exactly one draft request;
- at 390 px a deep link or a tapped preset scrolls the result into view;
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
OUT = Path(os.environ.get("SHOT_DIR", "/tmp/protocolos-logs/v2/draft-ui"))
DRAFT_TIMEOUT_MS = 150_000
# Phase 2 uveal melanoma has few regimen-matched precedents, so its draft also has insufficient-evidence cards. The
# engine caches drafts, so only the first run on a fresh cache computes it; the log line says which one happened.
FREE_IDEA = ("uveal melanoma", ["pembrolizumab", "carboplatin", "etoposide"], "PHASE2")

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def track_draft_requests(page) -> list[str]:
    """Records every POST /api/draft and GET /api/draft/{id} the page sends (not presets or vocabulary)."""
    seen: list[str] = []

    def on_request(req) -> None:
        path = req.url.split("?", 1)[0]
        if "/api/draft" in path and not path.endswith(("/presets", "/vocabulary")):
            seen.append(f"{req.method} {path[path.index('/api/'):]}")

    page.on("request", on_request)
    return seen


def wait_for_draft(page, sent: list[str], what: str, selector: str = '[data-testid="draft-result"], [data-testid="draft-error"]') -> float:
    """Waits for the draft to render, returns when that happened, then checks no second request followed."""
    page.wait_for_selector(selector, timeout=DRAFT_TIMEOUT_MS)
    done = time.monotonic()
    page.wait_for_timeout(1500)  # a repeated request would follow the first render of the result
    check(len(sent) == 1, f"{what} sent exactly one draft request ({', '.join(sent) or 'none'})")
    return done


def check_insufficient(page) -> None:
    cards = page.locator('[data-testid="draft-criterion"][data-status="insufficient_evidence"]')
    print(f"     {cards.count()} insufficient-evidence card(s) on this draft")
    for i in range(cards.count()):
        card = cards.nth(i)
        name = card.get_attribute("data-analyte")
        check(card.get_by_test_id("draft-value").count() == 0, f"{name}: insufficient card has no value")
        reason = card.get_by_test_id("draft-insufficient")
        check(reason.count() == 1 and reason.inner_text().strip() != "", f"{name}: insufficient card states the reason")
        check("not this value" not in card.inner_text(), f"{name}: no wording about a value the card does not propose")


def open_draft_page(page, what: str) -> list[str]:
    """Opens /draft, which opens the first preset by itself; returns the request log after that first draft."""
    page.goto(f"{BASE_URL}/draft")
    sent = track_draft_requests(page)
    wait_for_draft(page, sent, what)
    return sent


def check_preset(page) -> str | None:
    open_draft_page(page, "/draft with no query (opens the first preset)")
    if page.get_by_test_id("draft-error").count():
        check(False, f"preset draft loaded (error: {page.get_by_test_id('draft-error').inner_text()})")
        return None
    check(page.get_by_test_id("preset-nsclc-pd1-chemo").get_attribute("aria-pressed") == "true", "first preset (nsclc-pd1-chemo) opened by itself")
    check(page.evaluate("window.scrollY") == 0, "opening the first preset by itself does not scroll the page")
    drafted = page.locator('[data-testid="draft-criterion"][data-status="drafted"]')
    check(drafted.count() >= 3, f"at least 3 drafted criteria (found {drafted.count()})")
    # Starting state, read before the loop below opens every card: compact cards exist, and a band link opens one.
    compact = page.locator('[data-testid="draft-criterion"][data-open="false"]')
    check(compact.count() > 0, f"{compact.count()} card(s) start as a compact row")
    if compact.count():
        cid = compact.first.get_attribute("id")
        page.locator(f'[data-testid="draft-index"] a[href="#{cid}"]').click()
        check(page.locator(f"#{cid}").get_attribute("data-open") == "true", f"band link opens the compact card #{cid}")
        page.locator(f"#{cid}").get_by_test_id("draft-toggle").click()  # back to its starting state for the loop
        page.evaluate("window.scrollTo(0, 0)")
    for i in range(drafted.count()):
        card = drafted.nth(i)
        name = card.get_attribute("data-analyte")
        bucket = card.get_attribute("data-bucket")
        should_open = bucket in ("review", "insufficient_value")
        check((card.get_attribute("data-open") == "true") == should_open,
              f"{name}: starts {'open' if should_open else 'compact'} ({bucket})")
        status = card.get_by_test_id("draft-checks").get_attribute("data-status")
        check(status in ("PASSED", "PASSED_WITH_WARNINGS"), f"{name}: checks status {status}")
        check(card.get_by_test_id("draft-value").count() == 1, f"{name}: proposed value shown")
        check(card.get_by_test_id("draft-verdict").inner_text().strip() != "", f"{name}: verdict chip in the header")
        quote = card.get_by_test_id("draft-quote")
        check(quote.count() == 1 and "“" in quote.inner_text(), f"{name}: precedent's own words quoted in the compact row")
        # The reasoning sits behind the card's toggle; closed content has no innerText.
        toggle = card.get_by_test_id("draft-toggle")
        if toggle.get_attribute("aria-expanded") != "true":
            toggle.click()
        why = card.get_by_test_id("draft-why").locator("li")
        check(why.count() > 0 and why.first.inner_text().strip() != "", f"{name}: non-empty 'Why this value'")
        check(card.get_by_test_id("draft-critique").count() == 1 and card.get_by_test_id("draft-critique").inner_text().strip() != "",
              f"{name}: self-critique present")
        check("FDA, " not in card.get_by_test_id("draft-why").inner_text(), f"{name}: FDA passages are not listed as reasons for the value")
    text = page.get_by_test_id("draft-result").inner_text()
    check("support score" not in text and "FDA: FDA" not in text, "no internal score tally or doubled FDA prefix")
    tiles = page.locator('[data-testid="draft-verdict-counts"] > li')
    total = sum(int(tiles.nth(i).get_attribute("data-count")) for i in range(tiles.count()))
    cards = page.get_by_test_id("draft-criterion").count()
    check(total == cards, f"verdict band counts add up to the {cards} criteria ({total})")
    check_insufficient(page)
    check(page.get_by_test_id("blind-spot").count() == 1, "blind-spot footer present")
    check(page.title().startswith("Create criteria from an idea"), f"document title names the mode ({page.title()!r})")
    check(page.get_by_role("link", name="Skip to draft").count() == 1, "skip link to the draft present")
    return page.get_by_test_id("draft-summary").get_attribute("data-draft-id")


def check_before_after(page) -> None:
    sent = track_draft_requests(page)
    page.get_by_test_id("preset-el3-design-time").click()
    wait_for_draft(page, sent, "preset el3-design-time click", '[data-testid="before-after"] table')
    above = page.evaluate(
        """() => {
            const t = document.querySelector('[data-testid="before-after"]');
            const c = document.querySelector('[data-testid="draft-criterion"]');
            return !!(t && c && (t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING));
        }"""
    )
    check(above, "before/after table comes before the cards")
    rows = page.locator('[data-testid="before-after"] tbody tr')
    differ = page.locator('[data-testid="before-after"] tbody tr[data-differs="true"]').count()
    other = page.locator('[data-testid="before-after"] tbody tr[data-measure="different"]').count()
    line = page.get_by_test_id("before-after-count").inner_text()
    check(line.startswith(f"{differ} of {rows.count() - other} criteria differ"), f"before/after count line matches the rows ({line!r})")
    # EL3 states GFR >30 mL/min/1.73m2 (p.67); the draft's >=50 mL/min is a creatinine clearance. A different measure is
    # a question about intent, not a value difference, and is left out of the count.
    renal = page.locator('[data-testid="before-after"] tbody tr', has=page.locator('a[href="#draft-renal"]'))
    rtext = renal.inner_text() if renal.count() else ""
    check(renal.get_attribute("data-measure") == "different" and "Different measure (GFR vs CrCl)" in rtext and "1.73m²" in rtext
          and renal.locator('[data-role="used"]').count() == 0,
          f"renal row is marked as a different measure with the written unit ({rtext!r})")


def check_download(page, draft_id: str) -> None:
    with page.expect_download() as info:
        page.get_by_test_id("draft-download").click()
    path = info.value.path()
    saved = json.loads(Path(path).read_text(encoding="utf-8"))
    api = page.request.get(f"{BASE_URL}/api/draft/{draft_id}").json()
    check(saved == api, f"downloaded JSON deep-equals /api/draft/{draft_id}")
    with page.expect_download() as info:
        page.get_by_test_id("draft-download-md").click()
    md = Path(info.value.path()).read_text(encoding="utf-8")
    labels = [c["label"] for c in api["criteria"]]
    check(all(f". {label}\n" in md for label in labels) and "cannot be seen by ProtocolOS" in md,
          f"Markdown download lists all {len(labels)} criteria and the blind spot")


def in_view(page, testid: str) -> bool:
    box = page.get_by_test_id(testid).bounding_box()
    return box is not None and 0 <= box["y"] < page.viewport_size["height"]


def check_layout(browser) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for w, h in ((1440, 900), (390, 844)):
        page = browser.new_page(viewport={"width": w, "height": h})
        sent = track_draft_requests(page)
        page.goto(f"{BASE_URL}/draft?preset=nsclc-pd1-chemo")
        wait_for_draft(page, sent, f"deep link ?preset= at {w} px", '[data-testid="draft-criterion"]')
        if w == 390:
            check(in_view(page, "draft-summary"), "deep link at 390 px scrolls the result into view")
            sw, cw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            check(sw <= cw, f"no horizontal scroll at 390 px (scrollWidth {sw}, clientWidth {cw})")
        shot = OUT / f"draft-{w}x{h}.png"
        page.evaluate("window.scrollTo(0, 0)")
        page.screenshot(path=str(shot), full_page=True)
        print(f"     screenshot {shot}")
        page.close()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    open_draft_page(page, "/draft at 390 px")
    check(page.evaluate("window.scrollY") == 0, "at 390 px the first preset opens without scrolling past the form")
    sent = track_draft_requests(page)
    page.get_by_test_id("preset-el3-design-time").click()
    wait_for_draft(page, sent, "preset tap at 390 px", '[data-testid="before-after"]')
    page.wait_for_timeout(800)  # the smooth scroll settles
    check(in_view(page, "draft-summary"), "a tapped preset at 390 px scrolls the result into view")
    page.close()


def click_centre(page, locator) -> None:
    """Presses and releases the mouse where the element is now, as a user does; a layout shift in between loses the click."""
    box = locator.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def check_free_idea(page) -> None:
    condition, drugs, phase = FREE_IDEA
    sent = open_draft_page(page, "/draft before the free idea")
    sent.clear()
    page.get_by_test_id("idea-condition").fill(condition)
    box = page.get_by_test_id("idea-drugs")
    for d in drugs[:-1]:
        box.fill(d)
        box.press("Enter")
    # The last drug stays typed in the box, as a user would leave it, while the other controls are clicked.
    box.fill(drugs[-1])
    toggle = page.get_by_test_id("idea-setting-metastatic")
    click_centre(page, toggle)
    on = toggle.get_attribute("aria-pressed")
    click_centre(page, toggle)
    check((on, toggle.get_attribute("aria-pressed")) == ("true", "false"), "setting toggle switches on and off")
    radio = page.locator(f'input[name="phase"][value="{phase}"]')
    click_centre(page, page.locator("label", has=radio))
    check(radio.is_checked(), f"phase {phase} selected on the first click")
    start = time.monotonic()
    click_centre(page, page.get_by_test_id("draft-submit"))
    try:
        page.wait_for_selector('[data-testid="draft-progress"], [data-testid="draft-result"], [data-testid="draft-error"]', timeout=5000)
        check(True, "first click on Draft criteria with the last drug still typed starts the draft")
    except Exception:
        check(False, f"first click on Draft criteria with the last drug still typed starts the draft (requests: {sent or 'none'})")
        return
    took = wait_for_draft(page, sent, "free idea") - start
    check(sent[:1] == ["POST /api/draft"], "free idea request is POST /api/draft")
    chips = page.get_by_test_id("drug-chip")
    check(chips.count() == 3 and all(chips.nth(i).get_attribute("data-recognized") == "true" for i in range(3)),
          "3 drug chips, all recognized by the vocabulary")
    if page.get_by_test_id("draft-error").count():
        # A failed idea keeps the previous draft on screen and reports the failure next to the submit button.
        outcome = f"error: {page.get_by_test_id('draft-error').inner_text()}"
    else:
        summary = page.get_by_test_id("draft-summary")
        cached = summary.get_attribute("data-cached") == "true"
        outcome = f"result, {'from the engine cache' if cached else 'computed now'}"
        check(cached or "cached" not in summary.inner_text(), "a draft computed now is not labelled cached")
        check_insufficient(page)
    check(took <= 150, f"free idea answered in {took:.1f} s ({outcome})")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        draft_id = check_preset(page)
        if draft_id:
            check_download(page, draft_id)
            check_before_after(page)
        page.close()
        check_layout(browser)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        check_free_idea(page)
        browser.close()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
