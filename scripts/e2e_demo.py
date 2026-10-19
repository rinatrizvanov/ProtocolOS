"""End-to-end check of the demo flow on the vanilla dashboard in a real browser.

    python3.13 -m venv /tmp/pw && /tmp/pw/bin/pip install playwright && /tmp/pw/bin/playwright install chromium
    BASE_URL=http://localhost:8765 /tmp/pw/bin/python scripts/e2e_demo.py
    BASE_URL=https://<demo-url> /tmp/pw/bin/python scripts/e2e_demo.py [--write-decision]

Steps: (1) load NCT03409614; (2) select hemoglobin, see "Review recommended"; (3) open the graph tab, see >= 3
comparator nodes; (4) click a comparator passage, the viewer shows that page; (5) ask "Why was this flagged?",
every statement is supported or uncertain and no check fails; (6) load the ANC "PD-1 is not myelosuppressive"
example and verify -> Rejected; (7) record "Needs medical review" in the packet tab; (8) export Markdown and
find the decision in it; (9) only for a non-localhost BASE_URL: `refresh=1` is refused.
Steps 3-5 report "skipped: graph UI not installed" when the page has no graph tab; a skip is never a pass.
Screenshots and summary.json go to E2E_OUT (default /tmp/protocolos-logs/e2e/). Exit 1 if any step fails.
Step 7 writes a real decision in this browser's own session (data/decisions/sessions/<session>/ on the server), so no
other visitor sees it:
- local BASE_URL: the session's folder under E2E_DECISIONS_DIR (default: this checkout's data/decisions) is removed
  after step 8.
- non-local BASE_URL: step 7 is skipped and step 8 checks only the export, unless --write-decision is passed; the
  session's decision then stays on the server until it is redeployed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:8765").rstrip("/")
OUT = Path(os.environ.get("E2E_OUT", "/tmp/protocolos-logs/e2e"))
NCT = "NCT03409614"
LOCAL = urlparse(BASE).hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
STAMP = time.strftime("%Y-%m-%d %H:%M:%S")
REASON = f"e2e demo check {STAMP}"
ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = Path(os.environ.get("E2E_DECISIONS_DIR", ROOT / "data" / "decisions"))


class Skip(Exception):
    pass


def _remove_session(session: str) -> str:
    """Delete the test session's decisions on a local server."""
    folder = DECISIONS_DIR / "sessions" / session
    saved = folder / f"{NCT}.json"
    if not saved.exists() or REASON not in saved.read_text():
        return f"not removed: {saved} does not hold the test decision (set E2E_DECISIONS_DIR)"
    saved.unlink()
    folder.rmdir()
    return f"removed the test session's decisions ({folder})"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write-decision", action="store_true",
                    help="record the step 7 test decision on a non-local BASE_URL (it stays there)")
    args = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    results, errors = [], []
    state: dict = {"written": False, "session": "", "restore": "not needed: step 7 wrote nothing"}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.set_default_timeout(30_000)

        def shot(n, name):
            page.screenshot(path=str(OUT / f"step{n}-{name}.png"), full_page=False)

        def graph_ui():
            if not page.locator('.tab[data-tab="graph"]').count():
                raise Skip("graph UI not installed")

        def step1():
            page.goto(f"{BASE}/?nct={NCT}", timeout=120_000)
            page.wait_for_selector("#criteria .crit", timeout=120_000)
            got = page.locator("#study a.nct").inner_text().strip()
            shot(1, "review-loaded")
            assert got == NCT, f"study header shows {got!r}"
            return f"{page.locator('#criteria .crit').count()} criteria listed for {got}"

        def step2():
            page.click('#criteria .crit[data-id="hemoglobin"]')
            page.wait_for_selector("#detail h2")
            head = page.locator("#detail h2").first.inner_text()
            cls = page.locator("#detail .card .cls").first.inner_text().strip()
            shot(2, "hemoglobin")
            assert "Hemoglobin" in head, f"detail header {head!r}"
            assert cls == "Review recommended", f"classification {cls!r}"
            return f"{head.strip()} -> {cls}"

        def step3():
            graph_ui()
            page.click('.tab[data-tab="graph"]')
            page.wait_for_selector('#graph[data-state="ready"], #graph[data-state="error"], #graph[data-state="empty"], #graph[data-state="no-protocol"]', timeout=60_000)
            if page.locator("#graph-criterion").count():
                page.select_option("#graph-criterion", "hemoglobin")
            page.wait_for_selector('#graph[data-state="ready"]', timeout=60_000)
            page.wait_for_selector('g.gnode[data-node-type="ComparatorThreshold"]')
            n = page.locator('g.gnode[data-node-type="ComparatorThreshold"]').count()
            shot(3, "graph")
            assert n >= 3, f"{n} comparator nodes"
            return f"{n} comparator nodes, {page.locator('g.gnode').count()} nodes, {page.locator('[data-edge-id]').count()} edges"

        def step4():
            graph_ui()
            page.locator('g.gnode[data-node-type="ComparatorThreshold"]').first.click()
            link = page.locator("#graph-panel a.src-link[data-nct][data-page]").first
            link.wait_for()
            nct, pno = link.get_attribute("data-nct"), link.get_attribute("data-page")
            link.click()
            page.wait_for_selector("#modal:not(.hidden) #modalContent h3", timeout=60_000)
            h3 = page.locator("#modalContent h3").inner_text()
            shot(4, "source-viewer")
            page.click(".modal-close")
            assert nct in h3 and f"page {pno}" in h3, f"viewer header {h3!r}"
            return h3.strip()

        def step5():
            graph_ui()
            page.click('button.inv-q[data-question="why_flagged"]')
            page.wait_for_selector("#inv-answer .inv-statement", timeout=60_000)
            statuses = [s.get_attribute("data-status") for s in page.locator("#inv-answer .inv-statement").all()]
            checks = [c.get_attribute("data-result") for c in page.locator(".inv-check").all()]
            model = page.locator("[data-model-status]").first.get_attribute("data-model-status") if page.locator("[data-model-status]").count() else None
            shot(5, "why-flagged")
            assert statuses and all(s in ("supported", "uncertain") for s in statuses), f"statement statuses {statuses}"
            assert checks and "fail" not in checks, f"check results {checks}"
            return f"{len(statuses)} statements {statuses}; checks pass={checks.count('pass')} warn={checks.count('warn')}; model status {model!r}"

        def step6():
            page.click('.tab[data-tab="review"]')
            page.select_option("#chExample", "naive")
            page.wait_for_function("document.querySelector('#chText') && document.querySelector('#chText').value.includes('myelosuppressive')")
            page.click("#chVerify")
            page.wait_for_selector("#verifyOut .vstatus", timeout=60_000)
            status = page.locator("#verifyOut .vstatus").first.inner_text().strip()
            fails = page.locator("#verifyOut .check .r.fail").count()
            shot(6, "anc-example-verified")
            assert status == "Rejected", f"verifier outcome {status!r}"
            return f"ANC example -> {status} ({fails} failing checks)"

        def step7():
            if not LOCAL and not args.write_decision:
                raise Skip("non-local BASE_URL: pass --write-decision to record a test decision (it stays in its session)")
            page.click('.tab[data-tab="packet"]')
            page.wait_for_selector('[data-save="hemoglobin"]', timeout=60_000)
            page.fill("#reviewerName", "e2e script")
            page.select_option('[data-dec="hemoglobin"]', "needs_medical_review")
            page.fill('[data-reason="hemoglobin"]', REASON)
            page.click('[data-save="hemoglobin"]')
            page.wait_for_function("document.querySelector('[data-saved=\"hemoglobin\"]').textContent.startsWith('saved: Needs medical review')")
            state["written"] = True
            state["session"] = page.evaluate("() => localStorage.getItem('protocolos.session.v1')") or ""
            shot(7, "decision-saved")
            return page.locator('[data-saved="hemoglobin"]').inner_text().strip()

        def step8():
            if not state["written"]:  # step 7 was skipped before it opened the packet tab
                page.click('.tab[data-tab="packet"]')
            link = page.locator("#packet a.btn-link", has_text="Export Markdown")
            with page.expect_download() as dl:
                link.click()
            path = dl.value.path()
            md = Path(path).read_text()
            saved = OUT / dl.value.suggested_filename
            saved.write_text(md)
            shot(8, "packet")
            if not state["written"]:
                assert NCT in md, f"{NCT} not found in the exported Markdown"
                return f"{saved.name}: exported ({len(md)} chars); decision line not checked, step 7 wrote no decision"
            assert "Needs medical review" in md and REASON in md, "decision not found in the exported Markdown"
            return f"{saved.name}: decision line found ({len(md)} chars)"

        def step9():
            if LOCAL:
                raise Skip("localhost BASE_URL (runs only against a deployed URL)")
            r = page.request.get(f"{BASE}/api/review/{NCT}?refresh=1")
            assert r.status == 403, f"refresh=1 answered {r.status}"
            return f"refresh=1 -> {r.status}"

        try:
            for n, fn in enumerate([step1, step2, step3, step4, step5, step6, step7, step8, step9], start=1):
                t0 = time.time()
                try:
                    detail, status = fn(), "PASS"
                except Skip as e:
                    detail, status = f"skipped: {e}", "SKIP"
                except Exception as e:  # noqa: BLE001
                    detail, status = f"{type(e).__name__}: {str(e).splitlines()[0][:300]}", "FAIL"
                    try:
                        shot(n, "failure")
                    except Exception:  # noqa: BLE001
                        pass
                results.append({"step": n, "status": status, "detail": detail, "seconds": round(time.time() - t0, 1)})
                print(f"step {n}: {status:4} {results[-1]['seconds']:5.1f} s  {detail}", flush=True)
        finally:
            browser.close()
            if state["written"] and LOCAL:
                state["restore"] = _remove_session(state["session"])
            elif state["written"]:
                state["restore"] = f"the test decision ({REASON!r}) stays in its own session on {BASE} until a redeploy"
            print(f"decisions: {state['restore']}", flush=True)

    summary = {"base_url": BASE, "ran_at": STAMP, "steps": results, "browser_errors": errors, "decisions": state["restore"]}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1))
    for e in errors:
        print("browser", e)
    failed = [r["step"] for r in results if r["status"] == "FAIL"]
    print(f"e2e: {sum(r['status'] == 'PASS' for r in results)} passed, {sum(r['status'] == 'SKIP' for r in results)} skipped, "
          f"{len(failed)} failed; screenshots in {OUT}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
