"""Browser check of the ProtocolOS web-next landing and /review.

Usage:
    BASE_URL=http://localhost:3765 /tmp/pw/bin/python scripts/e2e_review_next.py [--strict] [--data-dir DIR] [--write-decision]

Use localhost, not 127.0.0.1, against `next dev`: Next 16 blocks its dev resources for the 127.0.0.1 origin
unless next.config.ts lists it in allowedDevOrigins, and the page never hydrates.

Each step prints PASS, FAIL or SKIP. A step SKIPs when the piece it needs is missing from the deployment (for
example /api/rationale answers 404, or the Decide tab has no structured reason buttons). A skip is never a pass:
with --strict any SKIP makes the run fail. Screenshots go to /tmp/protocolos-logs/ui/ and, for the guided tour
(/tour#1..#7, same names and order as the /review tabs), /tmp/protocolos-logs/tour/.

The Decide step saves a decision in this run's own browser session (decisions are stored per session,
data/decisions/sessions/<session>/), so no other visitor sees it. Against a local BASE_URL the session's folder in the
engine's data directory (--data-dir, else $PROTOCOLOS_DATA_DIR, else this checkout's data/) is removed afterwards.
Against any other BASE_URL the step is skipped unless --write-decision is passed; the session's decision then stays on
that server until it is redeployed.
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
from urllib.parse import urlparse

from playwright.sync_api import Page, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3765").rstrip("/")
NCT = "NCT03409614"
SHOTS = Path("/tmp/protocolos-logs/ui")
TOUR_SHOTS = Path("/tmp/protocolos-logs/tour")
# The tour mirrors the /review tabs (Rationale, Compare, Ask, Redraft, Decide) between the overview and the guard step.
TOUR_STEPS = ("The rules", "Rationale", "Compare", "Ask", "Redraft", "Decide", "Tested")
REPO = Path(__file__).resolve().parents[1]
TABS = ("rationale", "compare", "ask", "verify", "decide")
BANNED = re.compile(r"feedback loop|learns from|safe to|will increase enrol", re.I)
# Any "evidence", including inside a word ("Counterevidence"), outside a verbatim quote is a wording problem.
EVIDENCE = re.compile(r"evidence", re.I)
QUESTIONS = ("why_flagged", "contradicting", "support_retaining", "what_would_change")
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


def is_local(url: str) -> bool:
    return (urlparse(url).hostname or "") in {"localhost", "127.0.0.1", "::1"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="treat any SKIP as a failure")
    parser.add_argument("--data-dir", default=os.environ.get("PROTOCOLOS_DATA_DIR", str(REPO / "data")),
                        help="the engine's data directory, for the decision backup (default: this checkout's data/)")
    parser.add_argument("--write-decision", action="store_true", help="also save a decision against a non-local BASE_URL")
    args = parser.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)
    TOUR_SHOTS.mkdir(parents=True, exist_ok=True)

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

        # 2. Review: rationale badge and arm line (need /api/rationale).
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

        # Redraft (tab-verify): on EL3 hemoglobin, a lowered limit gets a value_changed flag and a verifier status, and a
        # rationale claiming safety gets a fail-level overclaim flag. The wording rule still holds with the flags on screen.
        step = "Redraft flags a changed value and an overclaiming rationale (EL3 hemoglobin)"
        try:
            page.goto(review_url("hemoglobin", tab="verify", nct=NCT), wait_until="networkidle")
            box = page.get_by_test_id("redraft-input")
            box.wait_for(timeout=15000)
            page.locator("[data-testid=redraft-flag]").first.wait_for(timeout=30000)
            label_ok = page.get_by_test_id("tab-verify").inner_text().strip().endswith("Redraft")
            box.fill("Hemoglobin \u2265 9.0 g/dL")
            page.locator("[data-testid=redraft-flag][data-code=value_changed]").first.wait_for(timeout=30000)
            page.get_by_test_id("redraft-status").wait_for(timeout=15000)
            status = page.get_by_test_id("redraft-status").inner_text()
            page.get_by_test_id("redraft-rationale").fill("this change is safe")
            page.locator("[data-testid=redraft-flag][data-level=fail][data-code=overclaim]").first.wait_for(timeout=30000)
            codes = page.evaluate("() => [...document.querySelectorAll('[data-testid=redraft-flag]')]"
                                  ".map((e) => e.dataset.level + ':' + e.dataset.code)")
            found = wording_problems(visible_text(page))
            page.screenshot(path=str(SHOTS / "review-redraft-1440.png"), full_page=True)
            ok = label_ok and not found
            report(step, "PASS" if ok else "FAIL",
                   f"status={status!r}; flags={codes}" + ("" if label_ok else ", tab label is not Redraft")
                   + (f", wording {found}" if found else ""))
        except Exception as exc:  # noqa: BLE001 - reported as a failed step
            report(step, "FAIL", str(exc)[:200])

        # Ask: all four questions on EL3 hemoglobin. Each chip runs its question; the investigator's sentences are shown
        # verbatim inside a quote, so any "evidence" (also "Counterevidence") outside one is a wording problem. The score
        # line repeats the review's own points, never a count of statements.
        step = "Ask: 4 questions on EL3 hemoglobin, verbatim answers, score line equals the review"
        try:
            page.goto(review_url("hemoglobin", tab="ask"), wait_until="networkidle")
            page.get_by_test_id("question-why_flagged").wait_for(timeout=15000)
            for q in QUESTIONS:
                before = page.locator("[data-testid=chat-turn]").count()
                page.get_by_test_id(f"question-{q}").click()
                page.wait_for_function(
                    "(n) => document.querySelectorAll('[data-testid=chat-turn]').length > n"
                    " && !document.body.innerText.includes('Checking the sources')", arg=before, timeout=30000)
            statements = page.locator("[data-testid=statement]").count()
            outside = page.evaluate("() => [...document.querySelectorAll('[data-testid=statement]')]"
                                    ".filter((s) => !s.closest('[data-role=quote]')).length")
            scores = page.evaluate("async (n) => (await (await fetch('/api/review/' + n)).json()).reviews"
                                   ".find((r) => r.criterion.id === 'hemoglobin').scores", NCT)
            score_text = page.get_by_test_id("ask-score").inner_text()
            score_ok = f"+{scores['challenge']} against" in score_text and f"+{scores['support']} for" in score_text
            found = wording_problems(visible_text(page))
            page.screenshot(path=str(SHOTS / "review-ask-4q-1440.png"), full_page=True)
            ok = statements > 0 and outside == 0 and score_ok and not found
            report(step, "PASS" if ok else "FAIL",
                   f"{statements} statements, {outside} outside a quote; score {score_text!r} vs {scores}"
                   + (f"; wording {found[:4]}" if found else ""))
        except Exception as exc:  # noqa: BLE001 - reported as a failed step
            report(step, "FAIL", str(exc)[:200])

        # Compare on a trial where the engine found no similar trial: the caption says so instead of claiming agreement.
        step = "Compare claims no precedent on a trial without similar trials"
        bare = "NCT02819518"
        try:
            count = page.evaluate("async (n) => (await (await fetch('/api/review/' + n)).json()).comparators.length", bare)
            page.goto(review_url("anc", tab="compare", nct=bare), wait_until="networkidle")
            page.get_by_test_id("target-marker").wait_for(timeout=15000)
            compare_text = page.get_by_role("tabpanel").inner_text()
            ok = count == 0 and "No similar trial was found for this protocol." in compare_text
            report(step, "PASS" if ok else "FAIL", f"{count} similar trials")
        except Exception as exc:  # noqa: BLE001 - reported as a failed step
            report(step, "FAIL", str(exc)[:200])

        # Renal: these protocols state GFR, their similar trials creatinine clearance. The engine does not compare a
        # different measure, so Compare lists those trials apart from the plot.
        for nct in (NCT, "NCT03088540"):
            step = f"Compare keeps a different measure out of the comparison ({nct} renal)"
            try:
                directions = page.evaluate(
                    "async (n) => (await (await fetch('/api/review/' + n)).json()).comparison.renal"
                    ".filter((r) => r.criterion).map((r) => r.direction)", nct)
                page.goto(review_url("renal", tab="compare", nct=nct), wait_until="networkidle")
                page.get_by_test_id("target-marker").wait_for(timeout=15000)
                dots = page.get_by_test_id("comparator-dot").count()
                listed = page.get_by_test_id("other-measure-row").count()
                compare_text = page.get_by_role("tabpanel").inner_text()
                ok = bool(directions) and set(directions) == {"different measure"} and dots == 0 and listed == len(directions) \
                    and "use a different measure; not directly comparable." in compare_text
                report(step, "PASS" if ok else "FAIL", f"engine {directions}; dots={dots}, listed={listed}")
            except Exception as exc:  # noqa: BLE001 - reported as a failed step
                report(step, "FAIL", str(exc)[:200])

        # Decide: a structured reason and a fresh note reach the markdown packet (needs the structured reason
        # buttons). The decision lives in this run's browser session only.
        page.goto(review_url(tab="decide"), wait_until="networkidle")
        page.wait_for_timeout(800)
        reason = page.get_by_test_id("reason-safety_concern")
        step = "decide -> packet md has 'Reason: Safety concern. Note: <nonce>'"
        local = is_local(BASE_URL)
        session = page.evaluate("() => localStorage.getItem('protocolos.session.v1')") or ""
        decisions = Path(args.data_dir) / "decisions" / "sessions" / session
        if reason.count() == 0:
            report(step, "SKIP", "reason-safety_concern not on the page")
        elif not local and not args.write_decision:
            report(step, "SKIP", f"{BASE_URL} is not local; pass --write-decision to save a decision there")
        elif not re.fullmatch(r"[0-9a-f]{32}", session):
            report(step, "FAIL", f"no visitor session id in localStorage (got {session!r})")
        else:
            # A unique note proves this run's decision reached the packet, not an earlier one.
            nonce = f"e2e-{uuid.uuid4().hex[:8]}"
            try:
                reason.click()
                page.get_by_test_id("decision-note").fill(nonce)
                page.get_by_test_id("decide-needs_medical_review").click()
                checked = page.get_by_test_id("decide-needs_medical_review").get_attribute("aria-checked")
                page.get_by_test_id("save-decision").click()
                page.get_by_test_id("saved-decision").filter(has_text=nonce).wait_for(timeout=15000)
                packet = page.evaluate(
                    "async ([n, s]) => await (await fetch('/api/packet/' + n + '?format=md&session=' + s)).text()", [NCT, session]
                )
                expected = f"Reason: Safety concern. Note: {nonce}"
                report(step, "PASS" if expected in packet and checked == "true" else "FAIL",
                       f"{expected}; radio aria-checked={checked}")
            except Exception as exc:  # noqa: BLE001
                report(step, "FAIL", str(exc)[:200])
            finally:
                if local:
                    saved = decisions / f"{NCT}.json"
                    wrote = saved.exists() and nonce in saved.read_text()
                    if wrote:
                        saved.unlink()
                        decisions.rmdir()
                    report("decide: the session's decision written and removed", "PASS" if wrote and not decisions.exists() else "FAIL",
                           f"{decisions}" + ("" if wrote else " did not receive the decision (pass --data-dir)"))

        # 7. Guided tour: step names and order mirror the app, every step passes the wording rule, the Redraft step shows
        # the tour's prefilled draft with a value_changed flag and, after the labelled example note, an overclaim fail and
        # a rejected verifier status. The Decide step is only opened: the tour never saves a decision.
        tour_problems: dict[str, list[str]] = {}
        try:
            page.goto(f"{BASE_URL}/tour#1", wait_until="networkidle")
            page.get_by_test_id("tour-step").wait_for(timeout=15000)
            names = page.eval_on_selector_all("nav[aria-label='Demo steps'] ol button", "els => els.map(e => e.innerText.trim())")
            report("tour: step names and order mirror the app", "PASS" if tuple(names) == TOUR_STEPS else "FAIL", " / ".join(names))
            exit_href = page.get_by_test_id("exit-demo").get_attribute("href") or ""
            report("tour: Exit opens the review on EL3 hemoglobin",
                   "PASS" if exit_href == f"../review?nct={NCT}&c=hemoglobin" else "FAIL", exit_href)
            for i, name in enumerate(TOUR_STEPS, start=1):
                page.goto(f"{BASE_URL}/tour#{i}", wait_until="networkidle")
                page.locator(f"[data-testid=tour-step][data-step='{i}']").wait_for(timeout=15000)
                page.wait_for_timeout(1500)
                if name == "Rationale":
                    page.get_by_test_id("arm-attribution").wait_for(timeout=15000)
                if name == "Redraft":
                    page.locator("[data-testid=redraft-flag][data-code=value_changed]").first.wait_for(timeout=30000)
                found = wording_problems(visible_text(page))
                if found:
                    tour_problems[f"{i} {name}"] = found
                page.screenshot(path=str(TOUR_SHOTS / f"tour-{i}-{name.lower().replace(' ', '-')}-1440.png"), full_page=True)
            report("tour: wording scan on every step", "PASS" if not tour_problems else "FAIL",
                   json.dumps(tour_problems, ensure_ascii=False)[:600] if tour_problems else "")
        except Exception as exc:  # noqa: BLE001 - reported as a failed step
            report("tour: every step renders", "FAIL", str(exc)[:200])

        step = "tour: Rationale step shows the badges and the engine's arm sentence (all arms, chemotherapy)"
        try:
            page.goto(f"{BASE_URL}/tour#2", wait_until="networkidle")
            arm = page.get_by_test_id("arm-attribution")
            arm.wait_for(timeout=15000)
            driver = arm.get_attribute("data-driver")
            arm_text = arm.inner_text()
            badges = page.locator("[data-testid=rationale-badge]").count()
            ok = driver == "all_arms" and "Every arm" in arm_text and "chemotherapy" in arm_text and badges > 0
            report(step, "PASS" if ok else "FAIL", f"driver={driver}, badges={badges}")
        except Exception as exc:  # noqa: BLE001
            report(step, "FAIL", str(exc)[:200])

        step = "tour: Redraft step prefills Hemoglobin \u2265 9.0 g/dL (value_changed); the example note is rejected"
        try:
            page.goto(f"{BASE_URL}/tour#5", wait_until="networkidle")
            page.locator("[data-testid=redraft-flag][data-code=value_changed]").first.wait_for(timeout=30000)
            draft = page.get_by_test_id("redraft-input").input_value()
            labelled = page.get_by_test_id("redraft-tour-typed").is_visible()
            page.get_by_test_id("redraft-example-note").click()
            page.locator("[data-testid=redraft-flag][data-level=fail][data-code=overclaim]").first.wait_for(timeout=30000)
            page.locator("[data-testid=redraft-status][data-status=REJECTED]").wait_for(timeout=15000)
            note = page.get_by_test_id("redraft-rationale").input_value()
            note_labelled = page.get_by_test_id("redraft-note-typed").is_visible()
            found = wording_problems(visible_text(page))
            page.screenshot(path=str(TOUR_SHOTS / "tour-5-redraft-note-1440.png"), full_page=True)
            ok = draft == "Hemoglobin \u2265 9.0 g/dL" and labelled and note == "This change is safe." and note_labelled and not found
            report(step, "PASS" if ok else "FAIL",
                   f"draft={draft!r}, note={note!r}, labelled={labelled}/{note_labelled}" + (f", wording {found}" if found else ""))
        except Exception as exc:  # noqa: BLE001
            report(step, "FAIL", str(exc)[:200])

        step = "tour: Next, Back and arrow keys move between steps"
        try:
            page.goto(f"{BASE_URL}/tour#1", wait_until="networkidle")
            page.get_by_test_id("tour-next").click()
            page.locator("[data-testid=tour-step][data-step='2']").wait_for(timeout=5000)
            page.keyboard.press("ArrowRight")
            page.locator("[data-testid=tour-step][data-step='3']").wait_for(timeout=5000)
            page.keyboard.press("ArrowLeft")
            page.locator("[data-testid=tour-step][data-step='2']").wait_for(timeout=5000)
            page.get_by_test_id("tour-back").click()
            page.locator("[data-testid=tour-step][data-step='1']").wait_for(timeout=5000)
            report(step, "PASS")
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
        pages += [(f"tour-{i}-{n.lower().replace(' ', '-')}", f"{BASE_URL}/tour#{i}") for i, n in enumerate(TOUR_STEPS, start=1)]
        widths = {}
        for name, url in pages:
            mobile.goto(url, wait_until="networkidle")
            if name.startswith("tour-"):
                # A hash-only change does not reload the page; reload so each step mounts from its own URL.
                mobile.reload(wait_until="networkidle")
                mobile.get_by_test_id("tour-step").wait_for(timeout=15000)
                mobile.wait_for_timeout(1500)
            else:
                mobile.get_by_role("tabpanel").or_(mobile.get_by_test_id("mode-review")).first.wait_for(timeout=15000)
                mobile.wait_for_timeout(600)
            widths[name] = mobile.evaluate("document.documentElement.scrollWidth")
            if name.startswith("tour-"):
                mobile.screenshot(path=str(TOUR_SHOTS / f"{name}-390.png"), full_page=True)
            elif not name.startswith("compare-"):
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
