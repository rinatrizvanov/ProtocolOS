// Evidence graph tab: provenance graph, bounded investigator and agent-safeguard panel.
// Loaded after app.js; reuses its globals ($, esc, api, post, state) and declares none of its own.
(() => {
  "use strict";
  const root = document.getElementById("graph");
  if (!root) return;

  const QUESTIONS = [
    ["why_flagged", "Why was this flagged?"],
    ["contradicting", "What evidence contradicts it?"],
    ["support_retaining", "What supports retaining it?"],
    ["what_would_change", "What would change this conclusion?"],
  ];
  const EVIDENCE_TYPES = ["Passage", "CuratedFact", "ComparatorThreshold", "GuidancePassage"];
  // left -> right; Criterion sits with the protocol text it comes from
  const COLUMNS = [
    { key: "protocol", title: "Protocol & regimen", types: ["Criterion", "CuratedFact", "Passage"], w: 196 },
    { key: "comparators", title: "Comparable trials", types: ["ComparatorThreshold"], w: 188 },
    { key: "fda", title: "FDA guidance", types: ["GuidancePassage", "GuidanceGroup"], w: 196 },
    { key: "rules", title: "Score rules", types: ["ScoreRule"], w: 176 },
    { key: "assessment", title: "Assessment & classification", types: ["Assessment", "Classification", "ReviewerDecision", "Recommendation", "MissingEvidence"], w: 206 },
  ];
  // gaps after each column; the score badges sit in the wide gap before the assessment
  const GAPS = [30, 30, 40, 150];
  const GROUP_ID = "__fda_general";
  const TYPE_ORDER = ["Criterion", "CuratedFact", "Passage", "ComparatorThreshold", "GuidanceGroup", "GuidancePassage", "ScoreRule",
    "Assessment", "Classification", "ReviewerDecision", "Recommendation", "MissingEvidence"];
  const EPISTEMIC = {
    source_fact: "verbatim source text",
    rule_inferred: "TrialLens rule (inferred)",
    curated_pharmacology: "curated pharmacology table",
    model_generated: "model generated",
    human: "reviewer decision",
  };
  const GROUP_NOTE = {
    regimen_support: "A drug in the arms is flagged for this toxicity in the curated table. Existence only: it supports having a threshold, never a specific value.",
    regimen_challenge: "No agent in any arm is flagged for this toxicity in the curated table.",
    protocol_value_specific: "Protocol text outside the eligibility section references this threshold value (one group for all such passages).",
    looser_comparators: "Comparable trials that used a more permissive threshold count once, as a group: the group adds its maximum (2 if a comparator's regimen fully covers this trial's toxicity-relevant drug classes, else 1). More looser comparators do not add more points.",
    same_comparators: "Two or more comparable trials used the same value and none used a looser one. Agreement may reflect template carry-forward.",
    stricter_comparators: "At least one comparable trial used a stricter value.",
    specific_fda: "A criterion-specific FDA recommendation applies (+1 instead of +2 when the protocol already states a PK-based alternative).",
  };

  const PANEL_HINT = `<div class="gp-empty"><div class="gp-empty-t">Select a node</div><div class="src">Its verbatim source, page link and connections appear here. Hover any node for its full text.</div></div>`;
  const g = { key: null, nct: null, cid: null, data: null, sel: null, req: 0, seenSelected: null, view: "graph", inv: null, err: null, waitTimer: null, fdaOpen: false };

  // ---------------------------------------------------------------- helpers
  const byId = () => new Map((g.data?.nodes || []).map((n) => [n.id, n]));
  const short = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const num = (v) => (v == null ? "" : String(+v));
  const human = (s) => String(s ?? "").replaceAll("_", " ");
  const tabActive = () => !!document.getElementById("tab-graph")?.classList.contains("active");
  const reviewLoading = () => { const el = document.getElementById("loading"); return !!el && !el.classList.contains("hidden"); };
  const reviewError = () => { const el = document.getElementById("error"); return !!el && !el.classList.contains("hidden") ? el.textContent : null; };
  const reviewReady = () => !reviewLoading() && !!state.review && state.review.target?.study?.nct_id === state.nct;
  const mismatch = () => (g.data?.warnings || []).includes(`attribution_mismatch:${g.cid}`);
  const clsKeyOf = (c) => (String(c).startsWith("Review") ? "review" : String(c).startsWith("Evidence") ? "retain" : "insufficient");

  // GuidancePassage nodes that add 0 points: every edge touching them is EVIDENCE_FOR without points, and the
  // passage is not a criterion-specific recommendation. They are folded into one group node by default.
  function generalFda() {
    const nodes = g.data?.nodes || [], edges = g.data?.edges || [];
    const out = nodes.filter((n) => n.type === "GuidancePassage" && n.data?.strength !== "specific" && (() => {
      const es = edges.filter((e) => e.from === n.id || e.to === n.id);
      return es.length > 0 && es.every((e) => e.type === "EVIDENCE_FOR" && !e.points);
    })());
    return out.length >= 2 ? out : [];
  }
  const issuedList = (ns) => [...new Set(ns.map((n) => n.data?.issued).filter(Boolean))].sort().reverse();
  function groupText(ns) {
    const retro = ns.length && ns.every((n) => n.data?.retrospective);
    return `${ns.length} general passages · 0 points${retro ? " · retrospective" : ""}`;
  }
  const pageOf = (s) => s?.page || (String(s?.url || "").match(/#page=(\d+)/) || [])[1] || null;

  function wrap(text, per, lines) {
    const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const out = [];
    let i = 0;
    while (i < words.length && out.length < lines) {
      let line = short(words[i++], per);
      while (i < words.length && (line + " " + words[i]).length <= per) line += " " + words[i++];
      out.push(line);
    }
    if (i < words.length && out.length) { const l = out[out.length - 1]; out[out.length - 1] = (l.length > per - 1 ? l.slice(0, per - 2) : l) + "…"; }
    return out;
  }

  function caption(n) {
    const d = n.data || {};
    switch (n.type) {
      case "Criterion": return `Criterion · ${n.source?.page ? "p." + n.source.page : "registry"}`;
      case "CuratedFact": return d.existence_only ? "Curated · existence only" : "Curated pharmacology";
      case "Passage": return `Protocol p.${n.source?.page ?? "?"}${d.value_specific ? " · value-specific" : ""}`;
      case "ComparatorThreshold": return `${human(d.direction || "comparator").replace(/^comparator /, "")} · ${d.coverage?.status || "?"} coverage`;
      case "GuidancePassage": return `FDA${d.strength === "specific" ? " specific" : ""}${d.retrospective ? " · retrospective" : ` · ${d.issued || ""}`}`;
      case "ScoreRule": return "Score rule";
      case "Assessment": return "Assessment · rule scores";
      case "Recommendation": return "Suggested review question";
      case "MissingEvidence": return "Missing evidence";
      case "Classification": return "Rule classification";
      case "ReviewerDecision": return "Reviewer decision";
      default: return n.type;
    }
  }

  function nodeText(n) {
    const d = n.data || {};
    if (n.type === "Passage" || n.type === "GuidancePassage") return n.source?.quote || n.label;
    if (n.type === "CuratedFact") return d.summary || n.label;
    if (n.type === "ScoreRule") return [human(d.group), mismatch() ? "points hidden" : `+${d.points ?? 0} ${d.axis || ""}`];
    if (n.type === "MissingEvidence") return d.text || n.label;
    if (n.type === "Assessment") return [`support ${d.scores?.support ?? "?"} · challenge ${d.scores?.challenge ?? "?"}`];
    if (n.type === "Recommendation") return d.text || n.label;
    return n.label;
  }

  function pointsText(points, axis, group) {
    if (mismatch()) return "points hidden";
    return `+${points ?? 0} ${axis || ""}${group === "looser_comparators" ? " (group max)" : ""}`.trim();
  }

  function edgeLabel(e) {
    if (e.type === "RULE_SCORES") return mismatch() ? "points hidden" : (e.label || pointsText(e.points, e.axis, e.group));
    if (e.scope === "existence_of_threshold") return "existence only";
    if (e.type === "EVIDENCE_IN_RULE") return human(e.group);
    return "";
  }

  // ---------------------------------------------------------------- shell
  function shell() {
    root.innerHTML = `
      <div class="g-head card">
        <div class="g-head-row">
          <label for="graph-criterion" class="g-lbl">Criterion</label>
          <select id="graph-criterion"></select>
          <div class="g-viewtoggle" role="group" aria-label="View">
            <button type="button" class="small ${g.view === "graph" ? "" : "ghost"}" data-gview="graph">Graph</button>
            <button type="button" class="small ${g.view === "list" ? "" : "ghost"}" data-gview="list">List</button>
          </div>
          <span class="g-built src"></span>
        </div>
        <div class="src g-intro">Which evidence drives this assessment, and where each piece comes from. Click a node for its source. Differences from comparable trials are review questions, not mistakes; the team decides.</div>
      </div>
      <div class="g-msg hidden" role="status"></div>
      <section class="g-score card hidden" aria-label="Score breakdown"></section>
      <div class="g-body">
        <div class="g-canvas card"><div class="g-svgwrap"></div><div class="g-listwrap"></div>${legendHtml()}</div>
        <aside id="graph-panel" class="card" aria-live="polite">${PANEL_HINT}</aside>
      </div>
      <section class="g-inv card">
        <div class="g-inv-head"><h3>Ask about this assessment</h3>
          <span class="src">Four fixed questions. The answer is built from the graph above and every statement is checked by the deterministic verifier.</span></div>
        <div class="inv-qs">${QUESTIONS.map(([q, l]) => `<button type="button" class="small ghost inv-q" data-question="${q}">${esc(l)}</button>`).join("")}
          ${state.status?.llm?.available ? `<label class="inv-model src"><input type="checkbox" id="inv-use-model" /> use the model (verifier-checked, can only downgrade)</label>` : ""}</div>
        <div class="inv-grid">
          <div id="inv-answer" data-state="idle"><div class="src">Choose a question. Answers cite graph nodes; unsupported statements are shown struck through, never hidden.</div></div>
          <aside id="inv-security">${securityHtml(null)}</aside>
        </div>
      </section>`;
    $("#graph-criterion").addEventListener("change", (e) => { g.cid = e.target.value; load(); });
    root.querySelectorAll("[data-gview]").forEach((b) => b.addEventListener("click", () => { g.view = b.dataset.gview; renderView(); }));
    root.querySelectorAll(".inv-q").forEach((b) => b.addEventListener("click", () => investigate(b.dataset.question)));
  }

  function legendHtml() {
    return `<div class="g-legend">
      <span><svg width="26" height="12" aria-hidden="true"><rect x="1" y="1" width="24" height="10" rx="2" class="lg-solid"/></svg> verbatim source text</span>
      <span><svg width="26" height="12" aria-hidden="true"><rect x="1" y="1" width="24" height="10" rx="2" class="lg-dashed"/></svg> TrialLens rule or curated table</span>
      <span><svg width="26" height="12" aria-hidden="true"><rect x="1" y="1" width="24" height="10" rx="2" class="lg-dotted"/></svg> model generated</span>
      <span><svg width="26" height="12" aria-hidden="true"><rect x="1" y="1" width="24" height="10" rx="2" class="lg-solid"/><rect x="3.5" y="3.5" width="19" height="5" rx="1" class="lg-solid"/></svg> reviewer decision</span>
      <span><i class="lg-line supports"></i> supports</span><span><i class="lg-line challenges"></i> challenges</span><span><i class="lg-line context"></i> context (0 points)</span>
      <div class="g-legend-notes">
        <div><b>group max</b>: comparable trials with a more permissive threshold count once as a group, which adds its maximum (2 with full regimen coverage, else 1). They show the value was used elsewhere, not that it suits this regimen.</div>
        <div><b>existence only</b>: a toxicity link from the curated pharmacology table supports having a threshold, never a specific value.</div>
        <div>Points appear only on score-rule edges; evidence drawn without points (context, general FDA principles) adds 0. <b>retrospective</b>: FDA guidance issued after this trial started, a present-day review standard.</div>
      </div></div>`;
  }

  function securityHtml(r) {
    const b = r?.budget;
    const checks = r?.checks || [];
    const n = (res) => checks.filter((c) => c.result === res).length;
    const tile = (v, l) => `<div class="sec-tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    const budget = b
      ? tile(`${b.used ?? 0}/${b.max_tool_calls ?? 4}`, "tool calls") + tile(`${b.used_model ?? 0}/${b.max_model_calls ?? 2}`, "model calls") + tile(`${(+(r.elapsed_s ?? 0)).toFixed(1)} s`, "of 60 s")
      : tile("4", "tool calls max") + tile("2", "model calls max") + tile("60 s", "per question");
    return `<h4>Agent safeguards</h4>
      <div class="sec-budget">${budget}</div>
      <ul class="sec-list">
        <li>Fixed questions only; no free text reaches a model.</li>
        <li>Read-only whitelisted tools${r?.tools_used?.length ? `: ${esc(r.tools_used.join(", "))}` : ""}.</li>
        <li>Protocol, registry and FDA text: documents are data, never instructions.</li>
        <li>A model can only downgrade a flag; the classification is never changed by an answer.</li>
        <li class="sec-verifier">${r ? `verifier: ${n("pass")} checks passed${n("warn") ? `, ${n("warn")} warning${n("warn") === 1 ? "" : "s"}` : ""}${n("fail") ? `, ${n("fail")} failed` : ""}` : "verifier: runs on every answer"}</li>
        <li>Model: <span class="sec-model" data-model-status="${esc(modelStatus(r))}">${esc(modelStatus(r))}</span></li>
        ${r?.audit_id ? `<li>Audit record <code>${esc(r.audit_id)}</code> (one JSON line per investigation)</li>` : ""}
      </ul>`;
  }

  function modelStatus(r) {
    const s = r?.model?.status;
    const configured = !!state.status?.llm?.available;
    if (!s) return configured ? `${state.status.llm.model || "configured"} (used only when asked)` : "not configured";
    if (s === "ok") return `${r.model.provider || "model"} (verifier-checked)`;
    if (s.startsWith("unavailable")) return `model ${s}; deterministic answer shown`;
    if (s === "not_used") return configured ? "not used (deterministic answer)" : "not configured";
    return s;
  }

  function setState(s, msg, kind) {
    root.dataset.state = s;
    const m = root.querySelector(".g-msg");
    if (!m) return;
    m.className = `g-msg ${kind || (s === "error" ? "error" : "loading")}${msg ? "" : " hidden"}`;
    m.innerHTML = msg || "";
  }

  // ---------------------------------------------------------------- load
  function fillSelect() {
    const sel = $("#graph-criterion");
    const items = state.review?.reviews || [];
    sel.innerHTML = items.map((r) => `<option value="${esc(r.criterion.id)}">${esc(r.criterion.label)} ${esc(r.criterion.operator || "")}${esc(num(r.criterion.value_norm))} ${esc(r.criterion.unit_norm || "")} · ${esc(r.classification)}</option>`).join("");
    sel.value = g.cid || "";
    sel.disabled = !items.length;
  }

  function pickCriterion() {
    const ids = (state.review?.reviews || []).map((r) => r.criterion.id);
    if (state.selected && state.selected !== g.seenSelected && ids.includes(state.selected)) { g.seenSelected = state.selected; return state.selected; }
    if (g.cid && ids.includes(g.cid)) return g.cid;
    if (state.selected && ids.includes(state.selected)) return state.selected;
    return ids.includes("hemoglobin") ? "hemoglobin" : ids[0] || null;
  }

  function clear(msg) {
    g.req++;
    clearTimeout(g.waitTimer);
    g.key = g.nct = g.data = g.sel = g.inv = null;
    g.cid = null; g.seenSelected = null;
    shell();
    setState("empty", msg || "Open this tab after a protocol review has loaded.", "loading");
  }

  function show() {
    const key = `${state.nct}|${state.asOf}`;
    if (key !== g.key) { clear(); g.key = key; g.nct = state.nct; }
    waitForReview(++g.req);
  }

  function waitForReview(req) {
    clearTimeout(g.waitTimer);
    if (req !== g.req) return;
    if (!state.nct) { setState("empty", "Review a protocol first (enter an NCT ID above).", "loading"); return; }
    if (reviewLoading() || (!reviewReady() && !reviewError())) {
      setState("loading", `Waiting for the protocol review of ${esc(state.nct)} (registry record, protocol PDF, comparable trials)…`);
      g.waitTimer = setTimeout(() => waitForReview(req), 250);
      return;
    }
    if (!reviewReady()) { setState("error", `The protocol review did not load, so there is no graph to build. ${esc(reviewError() || "")}`); return; }
    const cid = pickCriterion();
    if (!cid) { setState("empty", "This review has no criteria to graph."); return; }
    if (cid !== g.cid || !g.data) { g.cid = cid; fillSelect(); load(); } else fillSelect();
  }

  async function load() {
    const req = ++g.req;
    const cid = g.cid;
    g.data = null; g.sel = null; g.inv = null;
    root.querySelector(".g-svgwrap").innerHTML = "";
    root.querySelector(".g-listwrap").innerHTML = "";
    $("#graph-panel").innerHTML = PANEL_HINT;
    root.querySelector(".g-score").innerHTML = ""; root.querySelector(".g-score").classList.add("hidden");
    $("#inv-answer").dataset.state = "idle";
    $("#inv-answer").innerHTML = `<div class="src">Choose a question about this criterion.</div>`;
    $("#inv-security").innerHTML = securityHtml(null);
    setState("loading", `Building the evidence graph for ${esc(cid)}…`);
    try {
      const data = await api(`/api/graph/${encodeURIComponent(state.nct)}?criterion_id=${encodeURIComponent(cid)}&as_of=${encodeURIComponent(state.asOf)}`);
      if (req !== g.req) return;
      g.data = data;
      render();
    } catch (e) {
      if (req !== g.req) return;
      setState("error", `Could not build the evidence graph: ${esc(e.message)} <button type="button" class="small ghost g-retry">Retry</button>`);
      root.querySelector(".g-retry")?.addEventListener("click", load);
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    const nodes = g.data.nodes || [];
    const crit = nodes.find((n) => n.type === "Criterion");
    const hasEvidence = nodes.some((n) => EVIDENCE_TYPES.includes(n.type));
    const noProtocol = !!crit && !crit.source?.page && !nodes.some((n) => n.type === "Passage");
    const b = g.data.built_from || {};
    root.querySelector(".g-built").textContent = `built from the stored review${b.computed_at ? ` of ${b.computed_at}` : ""}${b.as_of ? ` · comparators before ${b.as_of}` : ""}${b.fingerprint ? ` · review ${String(b.fingerprint).slice(0, 8)}` : ""}`;
    const notes = [];
    if (mismatch()) {
      const sc = nodes.find((n) => n.type === "Assessment")?.data?.scores || {};
      notes.push(`Score attribution hidden for this criterion: the per-rule points derived from the evidence do not add up to the stored scores (support ${esc(sc.support)}, challenge ${esc(sc.challenge)}), so the graph does not say which evidence drove them.`);
    }
    (g.data.validation || []).length && notes.push(`Graph validation reported ${g.data.validation.length} issue(s): ${esc(g.data.validation.slice(0, 3).join("; "))}`);
    if (!nodes.length) { setState("empty", "No graph nodes were returned for this criterion."); renderView(); return; }
    if (noProtocol) setState("no-protocol", `No protocol PDF passage is available for this criterion: it was read from registry text, so there are no protocol page links. Comparator and FDA evidence are still shown.${notes.length ? "<br>" + notes.join("<br>") : ""}`, "warn");
    else if (!hasEvidence) setState("empty", `No evidence nodes were recorded for this criterion, so no points are attributed. The classification and missing-evidence items are still shown; a criterion with no comparable precedent is "Insufficient evidence", never "retain".${notes.length ? "<br>" + notes.join("<br>") : ""}`, "warn");
    else setState("ready", notes.join("<br>"), "warn");
    renderScore();
    renderView();
  }

  function renderScore() {
    const el = root.querySelector(".g-score");
    const nodes = g.data.nodes || [], edges = g.data.edges || [];
    const by = byId();
    const assess = nodes.find((n) => n.type === "Assessment");
    if (!assess) { el.classList.add("hidden"); return; }
    const sc = assess.data?.scores || {};
    const cls = nodes.find((n) => n.type === "Classification");
    const rules = edges.filter((e) => e.type === "RULE_SCORES" && e.to === assess.id);
    const pill = cls ? `<span class="cls ${clsKeyOf(cls.label)}">${esc(cls.label)}</span>` : "";
    const head = `<div class="gs-head"><h3>Score breakdown</h3>${pill}<span class="gs-total">support <b>${esc(sc.support ?? "?")}</b> · challenge <b>${esc(sc.challenge ?? "?")}</b></span></div>`;
    if (mismatch()) {
      el.innerHTML = `${head}<div class="gs-mismatch">attribution_mismatch:${esc(g.cid)}: the per-rule points derived from the evidence do not add up to the stored scores, so no points are attributed to individual evidence here.</div>`;
      el.classList.remove("hidden");
      return;
    }
    const rows = rules.map((e) => {
      const rule = by.get(e.from) || {};
      const d = rule.data || {};
      const members = (d.members || []).map((m) => by.get(m)).filter(Boolean);
      let detail = "";
      const cmp = members.filter((m) => m.type === "ComparatorThreshold");
      if (cmp.length) {
        const cov = [...new Set(cmp.map((m) => m.data?.coverage?.status).filter(Boolean))];
        detail = `${cmp.length} comparable trial${cmp.length === 1 ? "" : "s"} (${cmp.map((m) => esc(m.data?.acronym || m.data?.nct_id || m.label)).join(", ")}) · ${esc(cov.join("/") || "?")} regimen coverage${d.group === "looser_comparators" ? " · counted once as a group (group max)" : ""}`;
      } else if (members.some((m) => m.type === "CuratedFact")) {
        detail = `${members.length} curated pharmacology fact${members.length === 1 ? "" : "s"}${e.scope === "existence_of_threshold" ? " · existence of a threshold only, never its value" : ""}`;
      } else detail = `${members.length} evidence item${members.length === 1 ? "" : "s"}`;
      const [main] = badgeParts(e);
      return `<li class="gs-row ${esc(d.axis || e.axis || "")}"><button type="button" class="gs-pts" data-goto="${esc(e.from)}">${esc(main)}</button><span class="gs-name">${esc(human(d.group || e.group))}</span><span class="gs-detail">${detail}</span></li>`;
    });
    const fda = generalFda();
    if (fda.length) rows.push(`<li class="gs-row context"><button type="button" class="gs-pts" data-toggle-fda>0</button><span class="gs-name">general FDA passages</span><span class="gs-detail">${fda.length} passages, issued ${esc(issuedList(fda).join(", "))}${fda.every((n) => n.data?.retrospective) ? " · retrospective (issued after this trial started)" : ""} · shown for review</span></li>`);
    const ruleIds = new Set(rules.map((e) => e.from));
    const fdaIds = new Set(fda.map((n) => n.id));
    const ctx = edges.filter((e) => e.to === assess.id && e.type === "EVIDENCE_FOR" && !e.points && !fdaIds.has(e.from) && !ruleIds.has(e.from));
    if (ctx.length) rows.push(`<li class="gs-row context"><span class="gs-pts">0</span><span class="gs-name">other context</span><span class="gs-detail">${ctx.length} item${ctx.length === 1 ? "" : "s"} (${ctx.map((e) => esc(short(by.get(e.from)?.label || e.from, 40))).join("; ")})</span></li>`);
    const sum = (ax) => rules.filter((e) => e.axis === ax).reduce((t, e) => t + (+e.points || 0), 0);
    const ok = sum("support") === +sc.support && sum("challenge") === +sc.challenge;
    el.innerHTML = `${head}<ul class="gs-rows">${rows.join("") || `<li class="src">No score rule fired for this criterion.</li>`}</ul>
      <div class="gs-foot">Total from the rules: support ${sum("support")} · challenge ${sum("challenge")} ${ok ? "<span class='gs-ok'>matches the stored assessment</span>" : "<span class='gs-bad'>does not match the stored assessment</span>"}. Points come only from score rules; the team decides.</div>`;
    el.classList.remove("hidden");
    el.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => { if (g.view !== "graph") { g.view = "graph"; renderView(); } selectNode(b.dataset.goto); }));
    el.querySelector("[data-toggle-fda]")?.addEventListener("click", () => { g.fdaOpen = !g.fdaOpen; renderView(); });
  }

  function renderView() {
    root.querySelectorAll("[data-gview]").forEach((b) => b.classList.toggle("ghost", b.dataset.gview !== g.view));
    const svgWrap = root.querySelector(".g-svgwrap");
    const listWrap = root.querySelector(".g-listwrap");
    if (!g.data) { svgWrap.innerHTML = ""; listWrap.innerHTML = ""; return; }
    listWrap.innerHTML = listHtml();
    let svgOk = true;
    if (g.view === "graph") {
      try { svgWrap.innerHTML = svgHtml(); } catch (err) {
        svgOk = false;
        svgWrap.innerHTML = `<div class="error">The graph drawing failed (${esc(err.message)}); the same nodes and edges are listed below.</div>`;
      }
    } else svgWrap.innerHTML = "";
    listWrap.classList.toggle("hidden", g.view === "graph" && svgOk);
    bindNodes();
    if (g.sel) selectNode(g.sel, false);
  }

  function layout(collapse = true) {
    const folded = collapse && !g.fdaOpen ? generalFda() : [];
    const foldedIds = new Set(folded.map((n) => n.id));
    const nodes = (g.data.nodes || []).filter((n) => !foldedIds.has(n.id));
    const general = generalFda();
    if (collapse && general.length) nodes.push({ id: GROUP_ID, type: "GuidanceGroup", label: "FDA guidance", members: general, open: g.fdaOpen });
    const order = (n) => { const i = TYPE_ORDER.indexOf(n.type); return i < 0 ? 99 : i; };
    nodes.sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const cols = COLUMNS.map((c) => ({ ...c, nodes: [] }));
    const other = { key: "other", title: "Other", types: [], w: 190, nodes: [] };
    nodes.forEach((n) => (cols.find((c) => c.types.includes(n.type)) || other).nodes.push(n));
    if (other.nodes.length) cols.push(other);
    const H = (n) => n.type === "GuidanceGroup" ? (n.open ? 46 : 84) : n.type === "GuidancePassage" ? 52 : n.type === "Classification" ? 44 : 68;
    const GAP = 14, TOP = 40;
    const colGap = (c) => (c.key === "rules" ? 36 : GAP); // room for the group label above each rule
    let x = 8, lastGap = 0;
    const pos = new Map();
    const heights = cols.map((c) => c.nodes.reduce((s, n) => s + H(n) + colGap(c), 0) - (c.nodes.length ? colGap(c) : 0));
    // evidence columns are centred on one line; the Assessment node sits on that line and the
    // classification, recommendation and missing-evidence nodes hang below it
    const isA = (c) => c.key === "assessment";
    const evH = Math.max(140, ...cols.filter((c) => !isA(c)).map((c, i) => heights[cols.indexOf(c)]));
    const aCol = cols.find(isA);
    const aFirst = aCol?.nodes[0];
    const aTop = aFirst ? Math.max(0, evH / 2 - H(aFirst) / 2) : 0;
    const maxH = Math.max(evH, aCol ? aTop + heights[cols.indexOf(aCol)] : 0);
    cols.forEach((c, i) => {
      c.x = x;
      if (!c.nodes.length) return; // empty columns take no space
      let y = TOP + (isA(c) ? aTop : c.key === "fda" && g.fdaOpen ? 0 : (evH - heights[i]) / 2);
      c.nodes.forEach((n) => { pos.set(n.id, { x, y, w: c.w, h: H(n), col: c.key, node: n }); y += H(n) + colGap(c); });
      lastGap = GAPS[i] ?? 40;
      x += c.w + lastGap;
    });
    return { cols, pos, foldedIds, width: x - lastGap + 16, height: TOP + maxH + 14 };
  }

  function badgeParts(e) {
    if (mismatch()) return ["points hidden", ""];
    const sub = e.scope === "existence_of_threshold" ? "existence only" : e.group === "looser_comparators" ? "group max" : "";
    return [`+${e.points ?? 0} ${e.axis || ""}`.trim(), sub];
  }

  function svgHtml() {
    const L = layout();
    const nodes = byId();
    // edges from folded FDA passages are drawn once, from the group node
    let groupEdge = null;
    const edges = [];
    (g.data.edges || []).forEach((e) => {
      if (L.foldedIds.has(e.from)) { if (!groupEdge && L.pos.has(e.to)) { groupEdge = { id: "__fda_general_edge", type: "EVIDENCE_FOR", from: GROUP_ID, to: e.to, stance: "context", points: 0, synthetic: true }; edges.push(groupEdge); } return; }
      if (L.pos.has(e.from) && L.pos.has(e.to)) edges.push(e);
    });
    // spread the ports where several edges enter or leave the same side of a node
    const ports = new Map();
    const portKey = (id, side) => id + "|" + side;
    edges.forEach((e) => {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      if (a.col === b.col) return;
      const fwd = a.x < b.x;
      [[portKey(e.to, fwd ? "L" : "R"), a.y + a.h / 2], [portKey(e.from, fwd ? "R" : "L"), b.y + b.h / 2]].forEach(([k, oy]) => {
        if (!ports.has(k)) ports.set(k, []);
        ports.get(k).push({ e, oy });
      });
    });
    const portY = (id, side, e) => {
      const p = L.pos.get(id), list = (ports.get(portKey(id, side)) || []).slice().sort((u, v) => u.oy - v.oy);
      const i = list.findIndex((t) => t.e === e);
      if (list.length < 2 || i < 0) return p.y + p.h / 2;
      const pad = Math.min(14, p.h / 4);
      return p.y + pad + ((p.h - 2 * pad) * i) / (list.length - 1);
    };
    const heads = L.cols.map((c) => c.nodes.length ? `<text class="g-colhead" x="${c.x + 2}" y="18">${esc(c.title)}</text>` : "").join("");
    const groupLabelled = new Set();
    const badges = [];
    const edgeSvg = edges.map((e) => {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      let x1, y1, x2, y2, d;
      if (a.col === b.col) { // link inside a column (assessment -> classification, missing evidence): loop out on the right
        x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x + b.w; y2 = b.y + b.h / 2;
        const bulge = Math.min(30, 12 + Math.abs(y2 - y1) / 10);
        d = `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`;
      } else {
        const fwd = a.x < b.x;
        x1 = fwd ? a.x + a.w : a.x; y1 = portY(e.from, fwd ? "R" : "L", e); x2 = fwd ? b.x : b.x + b.w; y2 = portY(e.to, fwd ? "L" : "R", e);
        const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      }
      if (e.type === "RULE_SCORES") {
        const [main, sub] = badgeParts(e);
        const w = Math.max(main.length, sub.length) * 7.2 + 18, h = sub ? 36 : 22;
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        badges.push(`<g class="g-badge ${esc(e.axis || "")}" data-badge-for="${esc(e.id)}"><rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2 > 11 ? 9 : 11}"/>
          <text class="b-main" x="${cx}" y="${cy + (sub ? -3 : 4.5)}">${esc(main)}</text>${sub ? `<text class="b-sub" x="${cx}" y="${cy + 12}">${esc(sub)}</text>` : ""}</g>`);
      }
      let txt = "";
      const lbl = edgeLabel(e);
      if (lbl && e.type === "EVIDENCE_IN_RULE" && !groupLabelled.has(e.to + "|" + lbl)) {
        groupLabelled.add(e.to + "|" + lbl); // members converge on the rule node: label the group once
        txt = `<text class="g-elabel grp${e.scope ? " scope" : ""}" x="${b.x + 2}" y="${b.y - 7}">${esc(lbl)}${e.scope ? "" : ""}</text>`;
      }
      const cls = ["gedge", `t-${e.type}`, `s-${e.stance || "none"}`, e.points ? "has-pts" : "", e.scope ? "scoped" : "", e.synthetic ? "synthetic" : ""].join(" ");
      const fromLabel = e.from === GROUP_ID ? `FDA guidance (${generalFda().length} general passages)` : nodes.get(e.from)?.label || e.from;
      const title = `${fromLabel} → ${nodes.get(e.to)?.label || e.to}: ${human(e.type)}${e.stance ? " · " + e.stance : ""}${e.group ? " · " + human(e.group) : ""}${e.scope ? " · " + human(e.scope) : ""}${e.type === "RULE_SCORES" && !mismatch() ? " · " + (e.points ?? 0) + " points" : " · 0 points"}`;
      const idAttr = e.synthetic ? `data-synthetic-edge="${esc(e.id)}"` : `data-edge-id="${esc(e.id)}"`;
      return `<g class="${cls}" ${idAttr} data-from="${esc(e.from)}" data-to="${esc(e.to)}"><title>${esc(title)}</title><path d="${d}"/>${txt}</g>`;
    }).join("");
    const nodeSvg = [...L.pos.entries()].map(([id, p]) => {
      const n = p.node;
      if (n.type === "GuidanceGroup") {
        const ms = n.members;
        const iss = issuedList(ms);
        const tip = `${groupText(ms)}. General FDA principles, issued ${iss.join(", ")}, after this trial started. Shown for review; they add 0 points. Click to ${n.open ? "fold them into one node" : "show each passage"}.`;
        return `<g class="ggroup${n.open ? " open" : ""}" data-group-id="${GROUP_ID}" data-near-id="${GROUP_ID}" tabindex="0" role="button" aria-expanded="${n.open}" aria-label="${esc(tip)}">
          <title>${esc(tip)}</title>
          ${n.open ? "" : `<rect class="stack2" x="${p.x + 6}" y="${p.y + 6}" width="${p.w}" height="${p.h}" rx="8"/><rect class="stack1" x="${p.x + 3}" y="${p.y + 3}" width="${p.w}" height="${p.h}" rx="8"/>`}
          <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8"/>
          <text class="cap" x="${p.x + 10}" y="${p.y + 17}">FDA guidance · general</text>
          ${n.open ? `<text class="lbl" x="${p.x + 10}" y="${p.y + 35}">${ms.length} general passages · fold ▴</text>`
            : `<text class="lbl" x="${p.x + 10}" y="${p.y + 37}">${ms.length} general passages</text>
               <text class="lbl strong" x="${p.x + 10}" y="${p.y + 55}">0 points${ms.every((m) => m.data?.retrospective) ? " · retrospective" : ""}</text>
               <text class="hint" x="${p.x + 10}" y="${p.y + 73}">Show each passage ▾</text>`}
        </g>`;
      }
      const t = nodeText(n);
      const per = Math.floor((p.w - 18) / 7.1);
      const lines = Array.isArray(t) ? t.map((l) => short(l, per)) : wrap(t, per, n.type === "GuidancePassage" || n.type === "Classification" ? 1 : 2);
      const extra = n.type === "Classification" ? ` k-${clsKeyOf(n.label)}` : "";
      const double = n.epistemic === "human" ? `<rect class="inner" x="${p.x + 3}" y="${p.y + 3}" width="${p.w - 6}" height="${p.h - 6}" rx="5"/>` : "";
      const full = [].concat(t).join(": ");
      const tip = `${caption(n)}\n${n.label || id}${full && full !== n.label ? "\n\n" + full : ""}`;
      if (n.type === "Classification") {
        return `<g class="gnode t-Classification${extra}" data-node-id="${esc(id)}" data-node-type="Classification" tabindex="0" role="button" aria-label="${esc("Classification: " + n.label)}">
          <title>${esc(tip)}</title><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.h / 2}"/>
          <text class="pill" x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + 5}">${esc(n.label)}</text></g>`;
      }
      return `<g class="gnode t-${esc(n.type)} e-${esc(n.epistemic || "unknown")}${extra}" data-node-id="${esc(id)}" data-node-type="${esc(n.type)}" tabindex="0" role="button" aria-label="${esc(n.type + ": " + (n.label || id))}">
        <title>${esc(tip)}</title>
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8"/>${double}
        <text class="cap" x="${p.x + 10}" y="${p.y + 18}">${esc(short(caption(n), Math.floor((p.w - 18) / 6.6)))}</text>
        ${lines.map((l, i) => `<text class="lbl${n.type === "Assessment" || n.type === "ScoreRule" && i === 1 ? " strong" : ""}" x="${p.x + 10}" y="${p.y + 37 + i * 17}">${esc(l)}</text>`).join("")}
      </g>`;
    }).join("");
    return `<svg class="g-svg" viewBox="0 0 ${L.width} ${L.height}" preserveAspectRatio="xMinYMin meet" style="max-width:${Math.round(L.width * 1.15)}px" role="img" aria-label="Evidence graph for ${esc(g.cid)}">${heads}<g class="g-edges">${edgeSvg}</g><g class="g-nodes">${nodeSvg}</g><g class="g-badges">${badges.join("")}</g></svg>`;
  }

  function listHtml() {
    const nodes = byId();
    const edges = g.data.edges || [];
    const cols = layout(false).cols.filter((c) => c.nodes.length);
    return `<div class="g-list">
      ${cols.map((c) => `<div class="g-list-col"><h4>${esc(c.title)}</h4><ul>${c.nodes.map((n) => `<li><button type="button" class="g-li" data-list-node="${esc(n.id)}"><span class="cap">${esc(caption(n))}</span> ${esc(short([].concat(nodeText(n)).join(": "), 140))}</button></li>`).join("")}</ul></div>`).join("")}
      <details class="g-list-edges"><summary>${edges.length} edges</summary><table><thead><tr><th>From</th><th>To</th><th>Type</th><th>Stance</th><th>Points</th><th>Group / scope</th></tr></thead><tbody>
        ${edges.map((e) => `<tr data-list-edge="${esc(e.id)}"><td>${esc(short(nodes.get(e.from)?.label || e.from, 60))}</td><td>${esc(short(nodes.get(e.to)?.label || e.to, 60))}</td><td>${esc(human(e.type))}</td><td>${esc(e.stance || "")}</td><td>${e.type === "RULE_SCORES" ? (mismatch() ? "hidden" : esc(e.points)) : "0"}</td><td>${esc([human(e.group), human(e.scope)].filter(Boolean).join(" · "))}</td></tr>`).join("")}
      </tbody></table></details></div>`;
  }

  function bindNodes() {
    root.querySelectorAll("g.gnode").forEach((el) => {
      el.addEventListener("click", () => selectNode(el.dataset.nodeId));
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectNode(el.dataset.nodeId); } });
    });
    root.querySelectorAll("[data-list-node]").forEach((el) => el.addEventListener("click", () => selectNode(el.dataset.listNode)));
    root.querySelectorAll("g.ggroup").forEach((el) => {
      const toggle = () => { g.fdaOpen = !g.fdaOpen; if (g.sel && !byId().has(g.sel)) g.sel = null; renderView(); };
      el.addEventListener("click", (ev) => { ev.stopPropagation(); toggle(); });
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    });
    const svg = root.querySelector(".g-svg");
    svg?.addEventListener("click", (ev) => { if (!ev.target.closest("g.gnode, g.ggroup")) clearSel(); });
  }

  function clearSel() {
    g.sel = null;
    const svg = root.querySelector(".g-svg");
    if (svg) { svg.classList.remove("has-sel"); svg.querySelectorAll(".sel, .near, .hl").forEach((el) => el.classList.remove("sel", "near", "hl")); }
    root.querySelectorAll("[data-list-node].sel").forEach((el) => el.classList.remove("sel"));
    $("#graph-panel").innerHTML = PANEL_HINT;
  }

  // ---------------------------------------------------------------- panel
  function selectNode(id, scroll = true) {
    const n = byId().get(id);
    if (!n) return;
    g.sel = id;
    const svg = root.querySelector(".g-svg");
    if (svg) {
      svg.classList.add("has-sel");
      svg.querySelectorAll("g.gnode").forEach((el) => el.classList.toggle("sel", el.dataset.nodeId === id));
      const near = new Set([id]);
      svg.querySelectorAll("g.gedge").forEach((el) => {
        const on = el.dataset.from === id || el.dataset.to === id;
        el.classList.toggle("hl", on);
        if (on) { near.add(el.dataset.from); near.add(el.dataset.to); }
      });
      svg.querySelectorAll("g.gnode").forEach((el) => el.classList.toggle("near", near.has(el.dataset.nodeId)));
      svg.querySelectorAll("g.ggroup").forEach((el) => el.classList.toggle("near", near.has(el.dataset.groupId)));
      svg.querySelectorAll("g.g-badge").forEach((el) => {
        const e = svg.querySelector(`g.gedge[data-edge-id="${CSS.escape(el.dataset.badgeFor)}"]`);
        el.classList.toggle("dim", !!e && !e.classList.contains("hl"));
      });
    }
    root.querySelectorAll("[data-list-node]").forEach((el) => el.classList.toggle("sel", el.dataset.listNode === id));
    const panel = $("#graph-panel");
    panel.innerHTML = panelHtml(n);
    panel.querySelectorAll("[data-goto]").forEach((el) => el.addEventListener("click", () => selectNode(el.dataset.goto)));
    panel.querySelector("[data-open-packet]")?.addEventListener("click", () => document.querySelector('.tab[data-tab="packet"]')?.click());
    if (scroll && window.innerWidth <= 1360) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function srcLinkHtml(nct, page, quote, text) {
    if (!nct || !page) return "";
    return `<a class="src-link gp-btn" href="#" role="button" data-nct="${esc(nct)}" data-page="${esc(page)}" data-quote="${esc(quote || "")}" title="${esc(text || "")}">Open source page<span class="gp-btn-sub">${esc(nct)} · p.${esc(page)}</span></a>`;
  }

  function panelHtml(n) {
    const d = n.data || {};
    const s = n.source || {};
    const nodes = byId();
    const edges = g.data.edges || [];
    let body = "";
    const quote = s.quote ? `<blockquote class="gp-quote"><span class="gp-qtext">${esc(String(s.quote).replace(/\s+/g, " ").trim())}</span><footer>${esc(s.nct ? `${s.nct} protocol` : n.type === "GuidancePassage" ? "FDA guidance" : "source")}${pageOf(s) ? ` · page ${esc(pageOf(s))}` : ""} · verbatim</footer></blockquote>` : "";
    const pdf = s.url && s.page ? `<a class="gp-link" href="${esc(s.url.split("#")[0])}#page=${esc(s.page)}" target="_blank" rel="noopener">Official PDF, p.${esc(s.page)}</a>` : "";
    switch (n.type) {
      case "Criterion":
        body = `${quote}<div class="gp-row">${srcLinkHtml(s.nct, s.page, s.quote, `Open ${s.nct} protocol p.${s.page}`) || `<span class="src">registry text (no protocol page)</span>`}${pdf}</div>
          <div class="src">${esc(d.section || "")} criterion · ${esc(d.operator || "")}${esc(num(d.value_norm))} ${esc(d.unit_norm || "")}</div>`;
        break;
      case "Passage":
        body = `${quote}<div class="gp-row">${srcLinkHtml(s.nct, s.page, s.quote, `Open ${s.nct} protocol p.${s.page}`)}${pdf}</div>
          <div class="src">${d.value_specific ? "This passage references the threshold value itself." : "The passage discusses the topic; it does not state why this specific threshold was chosen."}</div>`;
        break;
      case "ComparatorThreshold": {
        const sim = d.similarity || {};
        body = `<div><b>${esc(d.acronym || d.nct_id)}</b>${d.acronym && d.acronym !== d.nct_id ? ` <span class="src">${esc(d.nct_id)}</span>` : ""} used <b>${esc(d.operator || "")}${esc(num(d.value_norm))} ${esc(d.unit_norm || "")}</b> · ${esc(human(d.direction))}</div>
          ${quote}<div class="gp-row">${srcLinkHtml(s.nct, s.page, s.quote, `Open ${s.nct} protocol p.${s.page}`)}${pdf}<a class="gp-link" href="https://clinicaltrials.gov/study/${esc(d.nct_id)}" target="_blank" rel="noopener">Registry record</a></div>
          <div class="gp-kv"><span>Regimen coverage</span><span>${esc(d.coverage?.status || "?")}${(d.coverage?.missing_classes || []).length ? ` (lacks ${esc(d.coverage.missing_classes.join(", "))})` : ""}</span>
            ${sim.protocol_class_jaccard != null ? `<span>Drug-class overlap</span><span>${esc(num(sim.protocol_class_jaccard))} (protocol classes), ${esc(num(sim.registry_jaccard))} (registry)</span>` : ""}
            ${(sim.shared_classes || []).length ? `<span>Shared classes</span><span>${esc(sim.shared_classes.join(", "))}</span>` : ""}</div>
          <div class="src">${d.direction === "comparator looser" ? "A more permissive threshold in a comparable trial shows the value was used there; it is precedent for review, not evidence about this regimen." : d.direction === "same" ? "Agreement may reflect template carry-forward rather than independent justification." : "A difference from a comparable trial is a review question, not a mistake."}</div>`;
        break;
      }
      case "GuidancePassage":
        body = `${quote}<div class="gp-row">${s.url ? `<a class="gp-btn" href="${esc(s.url)}" target="_blank" rel="noopener">Open PDF at page${pageOf(s) ? " " + esc(pageOf(s)) : ""}<span class="gp-btn-sub">${esc(short(d.citation || "FDA guidance", 64))} · new tab</span></a>` : esc(d.citation || "")}</div>
          <div class="gp-kv"><span>Issued</span><span>${esc(d.issued || "?")}${d.retrospective ? " · retrospective" : ""}</span><span>Strength</span><span>${esc(d.strength || "general")}${d.strength === "specific" ? "" : " (general principle; adds 0 points)"}</span></div>
          ${d.timing_note ? `<div class="src">${esc(d.timing_note)}</div>` : ""}`;
        break;
      case "CuratedFact":
        body = `<div>${esc(d.summary || n.label)}</div><div class="src">${d.existence_only ? "Existence only: supports having a threshold, never a specific value." : "From the curated class-level pharmacology table (not re-verified against current labels)."}</div>`;
        break;
      case "ScoreRule":
        body = `<div><b>${esc(human(d.group))}</b>: ${esc(pointsText(d.points, d.axis, d.group))}</div><div class="src">${esc(GROUP_NOTE[d.group] || "")}</div>
          <div class="gp-sub">Members</div><ul class="gp-links">${(d.members || []).map((m) => `<li><button type="button" class="linkish" data-goto="${esc(m)}">${esc(nodes.get(m)?.label || m)}</button></li>`).join("")}</ul>`;
        break;
      case "Assessment": {
        const rules = edges.filter((e) => e.type === "RULE_SCORES" && e.to === n.id);
        body = `<div class="gp-kv"><span>Support</span><span>${esc(d.scores?.support)}</span><span>Challenge</span><span>${esc(d.scores?.challenge)}</span></div>
          ${mismatch() ? `<div class="src">Per-rule attribution is hidden: derived points do not match the stored scores.</div>` : `<div class="gp-sub">Points by rule</div><ul class="gp-links">${rules.map((e) => `<li><button type="button" class="linkish" data-goto="${esc(e.from)}">${esc(human(e.group))}</button> ${esc(e.label || pointsText(e.points, e.axis, e.group))}</li>`).join("") || "<li class='src'>no rule fired</li>"}</ul><div class="src">Other evidence is shown for review and adds 0 points.</div>`}
          ${d.explanation ? `<p class="gp-expl">${esc(d.explanation)}</p>` : ""}`;
        break;
      }
      case "Classification":
        body = `<div><span class="cls ${clsKeyOf(d.classification || n.label)}">${esc(d.classification || n.label)}</span></div><div class="src">A prompt for expert review. The team decides; TrialLens prepares the evidence.</div>
          <div class="gp-row"><button type="button" class="small ghost" data-open-packet>Record a decision in the review packet</button></div>`;
        break;
      case "Recommendation":
        body = `<div><b>${esc(human(d.action))}</b></div><div>${esc(d.text || "")}</div>`;
        break;
      case "MissingEvidence":
        body = `<div>${esc(d.text || n.label)}</div>${d.affects_rule ? `<div class="src">Would affect the rule: ${esc(human(d.affects_rule))}</div>` : ""}`;
        break;
      case "ReviewerDecision":
        body = `<div><b>${esc(d.label || d.decision)}</b></div>${d.reason ? `<div>${esc(d.reason)}</div>` : ""}<div class="src">${esc(d.reviewer || "")} · ${esc(d.recorded_at || "")}</div>`;
        break;
      default:
        body = `<div>${esc(n.label)}</div>`;
    }
    const conn = edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => {
      const other = e.from === n.id ? e.to : e.from;
      const dir = e.from === n.id ? "→" : "←";
      return `<li>${dir} <button type="button" class="linkish" data-goto="${esc(other)}">${esc(short(nodes.get(other)?.label || other, 70))}</button> <span class="src">${esc(human(e.type))}${e.stance ? " · " + esc(e.stance) : ""}${edgeLabel(e) ? " · " + esc(edgeLabel(e)) : ""}</span></li>`;
    }).join("");
    return `<div class="gp-cap">${esc(n.type.replace(/([a-z])([A-Z])/g, "$1 $2"))} · <span class="gp-epi e-${esc(n.epistemic || "")}">${esc(EPISTEMIC[n.epistemic] || n.epistemic || "")}</span></div>
      <h4 class="gp-title">${esc(n.label)}</h4>${body}
      ${conn ? `<div class="gp-sub">Connections</div><ul class="gp-links">${conn}</ul>` : ""}`;
  }

  // ---------------------------------------------------------------- investigator
  async function investigate(question) {
    if (!g.data || !g.cid) return;
    const req = g.req;
    const out = $("#inv-answer");
    const mode = $("#inv-use-model")?.checked ? "model" : "deterministic";
    root.querySelectorAll(".inv-q").forEach((b) => { b.disabled = true; b.classList.toggle("ghost", b.dataset.question !== question); });
    out.dataset.state = "loading";
    out.innerHTML = `<div class="loading">Running the bounded investigation (at most 4 tool calls, 60 s)…</div>`;
    try {
      const r = await post("/api/investigate", { nct: state.nct, criterion_id: g.cid, question, as_of: state.asOf, mode });
      if (req !== g.req) return;
      g.inv = r;
      renderAnswer(r);
    } catch (e) {
      if (req !== g.req) return;
      out.dataset.state = "error";
      out.innerHTML = `<div class="error">The investigator could not answer: ${esc(e.message)}. The graph above is unaffected.</div>`;
      $("#inv-security").innerHTML = securityHtml(null);
    } finally {
      root.querySelectorAll(".inv-q").forEach((b) => (b.disabled = false));
    }
  }

  function renderAnswer(r) {
    const out = $("#inv-answer");
    const nodes = byId();
    const a = r.answer || {};
    const st = a.statements || [];
    const checks = r.checks || [];
    const chip = (id) => `<button type="button" class="linkish ev-chip" data-goto="${esc(id)}" title="${esc(id)}">${esc(short(nodes.get(id)?.label || id, 48))}</button>`;
    const badge = (c) => `<span class="inv-check" data-result="${esc(c.result)}" title="${esc(c.detail || "")}">${esc(human(c.check))}: ${esc(c.result)}</span>`;
    // one visible chip per (check, result) with a count; the duplicates stay in the DOM (hidden) so counts of .inv-check hold
    const badges = (list) => {
      const seen = new Map();
      list.forEach((c) => { const k = c.check + "|" + c.result; seen.set(k, (seen.get(k) || 0) + 1); });
      const shown = new Set();
      return list.map((c) => {
        const k = c.check + "|" + c.result;
        if (shown.has(k)) return `<span class="inv-check" data-result="${esc(c.result)}" hidden></span>`;
        shown.add(k);
        const nn = seen.get(k);
        return `<span class="inv-check" data-result="${esc(c.result)}" title="${esc(c.detail || "")}"><i class="ic-dot"></i>${esc(human(c.check))}${nn > 1 ? ` ×${nn}` : ""}${c.result === "pass" ? "" : `: ${esc(c.result)}`}</span>`;
      }).join("");
    };
    const ql = (QUESTIONS.find(([q]) => q === r.question) || [r.question, r.question])[1];
    const modelLine = r.model?.status?.startsWith?.("unavailable") ? `<div class="warnbox">The model was unavailable (${esc(r.model.status.replace(/^unavailable:?\s*/, ""))}); this is the deterministic answer.</div>` : "";
    if (!st.length) {
      out.dataset.state = "empty";
      out.innerHTML = `<div class="inv-q-title">${esc(ql)}</div>${modelLine}<div class="inv-empty"><b>Insufficient evidence</b>: no statement could be grounded in the graph for this question.${a.summary ? ` ${esc(a.summary)}` : ""}</div>
        ${counterHtml(r, chip)}`;
    } else {
      out.dataset.state = "ready";
      const general = checks.filter((c) => !c.statement_id);
      out.innerHTML = `<div class="inv-q-title">${esc(ql)} <span class="src">· ${esc(r.mode || "deterministic")} · overall: ${esc(human(a.overall || ""))} · classification unchanged: ${esc(r.classification || "")}</span></div>
        ${modelLine}
        ${a.summary ? `<p class="inv-summary">${esc(a.summary)}</p>` : ""}
        <ol class="inv-statements">${st.map((s) => `<li class="inv-statement" data-status="${esc(s.status)}" data-polarity="${esc(s.polarity || "")}">
          <span class="inv-status ${esc(s.status)}">${esc(s.status)}</span> <span class="inv-pol">${esc(s.polarity || "")}</span>
          <span class="inv-text">${esc(s.text)}</span>
          ${s.status === "unsupported" ? `<div class="src">Failed: ${esc((s.failed_checks || []).join("; ") || "verifier check")}. Shown for transparency; excluded from the summary.</div>` : ""}
          <div class="inv-ev">${(s.evidence_ids || []).map(chip).join(" ")}</div>
          <div class="inv-checks">${badges(checks.filter((c) => c.statement_id === s.id))}</div></li>`).join("")}</ol>
        ${general.length ? `<div class="inv-general"><span class="src">Answer-level checks</span><div class="inv-checks">${badges(general)}</div></div>` : ""}
        ${counterHtml(r, chip)}
        ${(r.tool_calls || []).length ? `<details class="src"><summary>${r.tool_calls.length} tool call(s)</summary><ul>${r.tool_calls.map((t) => `<li><code>${esc(t.tool)}</code> ${esc(JSON.stringify(t.args || {}))} · ${esc(t.ms)} ms · ${esc(t.result_summary || "")}</li>`).join("")}</ul></details>` : ""}`;
    }
    out.querySelectorAll("[data-goto]").forEach((el) => el.addEventListener("click", () => selectNode(el.dataset.goto)));
    $("#inv-security").innerHTML = securityHtml(r);
  }

  function counterHtml(r, chip) {
    const ce = r.counterevidence || [];
    return `<div class="inv-counter"><b>Counterevidence (always gathered)</b>: ${ce.length ? ce.map(chip).join(" ") : `<span class="src">none recorded in the graph</span>`}</div>`;
  }

  // ---------------------------------------------------------------- wiring
  document.querySelectorAll('.tab[data-tab="graph"]').forEach((t) => t.addEventListener("click", show));
  document.getElementById("loadForm")?.addEventListener("submit", () => {
    // app.js has already set state.nct for the new trial; drop the old graph immediately
    clear("A different trial is being reviewed; the previous graph was cleared.");
    if (tabActive()) show();
  });
  shell();
  setState("empty", "Open this tab after a protocol review has loaded.", "loading");
})();
