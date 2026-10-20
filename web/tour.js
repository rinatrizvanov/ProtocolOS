/* ProtocolOS guided demo. Drives the real UI rendered by app.js and graph.js; every number in a caption is
   read from a live API response or from the DOM the app rendered from one. Plain script, wrapped in an IIFE:
   it reuses the app.js globals ($, esc, fmtCrit, state, api, post, loadReview, loadExample) and declares none. */
(function () {
  "use strict";
  const NCT = "NCT03409614";
  const CID = "hemoglobin";
  const STEP_TIMEOUT_MS = 8000;
  const HINT_KEY = "tl_tour_hint_dismissed";
  const T = { active: false, i: 0, run: 0, hole: null, card: null, target: null, raf: 0 };

  // ------------------------------------------------------------ helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs = (s, el = document) => el.querySelector(s);
  const h = (s) => esc(s);

  function waitFor(fn, expected, ms = STEP_TIMEOUT_MS) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function poll() {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > ms) return reject(new Error(`Expected ${expected}, but it did not appear.`));
        setTimeout(poll, 100);
      })();
    });
  }

  async function getJSON(path, opts) {
    let r;
    try { r = await fetch(path, opts); } catch (e) { throw new Error(`${path.split("?")[0]} could not be reached (${e.message}).`); }
    if (!r.ok) throw new Error(`${path} answered HTTP ${r.status}`);
    return r.json();
  }

  function clickTab(name) {
    const t = qs(`.tab[data-tab="${name}"]`);
    if (!t) throw new Error(`Expected the "${name}" tab button (.tab[data-tab="${name}"]).`);
    if (!t.classList.contains("active")) t.click();
    return t;
  }

  function closeModal() {
    const m = qs("#modal");
    if (m && !m.classList.contains("hidden")) m.classList.add("hidden");
  }

  async function ensureReview() {
    clickTab("review");
    if (!(state.review && state.nct === NCT)) {
      if (qs("#nct")) qs("#nct").value = NCT;
      loadReview(NCT, "auto");
    }
    await waitFor(() => state.review && state.review.target.study.nct_id === NCT && qs(`#criteria .crit[data-id="${CID}"]`),
      `the review of ${NCT} with its criteria list`);
    return state.review;
  }

  function reviewOf(id) {
    return state.review.reviews.find((r) => r.criterion.id === id);
  }

  let graphCache = null;
  async function graphData() {
    graphCache = await getJSON(`/api/graph/${NCT}?criterion_id=${CID}`);
    return graphCache;
  }

  async function ensureGraph() {
    await ensureReview();
    clickTab("graph");
    const sel = await waitFor(() => qs("#graph-criterion"), "the criterion selector #graph-criterion in the Evidence graph tab");
    await waitFor(() => [...sel.options].some((o) => o.value === CID), `"${CID}" in the graph criterion selector`);
    if (sel.value !== CID) { sel.value = CID; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    await waitFor(() => {
      const g = qs("#graph");
      if (g && g.dataset.state === "error") throw new Error("graph error");
      return g && g.dataset.state === "ready" && qs("#graph g.gnode");
    }, `#graph[data-state="ready"] with nodes`);
    return qs("#graph");
  }

  function firstSentence(t) {
    t = String(t || "").trim();
    const m = t.match(/^.{20,220}?[.;](\s|$)/);
    return m ? m[0].trim() : t.length > 220 ? t.slice(0, t.lastIndexOf(" ", 220)) + "…" : t;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const frac = (p) => (Array.isArray(p) ? `${p[0]}/${p[1]}` : "n/a");
  const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

  // ------------------------------------------------------------ steps
  // Each step drives the real UI and returns { target, html } where html is the caption.
  const STEPS = [
    {
      title: "What ProtocolOS checks",
      async run() {
        const rv = await ensureReview();
        const counts = {};
        rv.reviews.forEach((r) => (counts[r.classification] = (counts[r.classification] || 0) + 1));
        const st = rv.target.study;
        const name = st.acronym ? `<b>${h(st.acronym)}</b> (${NCT})` : `<b>${NCT}</b>, <i>${h(st.title || "")}</i>,`;
        const pills = ["Review recommended", "Evidence supports retaining", "Insufficient evidence"]
          .map((k) => `<span class="tour-pill ${clsKey(k)}">${counts[k] || 0} ${h(k)}</span>`).join("");
        return {
          target: qs("#summary .summary") || qs("#summary"),
          html: `<p class="tour-plain">Before a clinical trial starts, its protocol lists <b>entry rules</b> (eligibility criteria), for example
            a minimum blood hemoglobin level. Rules that are stricter than needed can shut out patients who could have joined.
            ProtocolOS checks each rule against the evidence and flags the ones the team should look at again.</p>
            <p>Here: ${name} is loaded from its public protocol PDF: <b>${rv.reviews.length} eligibility criteria</b> reviewed against
            ${plural(rv.comparators.length, "comparable trial")}.</p><div class="tour-pills">${pills}</div>
            <p class="tour-note">Each criterion balances safety, enrichment and generalizability. ProtocolOS prepares the rationale; the protocol team decides.</p>`,
        };
      },
    },
    {
      title: "One rule it questions",
      dock: "left",
      async run() {
        await ensureReview();
        const item = qs(`#criteria .crit[data-id="${CID}"]`);
        if (!item) throw new Error(`Expected the criterion list item .crit[data-id="${CID}"].`);
        if (state.selected !== CID) item.click();
        await waitFor(() => state.selected === CID && qs("#detail .card h2"), "the hemoglobin detail card");
        const r = reviewOf(CID);
        item.scrollIntoView({ block: "nearest" });
        return {
          target: qs("#detail .card"),
          html: `<p><b>${h(r.criterion.label)} ${h(fmtCrit(r.criterion))}</b> is classified
            <span class="tour-pill ${clsKey(r.classification)}">${h(r.classification)}</span></p>
            <div class="tour-scores"><span class="tour-score support">support ${r.scores.support}</span><span class="tour-score challenge">challenge ${r.scores.challenge}</span></div>
            <p class="tour-note">A review question for the team, not a finding that the threshold is wrong.</p>`,
        };
      },
    },
    {
      title: "Why it was questioned",
      dock: "left",
      async run() {
        const root = await ensureGraph();
        const d = await graphData();
        const byId = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
        const rules = d.nodes.filter((n) => n.type === "ScoreRule");
        const looser = rules.find((n) => n.data.group === "looser_comparators");
        const regimen = rules.find((n) => n.data.group === "regimen_support");
        const guidance = d.nodes.filter((n) => n.type === "GuidancePassage");
        const retro = guidance.filter((n) => n.data.retrospective).length;
        const gIds = new Set(guidance.map((n) => n.id));
        const gPoints = d.edges.filter((e) => gIds.has(e.from) || gIds.has(e.to)).reduce((s, e) => s + (e.points || 0), 0);
        const vals = looser ? [...new Set(looser.data.members.map((m) => byId[m] && (byId[m].data.display || `${byId[m].data.operator}${byId[m].data.value_norm} ${byId[m].data.unit_norm}`)).filter(Boolean))] : [];
        const lines = [];
        if (looser) lines.push(`<li><span class="tour-dot challenge"></span><b>+${looser.data.points} challenge</b>: ${plural(looser.data.members.length, "comparable trial")} used a lower threshold (${h(vals.join(", "))}), precedent for review.</li>`);
        if (regimen) lines.push(`<li><span class="tour-dot support"></span><b>+${regimen.data.points} support</b>: the regimen supports having <i>a</i> threshold, not this value.</li>`);
        lines.push(`<li><span class="tour-dot context"></span><b>${gPoints >= 0 ? "+" : ""}${gPoints} points</b>: ${plural(guidance.length, "FDA passage")}${retro === guidance.length && guidance.length ? ", all retrospective (issued after the trial started)" : retro ? `, ${retro} retrospective` : ""}.</li>`);
        return {
          target: qs("#graph svg") || root,
          html: `<p>How the flag adds up. Each box is a piece of evidence; each line shows whether it argues for or against the rule (${d.nodes.length} pieces in all).</p><ul class="tour-list">${lines.join("")}</ul>`,
        };
      },
    },
    {
      title: "Check the source yourself",
      async run() {
        await ensureGraph();
        const d = await graphData();
        const looser = d.nodes.find((n) => n.type === "ScoreRule" && n.data.group === "looser_comparators");
        const id = (looser && looser.data.members[0]) || (d.nodes.find((n) => n.type === "ComparatorThreshold") || {}).id;
        const node = id && qs(`#graph g.gnode[data-node-id="${CSS.escape(id)}"]`);
        if (!node) throw new Error(`Expected a comparator node g.gnode[data-node-type="ComparatorThreshold"] in the graph.`);
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const link = await waitFor(() => qs("#graph-panel a.src-link[data-page]"), "a source link (a.src-link[data-page]) in #graph-panel");
        link.click();
        await waitFor(() => !qs("#modal").classList.contains("hidden") && qs("#modalContent h3"), "the protocol page viewer to load");
        const n = d.nodes.find((x) => x.id === id);
        const marked = !!qs("#modalContent mark");
        return {
          target: qs("#modal .modal-body"),
          html: `<p><b>${h(n.label)}</b>: clicking the comparator opened page <b>${h(link.dataset.page)}</b> of
            ${h(link.dataset.nct)}'s own protocol${marked ? ", with the quoted threshold highlighted" : ""}.</p>
            <p class="tour-note">Every number in the graph links back to the document it came from.</p>`,
          cleanup: closeModal,
        };
      },
    },
    {
      title: "Ask why, get checked answers",
      async run() {
        closeModal();
        await ensureGraph();
        const btn = qs('button.inv-q[data-question="why_flagged"]');
        if (!btn) throw new Error('Expected the investigator button button.inv-q[data-question="why_flagged"].');
        const out = qs("#inv-answer");
        if (out.dataset.state !== "ready") btn.click();
        await waitFor(() => {
          const s = qs("#inv-answer").dataset.state;
          if (s === "error") throw new Error("investigator error");
          return s === "ready" || s === "empty";
        }, "the investigator answer (#inv-answer ready)");
        const stmts = document.querySelectorAll("#inv-answer .inv-statement");
        const unsupported = document.querySelectorAll('#inv-answer .inv-statement[data-status="unsupported"]').length;
        const checks = document.querySelectorAll("#inv-answer .inv-check");
        const passed = document.querySelectorAll('#inv-answer .inv-check[data-result="pass"]').length;
        const sec = (qs("#inv-security") || {}).innerText || "";
        const tools = (sec.match(/tools?\s*\d+\s*\/\s*\d+/i) || [""])[0];
        const model = (sec.match(/model calls?\s*\d+\s*\/\s*\d+/i) || [""])[0];
        const time = (sec.match(/\d+(\.\d+)?\s*s\b/) || [""])[0];
        const box = qs("#inv-answer").closest(".inv, section, .card") || qs("#inv-answer");
        box.scrollIntoView({ block: "center" });
        return {
          target: box,
          html: `<p>The bounded investigator answered with <b>${plural(stmts.length, "statement")}</b>${unsupported ? ` (${unsupported} unsupported, shown struck through)` : ""},
            backed by ${passed} of ${checks.length} passing deterministic checks. Counterevidence is always gathered.</p>
            <p class="tour-note">Safeguards: ${h([tools, model, time].filter(Boolean).join(" · ") || "see the panel")}. Model mode is not configured, so no model was called.</p>`,
        };
      },
    },
    {
      title: "A wrong argument is caught",
      dock: "left",
      async run() {
        closeModal();
        await ensureReview();
        loadExample("naive");
        await waitFor(() => state.selected === "anc" && qs("#chVerify") && qs("#claims .claim"), "the ANC example in the challenge form");
        qs("#verifyOut").innerHTML = "";
        qs("#chVerify").click();
        const vs = await waitFor(() => qs("#verifyOut .vstatus"), "the verifier result (#verifyOut .vstatus)");
        const fails = [...document.querySelectorAll("#verifyOut .check")].filter((c) => qs(".r.fail", c));
        const first = fails[0];
        return {
          target: qs("#verifyOut"),
          html: `<p>Input: <i>"PD-1 is not myelosuppressive, so the ANC floor can be lowered."</i> The deterministic verifier says
            <span class="tour-verdict ${vs.classList.contains("REJECTED") ? "rej" : ""}">${h(vs.textContent.trim())}</span>
            with ${plural(fails.length, "failed check")}.</p>
            ${first ? `<p class="tour-note">Failed: ${h(qs(".c", first).childNodes[0].textContent.trim())}. ${h(firstSentence(first.lastElementChild.textContent))}</p>` : ""}`,
        };
      },
    },
    {
      title: "Built-in safety",
      async run() {
        closeModal();
        const probes = [
          { label: "Force a recompute", req: `GET /api/review/${NCT}?refresh=1`, url: `/api/review/${NCT}?refresh=1`, expect: 403, meaning: "refresh refused on the public demo" },
          { label: "Path traversal", req: "GET ?as_of=../../x", url: `/api/review/${NCT}?as_of=../../x`, expect: 400, meaning: "path traversal rejected" },
          { label: "Model endpoint", req: "POST /api/critique", url: "/api/critique", opts: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nct: NCT, criterion_id: CID }) }, expect: 503, meaning: "model endpoints disabled on the public demo" },
        ];
        const res = await Promise.all(probes.map(async (p) => {
          try { const r = await fetch(p.url, p.opts); return { ...p, code: r.status }; } catch (e) { return { ...p, code: "network error" }; }
        }));
        const rows = res.map((p) => `<div class="tour-probe"><span class="tour-code ${p.code === p.expect ? "ok" : "bad"}">${h(p.code)}</span>
          <div><div class="tour-req">${h(p.req)}</div><div>${p.code === p.expect ? h(p.meaning) : `unexpected status (expected ${p.expect})`}</div></div></div>`).join("");
        return {
          target: null,
          html: `<p>Three real requests, fired just now against this server:</p>${rows}
            <p class="tour-note">Least privilege on the public deploy: inputs validated, no recompute, no paid model calls.</p>`,
        };
      },
    },
    {
      title: "How accurate it is",
      async run() {
        closeModal();
        clickTab("evals");
        const [pl, ev] = await Promise.all([getJSON("/api/planted"), getJSON("/api/evals")]);
        await waitFor(() => { const e = qs("#evals"); return e && e.children.length && !qs("#evals .loading"); }, "the Evaluation tab content");
        const s = (pl && pl.summary) || {};
        const st = s.stricter || {}, lo = s.looser || {};
        const su = (ev && ev.suites) || {};
        const ex = su.extraction || {}, vf = (su.verifier || {}), det = vf.deterministic || {};
        const items = [];
        if (st.n) items.push(`<li>Planted stricter thresholds: escalated <b>${frac(st.escalated_strict)}</b> (strict count), ${frac(st.escalated_lenient)} (lenient).</li>`);
        if (lo.n) items.push(`<li>Planted looser thresholds wrongly flagged: <b>${frac(lo.false_over_restriction_flags)}</b>.</li>`);
        if (ex.protocols) items.push(`<li>Extraction field accuracy <b>${pct(ex.field_accuracy)}</b> on ${ex.protocols} protocols.</li>`);
        if (vf.n_faults) items.push(`<li>Verifier: <b>${Math.round(det.fault_catch_rate * vf.n_faults)}/${vf.n_faults}</b> planted faults rejected, ${Math.round(det.false_rejection_rate * vf.n_valid)}/${vf.n_valid} valid ones wrongly rejected.</li>`);
        if (!items.length) throw new Error("Expected evaluation numbers from /api/planted and /api/evals.");
        const cards = [...document.querySelectorAll("#evals .card")];
        const kpi = cards.find((c) => /planted/i.test((c.querySelector("h2,h3") || {}).textContent || "")) || cards.find((c) => /gold labels/i.test(c.textContent)) || qs("#evals");
        return {
          target: kpi,
          html: `<ul class="tour-list plain">${items.join("")}</ul><p class="tour-note">${h(s.label || "Synthetic modifications; not clinical validation.")}</p>`,
        };
      },
    },
    {
      title: "The team decides",
      dock: "top",
      async run() {
        closeModal();
        await ensureReview();
        clickTab("packet");
        const sel = await waitFor(() => qs(`#packet [data-dec="${CID}"]`), `the packet decision control [data-dec="${CID}"]`);
        const item = sel.closest(".packet-item");
        sel.value = "needs_medical_review";
        const reason = qs(`#packet [data-reason="${CID}"]`);
        if (reason) reason.value = "Comparable trials used a lower threshold; the hemoglobin floor needs a clinical decision.";
        const who = qs("#reviewerName");
        if (who && !who.value) who.value = "Protocol review (demo)";
        const saved = qs(`#packet [data-saved="${CID}"]`);
        const before = saved ? saved.textContent : "";
        qs(`#packet [data-save="${CID}"]`).click();
        await waitFor(() => { const t = qs(`#packet [data-saved="${CID}"]`).textContent; return t !== before && t.startsWith("saved:") ? t : t !== before && t; }, "the saved decision confirmation");
        const t = qs(`#packet [data-saved="${CID}"]`).textContent;
        if (!t.startsWith("saved:")) throw new Error(`The decision was not saved: ${t}`);
        const row = sel.closest(".form-row") || item;
        return {
          target: row,
          html: `<p>Decision recorded in the review packet: <b>${h(t.replace(/^saved:\s*/, ""))}</b>.</p>
            <p class="tour-note">The packet exports as Markdown, printable HTML or JSON, with every source attached. That is the end of the tour.</p>`,
        };
      },
    },
  ];

  // ------------------------------------------------------------ UI
  function build() {
    if (T.card) return;
    T.hole = document.createElement("div");
    T.hole.className = "tour-hole";
    T.shade = document.createElement("div");
    T.shade.className = "tour-shade";
    T.shade.innerHTML = '<div data-s="t"></div><div data-s="b"></div><div data-s="l"></div><div data-s="r"></div>';
    T.card = document.createElement("div");
    T.card.className = "tour-card";
    T.card.setAttribute("role", "dialog");
    T.card.setAttribute("aria-label", "Guided demo");
    document.body.append(T.shade, T.hole, T.card);
  }

  function dots() {
    return STEPS.map((_, k) => `<button type="button" class="tour-dotnav ${k === T.i ? "on" : k < T.i ? "done" : ""}" data-go="${k}" aria-label="Step ${k + 1}"></button>`).join("");
  }

  const SHORT = ["What it checks", "One rule", "Why", "Source", "Ask why", "Wrong argument", "Safety", "Accuracy", "Decision"];

  function renderBar() {
    let bar = qs("#tourBar");
    if (!bar) {
      bar = document.createElement("nav");
      bar.id = "tourBar";
      bar.setAttribute("aria-label", "Demo steps");
      bar.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b && T.active) go(+b.dataset.go); });
      const tabs = qs(".tabs");
      (tabs ? tabs.parentNode : document.body).insertBefore(bar, tabs || document.body.firstChild);
    }
    bar.innerHTML = STEPS.map((_, k) => `<button type="button" data-go="${k}" class="${k === T.i ? "on" : k < T.i ? "done" : ""}"><span>${k + 1}</span>${h(SHORT[k] || "")}</button>`).join("");
  }

  function renderCard(body, mode) {
    renderBar();
    const s = STEPS[T.i];
    const last = T.i === STEPS.length - 1;
    T.card.dataset.mode = mode;
    T.card.innerHTML = `
      <div class="tour-head"><span class="tour-step">Step ${T.i + 1} of ${STEPS.length}</span>
        <button type="button" class="tour-x" data-act="close" aria-label="Close guided demo">×</button></div>
      <h3 class="tour-title">${h(s.title)}</h3>
      <div class="tour-body" aria-live="polite">${body}</div>
      <div class="tour-foot">
        <div class="tour-dots">${dots()}</div>
        <div class="tour-btns">
          <button type="button" class="tour-btn ghost" data-act="restart">Restart</button>
          <button type="button" class="tour-btn ghost" data-act="back" ${T.i === 0 ? "disabled" : ""}>Back</button>
          <button type="button" class="tour-btn primary" data-act="${last ? "close" : "next"}">${last ? "Finish" : "Next"}</button>
        </div>
      </div>`;
  }

  function setShade(top, left, w, hgt) {
    const S = (k) => T.shade.querySelector(`[data-s="${k}"]`);
    Object.assign(S("t").style, { top: "0px", left: "0px", width: "100vw", height: `${top}px` });
    Object.assign(S("b").style, { top: `${top + hgt}px`, left: "0px", width: "100vw", height: `${Math.max(innerHeight - top - hgt, 0)}px` });
    Object.assign(S("l").style, { top: `${top}px`, left: "0px", width: `${left}px`, height: `${hgt}px` });
    Object.assign(S("r").style, { top: `${top}px`, left: `${left + w}px`, width: `${Math.max(innerWidth - left - w, 0)}px`, height: `${hgt}px` });
  }

  function place() {
    if (!T.active || !T.hole) return;
    const el = T.target;
    if (!el || !el.isConnected || (el.offsetParent === null && getComputedStyle(el).position !== "fixed")) {
      T.hole.classList.add("none");
      setShade(innerHeight / 2, innerWidth / 2, 0, 0);
      T.card.classList.remove("left", "top");
      T.card.classList.toggle("center", T.card.dataset.mode === "ready" && !el);
    } else {
      const r = el.getBoundingClientRect();
      const pad = 8;
      const top = Math.max(r.top - pad, 4), left = Math.max(r.left - pad, 4);
      const bottom = Math.min(r.bottom + pad, innerHeight - 4), right = Math.min(r.right + pad, innerWidth - 4);
      const w = Math.max(right - left, 0), hgt = Math.max(bottom - top, 0);
      T.hole.classList.remove("none");
      T.card.classList.remove("center");
      Object.assign(T.hole.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${hgt}px` });
      setShade(top, left, w, hgt);
      // keep the card off the spotlight: if the target's right part sits under the card, move the card left
      const c = T.card.getBoundingClientRect();
      const cw = c.width + 48;
      const overlapsRight = right > innerWidth - cw && bottom > innerHeight - c.height - 48;
      const leftFree = left > cw || (r.left > innerWidth / 2);
      T.card.classList.toggle("top", T.dock === "top");
      T.card.classList.toggle("left", T.dock === "left" || (T.dock !== "right" && overlapsRight && (leftFree || r.width < innerWidth - cw)));
    }
    T.raf = requestAnimationFrame(place);
  }

  async function go(i) {
    if (i < 0 || i >= STEPS.length) return;
    const prev = STEPS[T.i];
    if (prev && prev._cleanup && i !== T.i) { try { prev._cleanup(); } catch (_) {} prev._cleanup = null; }
    T.i = i;
    const run = ++T.run;
    T.target = null;
    T.dock = null;
    renderCard(`<div class="tour-wait"><span class="tour-spin" aria-hidden="true"></span>Running this step on the live engine…</div>`, "loading");
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(`No result within ${STEP_TIMEOUT_MS / 1000} s.`)), STEP_TIMEOUT_MS + 200));
    try {
      const res = await Promise.race([STEPS[i].run(), timer]);
      if (run !== T.run || !T.active) return;
      STEPS[i]._cleanup = res.cleanup || null;
      T.target = res.target || null;
      T.dock = STEPS[i].dock || null;
      if (T.target) T.target.scrollIntoView({ behavior: "smooth", block: T.target.getBoundingClientRect().height > innerHeight * 0.7 ? "start" : "center" });
      renderCard(res.html, "ready");
    } catch (e) {
      if (run !== T.run || !T.active) return;
      renderCard(`<div class="tour-err"><b>This step could not finish.</b> ${h(e.message)}
        <div><button type="button" class="tour-btn" data-act="retry">Retry</button></div></div>`, "error");
    }
  }

  function start(at = 0) {
    build();
    hideHint();
    T.active = true;
    document.body.classList.add("demo", "tour-on");
    cancelAnimationFrame(T.raf);
    T.raf = requestAnimationFrame(place);
    go(at);
  }

  function stop() {
    T.active = false;
    T.run++;
    const s = STEPS[T.i];
    if (s && s._cleanup) { try { s._cleanup(); } catch (_) {} s._cleanup = null; }
    cancelAnimationFrame(T.raf);
    document.body.classList.remove("tour-on");
    if (!isDemoUrl()) document.body.classList.remove("demo");
    [T.card, T.hole, T.shade].forEach((el) => el && el.remove());
    T.card = T.hole = T.shade = null;
  }

  function onCardClick(e) {
    const b = e.target.closest("[data-act],[data-go]");
    if (!b || !T.card || !T.card.contains(b)) return;
    if (b.dataset.go != null) return go(+b.dataset.go);
    const a = b.dataset.act;
    if (a === "next") go(T.i + 1);
    else if (a === "back") go(T.i - 1);
    else if (a === "restart") go(0);
    else if (a === "retry") go(T.i);
    else if (a === "close") stop();
  }

  function onKey(e) {
    if (!T.active) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || e.target.isContentEditable) return;
    if (e.key === "Escape") { e.preventDefault(); stop(); }
    else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); if (T.i < STEPS.length - 1) go(T.i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(T.i - 1); }
  }

  // ------------------------------------------------------------ entry points
  function isDemoUrl() {
    try { return new URLSearchParams(location.search).get("demo") === "1"; } catch (_) { return false; }
  }

  function injectButton() {
    const bar = qs(".topbar");
    if (!bar || qs("#tourStart")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.id = "tourStart";
    b.className = "tour-launch";
    b.textContent = "Guided demo";
    b.addEventListener("click", () => (T.active ? stop() : start(0)));
    bar.appendChild(b);
  }

  function hideHint() { const el = qs("#tourHint"); if (el) el.remove(); }

  function showHint() {
    let dismissed = false;
    try { dismissed = localStorage.getItem(HINT_KEY) === "1"; } catch (_) {}
    if (dismissed || qs("#tourHint")) return;
    const el = document.createElement("div");
    el.id = "tourHint";
    el.className = "tour-hint";
    el.innerHTML = `<span>New here? Start the guided demo.</span>
      <button type="button" class="tour-btn primary" data-hint="start">Start</button>
      <button type="button" class="tour-x" data-hint="dismiss" aria-label="Dismiss">×</button>`;
    el.addEventListener("click", (e) => {
      const a = e.target.closest("[data-hint]");
      if (!a) return;
      try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
      hideHint();
      if (a.dataset.hint === "start") start(0);
    });
    document.body.appendChild(el);
  }

  document.addEventListener("click", onCardClick);
  document.addEventListener("keydown", onKey);
  injectButton();
  if (isDemoUrl()) {
    document.body.classList.add("demo");
    start(0);
  } else {
    showHint();
  }
})();
