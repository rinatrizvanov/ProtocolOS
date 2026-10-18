"""Browser check of the ProtocolOS web-next landing and /review (plan-v2 WS-B acceptance 2-6).

Usage:
    BASE_URL=http://localhost:3766 /tmp/pw/bin/python scripts/e2e_review_next.py [--strict]

Use localhost, not 127.0.0.1, against `next dev`: Next 16 blocks its dev resources for the 127.0.0.1 origin
unless next.config.ts lists it in allowedDevOrigins, and the page never hydrates.

Each step prints PASS, FAIL or SKIP. A step SKIPs when the piece it needs is not merged yet (for example
/api/rationale answers 404, or the Decide tab has no structured reason buttons). A skip is never a pass:
with --strict any SKIP makes the run fail. Screenshots go to /tmp/triallens-logs/v2/ui/.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3766").rstrip("/")
NCT = "NCT03409614"
SHOTS = Path("/tmp/triallens-logs/v2/ui")
REPO = Path(__file__).resolve().parents[1]
TABS = ("rationale", "compare", "ask", "verify", "decide")
BANNED = re.compile(r"feedback loop|learns from|safe to|will increase enrol", re.I)
EVIDENCE = re.compile(r"\bevidence\b", re.I)
# "Insufficient evidence" is the fixed classification. The Decide tab shows the stored reason "Prior evidence"
# (DECISION_REASONS in web-next/lib/contracts.ts) as "Prior trial data", so it needs no exception here.
ALLOWED_EVIDENCE = re.compile(r"insufficient evidence", re.I)

results: list[tuple[str, str, str]] = []


def report(step: str, status: str, detail: str = "") -> None:
    results.append((step, status, detail))
    print(f"{status:4} {step}{': ' + detail if detail else ''}", flush=True)


def review_url(criterion: str = "hemoglobin", tab: str | None = None, nct: str = NCT) -> str:
    url = f"{BASE_URL}/review?nct={nct}&c={criterion}"
    return f"{url}&tab={tab}" if tab else url


def visible_text(page: Page) -> str:
    """innerText of the page with verbatim quotes ([data-role=quote]) hidden."""
    return page.evaluate(
        """() => {
            const style = document.createElement('style');
            style.textContent = '[data-role=quote]{display:none !important}';
            document.head.appendChild(style);
            const text = document.body.innerText;
            style.remove();
            return text;
        }"""
    )


def wording_problems(text: str) -> list[str]:
    problems = [m.group(0) for m in BANNED.finditer(text)]
    stripped = ALLOWED_EVIDENCE.sub("", text)
    for m in EVIDENCE.finditer(stripped):
        problems.append(stripped[max(0, m.start() - 40) : m.end() + 20].replace("\n", " "))
    return problems


def api_status(page: Page, path: str) -> int:
    return page.evaluate("async (p) => (await fetch(p)).status", path)


def grep_empty(pattern: str) -> tuple[bool, str]:
    out = subprocess.run(
        ["grep", "-rn", pattern, str(REPO / "web-next" / "app")], capture_output=True, text=True
    ).stdout.strip()
    return out == "", out[:300]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="treat any SKIP as a failure")
    args = parser.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()

        # 1. Landing: two mode cards and the first-run onboarding strip.
        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        ok = page.get_by_test_id("mode-review").is_visible() and page.get_by_test_id("mode-draft").is_visible()
        report("landing shows mode-review and mode-draft", "PASS" if ok else "FAIL")
        page.screenshot(path=str(SHOTS / "landing-1440.png"), full_page=True)
        if page.get_by_test_id("onboarding").is_visible():
            page.get_by_test_id("onboarding-dismiss").click()
            page.wait_for_timeout(200)
            gone = page.get_by_test_id("onboarding").count() == 0
            page.reload(wait_until="networkidle")
            stays = page.get_by_test_id("onboarding").count() == 0
            report("onboarding dismisses and stays dismissed", "PASS" if gone and stays else "FAIL")
        else:
            report("onboarding shows on first run", "FAIL", "onboarding strip not visible")
        landing_problems = wording_problems(visible_text(page))
        href = page.get_by_test_id("mode-review").get_attribute("href") or ""
        report("mode-review link is relative", "PASS" if not href.startswith("/") else "FAIL", href)

        # 2. Review: rationale badge and arm line (need /api/rationale from WS-E).
        page.goto(review_url(), wait_until="networkidle")
        page.get_by_test_id("classification").wait_for(timeout=15000)
        rationale_status = api_status(page, f"/api/rationale/{NCT}")
        if rationale_status != 200:
            report("rationale-badge[data-key=safety]", "SKIP", f"/api/rationale returned {rationale_status}")
            report("arm-attribution[data-driver=all_arms]", "SKIP", f"/api/rationale returned {rationale_status}")
        else:
            badge = page.locator('[data-testid=rationale-badge][data-key=safety]')
            badge.first.wait_for(timeout=10000)
            report("rationale-badge[data-key=safety]", "PASS" if badge.count() > 0 else "FAIL")
            arm = page.locator('[data-testid=arm-attribution][data-driver=all_arms]')
            report("arm-attribution[data-driver=all_arms]", "PASS" if arm.count() > 0 else "FAIL",
                   page.locator("[data-testid=arm-attribution]").first.get_attribute("data-driver") or "missing")

        # 4. Density at 1440x900: classification and the first badge are above the fold.
        box = page.get_by_test_id("classification").bounding_box()
        fold_ok = box is not None and box["y"] + box["height"] < 900
        detail = f"classification bottom={box['y'] + box['height']:.0f}" if box else "no box"
        if rationale_status == 200:
            bbox = page.get_by_test_id("rationale-badge").first.bounding_box()
            fold_ok = fold_ok and bbox is not None and bbox["y"] + bbox["height"] < 900
            detail += f", badge bottom={bbox['y'] + bbox['height']:.0f}" if bbox else ", no badge box"
        report("density: classification and badge above 900px", "PASS" if fold_ok else "FAIL", detail)
        clean, out = grep_empty(r"min-h-\[380px\]\|pb-96")
        report("density: no min-h-[380px] or pb-96 in web-next/app", "PASS" if clean else "FAIL", out)

        # 5. FDA copy: no date-based explanation; the Rationale tab says passages are general.
        clean, out = grep_empty("retrospective and not counted\\|retrospective: issued after")
        report("FDA copy: no retrospective-not-counted strings", "PASS" if clean else "FAIL", out)
        rationale_text = page.get_by_role("tabpanel").inner_text()
        report("Rationale tab text contains 'general'", "PASS" if "general" in rationale_text else "FAIL")
        page.screenshot(path=str(SHOTS / "review-rationale-1440.png"), full_page=True)

        # 3. Wording over every tab's innerText.
        problems: dict[str, list[str]] = {"landing": landing_problems} if landing_problems else {}
        for tab in TABS:
            page.goto(review_url(tab=tab), wait_until="networkidle")
            page.get_by_role("tabpanel").wait_for(timeout=15000)
            page.wait_for_timeout(1200)
            found = wording_problems(visible_text(page))
            if found:
                problems[tab] = found
            page.screenshot(path=str(SHOTS / f"review-{tab}-1440.png"), full_page=True)
        report("wording scan on landing and every tab", "PASS" if not problems else "FAIL",
               json.dumps(problems, ensure_ascii=False)[:600] if problems else "")

        # Verify tab runs and shows an outcome.
        page.goto(review_url(tab="verify"), wait_until="networkidle")
        label = page.get_by_test_id("examples-label")
        # The label is styled uppercase, so compare its DOM text, not the rendered case.
        label_ok = label.count() > 0 and "Example arguments written by the ProtocolOS team" in (label.first.text_content() or "")
        report("Verify examples are labelled as the team's examples", "PASS" if label_ok else "FAIL")
        run = page.locator("[data-testid^=challenge-]").first
        if run.count() == 0:
            report("tab-verify runs and shows an outcome", "FAIL", "no example button")
        else:
            run.click()
            outcome = page.locator("[data-testid^=outcome-]").first
            try:
                outcome.wait_for(timeout=30000)
                report("tab-verify runs and shows an outcome", "PASS", outcome.inner_text())
            except Exception as exc:  # noqa: BLE001 - reported as a failed step
                report("tab-verify runs and shows an outcome", "FAIL", str(exc)[:200])

        # Verify "Try another limit": a criterion without worked examples gets a verdict; hemoglobin also shows the
        # NHANES share with its caveat. The wording rule still holds once the verifier's output is on screen.
        for criterion, population in (("washout_corticosteroid", False), ("hemoglobin", True)):
            step = f"Verify 'Try another limit' on {criterion}"
            page.goto(review_url(criterion, tab="verify"), wait_until="networkidle")
            try:
                page.get_by_test_id("whatif-value").wait_for(timeout=15000)
                proposed = page.get_by_test_id("whatif-value").input_value()
                page.get_by_test_id("whatif-run").click()
                page.get_by_test_id("whatif-outcome").wait_for(timeout=15000)
                outcome = page.get_by_test_id("whatif-outcome").inner_text()
                line = page.get_by_test_id("whatif-population")
                pop_ok = (line.count() == 1 and "not an oncology patient eligibility estimate" in line.inner_text()) if population else True
                found = wording_problems(visible_text(page))
                ok = bool(outcome) and pop_ok and not found
                report(step, "PASS" if ok else "FAIL",
                       f"{proposed} -> {outcome}" + ("" if pop_ok else ", NHANES line or caveat missing") + (f", wording {found}" if found else ""))
            except Exception as exc:  # noqa: BLE001 - reported as a failed step
                report(step, "FAIL", str(exc)[:200])

        # Decide: a structured reason and a fresh note reach the markdown packet (needs WS-E's reason buttons).
        page.goto(review_url(tab="decide"), wait_until="networkidle")
        page.wait_for_timeout(800)
        reason = page.get_by_test_id("reason-safety_concern")
        step = "decide -> packet md has 'Reason: Safety concern. Note: <nonce>'"
        if reason.count() == 0:
            report(step, "SKIP", "reason-safety_concern not merged")
        else:
            # A unique note proves this run's decision reached the packet, not an earlier one.
            nonce = f"e2e-{uuid.uuid4().hex[:8]}"
            reason.click()
            page.get_by_test_id("decision-note").fill(nonce)
            page.get_by_test_id("decide-needs_medical_review").click()
            try:
                page.get_by_test_id("saved-decision").filter(has_text=nonce).wait_for(timeout=15000)
                packet = page.evaluate(
                    "async (n) => await (await fetch('/api/packet/' + n + '?format=md')).text()", NCT
                )
                expected = f"Reason: Safety concern. Note: {nonce}"
                report(step, "PASS" if expected in packet else "FAIL", expected)
            except Exception as exc:  # noqa: BLE001
                report(step, "FAIL", str(exc)[:200])

        # 6. Phone width: no horizontal scroll at 390px on the landing, every review tab and the Compare plot of
        # every EL3 criterion (the plot is the widest view); screenshots at both sizes.
        phone = browser.new_context(viewport={"width": 390, "height": 844})
        mobile = phone.new_page()
        pages = [("landing", f"{BASE_URL}/")] + [(f"review-{t}", review_url(tab=t)) for t in TABS]
        mobile.goto(review_url(), wait_until="networkidle")
        mobile.get_by_test_id("criterion-item").first.wait_for(timeout=15000)
        criteria = mobile.eval_on_selector_all("[data-testid=criterion-item]", "els => els.map(e => e.dataset.criterion)")
        pages += [(f"compare-{c}", review_url(c, tab="compare")) for c in criteria if c != "hemoglobin"]
        widths = {}
        for name, url in pages:
            mobile.goto(url, wait_until="networkidle")
            mobile.get_by_role("tabpanel").or_(mobile.get_by_test_id("mode-review")).first.wait_for(timeout=15000)
            mobile.wait_for_timeout(600)
            widths[name] = mobile.evaluate("document.documentElement.scrollWidth")
            if not name.startswith("compare-"):
                mobile.screenshot(path=str(SHOTS / f"{name}-390.png"), full_page=True)
        wide = {k: w for k, w in widths.items() if w > 390}
        report(f"no horizontal scroll at 390px ({len(widths)} pages)", "PASS" if not wide else "FAIL",
               json.dumps(wide) if wide else "")
        browser.close()

    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    passed = [r for r in results if r[1] == "PASS"]
    print(f"summary: {len(passed)} pass, {len(failed)} fail, {len(skipped)} skip; screenshots in {SHOTS}")
    if failed or (args.strict and skipped):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
