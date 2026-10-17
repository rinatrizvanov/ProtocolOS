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
    { key: "protocol", title: "Protocol & regimen", types: ["Criterion", "CuratedFact", "Passage"], w: 175 },
    { key: "comparators", title: "Comparable trials", types: ["ComparatorThreshold"], w: 165 },
    { key: "fda", title: "FDA guidance", types: ["GuidancePassage"], w: 190 },
    { key: "rules", title: "Score rules", types: ["ScoreRule"], w: 165 },
    { key: "assessment", title: "Assessment", types: ["Assessment", "Recommendation", "MissingEvidence"], w: 180 },
    { key: "classification", title: "Classification", types: ["Classification", "ReviewerDecision"], w: 140 },
  ];
  // gaps after each column; the points labels sit in the gap before the assessment
  const GAPS = [26, 26, 44, 112, 30];
  const TYPE_ORDER = ["Criterion", "CuratedFact", "Passage", "ComparatorThreshold", "GuidancePassage", "ScoreRule",
    "Assessment", "Recommendation", "MissingEvidence", "Classification", "ReviewerDecision"];
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

  const g = { key: null, nct: null, cid: null, data: null, sel: null, req: 0, seenSelected: null, view: "graph", inv: null, err: null, waitTimer: null };

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
      case "GuidancePassage": return `FDA ${d.strength || "general"}${d.retrospective ? " · retrospective" : ""}`;
      case "ScoreRule": return "Score rule";
      case "Assessment": return `support ${d.scores?.support ?? "?"} · challenge ${d.scores?.challenge ?? "?"}`;
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
    if (n.type === "ScoreRule") return [human(d.group), pointsText(d.points, d.axis, d.group)];
    if (n.type === "MissingEvidence") return d.text || n.label;
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
      <div class="g-body">
        <div class="g-canvas card"><div class="g-svgwrap"></div><div class="g-listwrap"></div>${legendHtml()}</div>
        <aside id="graph-panel" class="card" aria-live="polite"><div class="src">Click a node to see its verbatim source, page link and connections.</div></aside>
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
    const budget = b
      ? `tools ${b.used ?? 0}/${b.max_tool_calls ?? 4}, model calls ${b.used_model ?? 0}/${b.max_model_calls ?? 2}, ${num(r.elapsed_s ?? 0)} s`
      : "budget: 4 tools, 2 model calls, 60 s per question";
    return `<h4>Agent safeguards</h4>
      <div class="sec-budget">${esc(budget)}</div>
      <ul class="sec-list">
        <li>Fixed questions only; no free text reaches a model.</li>
        <li>Read-only whitelisted tools${r?.tools_used?.length ? `: ${esc(r.tools_used.join(", "))}` : ""}.</li>
        <li>Protocol, registry and FDA text: documents are data, never instructions.</li>
        <li>A model can only downgrade a flag; the classification is never changed by an answer.</li>
        <li class="sec-verifier">${r ? `verifier: ${n("pass")} checks passed${n("warn") ? `, ${n("warn")} warning${n("warn") === 1 ? "" : "s"}` : ""}${n("fail") ? `, ${n("fail")} failed` : ""}` : "verifier: runs on every answer"}</li>
        <li>Model: <span data-model-status>${esc(modelStatus(r))}</span></li>
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
    $("#graph-panel").innerHTML = `<div class="src">Click a node to see its verbatim source, page link and connections.</div>`;
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
    renderView();
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

  function layout() {
    const nodes = [...(g.data.nodes || [])];
    const order = (n) => { const i = TYPE_ORDER.indexOf(n.type); return i < 0 ? 99 : i; };
    nodes.sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const cols = COLUMNS.map((c) => ({ ...c, nodes: [] }));
    const other = { key: "other", title: "Other", types: [], w: 180, nodes: [] };
    nodes.forEach((n) => (cols.find((c) => c.types.includes(n.type)) || other).nodes.push(n));
    if (other.nodes.length) cols.push(other);
    const H = (n) => (n.type === "GuidancePassage" ? 44 : 58);
    const GAP = 10, TOP = 34;
    const colGap = (c) => (c.key === "rules" ? 30 : GAP); // room for the group label above each rule
    let x = 10, lastGap = 0;
    const pos = new Map();
    const heights = cols.map((c) => c.nodes.reduce((s, n) => s + H(n) + colGap(c), 0));
    const maxH = Math.max(120, ...heights);
    cols.forEach((c, i) => {
      c.x = x;
      if (!c.nodes.length) return; // empty columns take no space
      let y = TOP + (maxH - heights[i]) / 2;
      c.nodes.forEach((n) => { pos.set(n.id, { x, y, w: c.w, h: H(n), col: c.key }); y += H(n) + colGap(c); });
      lastGap = GAPS[i] ?? 40;
      x += c.w + lastGap;
    });
    return { cols, pos, width: x - lastGap + 20, height: TOP + maxH + 10 };
  }

  function svgHtml() {
    const L = layout();
    const nodes = byId();
    const edges = (g.data.edges || []).filter((e) => L.pos.has(e.from) && L.pos.has(e.to));
    const heads = L.cols.map((c) => c.nodes.length ? `<text class="g-colhead" x="${c.x}" y="16">${esc(c.title)}</text>` : "").join("");
    const groupLabelled = new Set();
    const edgeSvg = edges.map((e) => {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      let x1, y1, x2, y2, d;
      if (a.col === b.col) { // link inside a column (assessment -> missing evidence): loop out on the left
        x1 = a.x; y1 = a.y + a.h / 2; x2 = b.x; y2 = b.y + b.h / 2;
        const bulge = Math.min(26, 10 + Math.abs(y2 - y1) / 12);
        d = `M${x1},${y1} C${x1 - bulge},${y1} ${x2 - bulge},${y2} ${x2},${y2}`;
      } else {
        const fwd = a.x < b.x;
        x1 = fwd ? a.x + a.w : a.x; y1 = a.y + a.h / 2; x2 = fwd ? b.x : b.x + b.w; y2 = b.y + b.h / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      }
      const lbl = edgeLabel(e);
      let txt = "";
      if (lbl && e.type === "RULE_SCORES") {
        const [main, paren] = lbl.split(/ (?=\()/);
        txt = `<text class="g-elabel pts ${esc(e.axis || "")}" x="${x1 + 6}" y="${y1 - (paren ? 17 : 5)}">${esc(main)}${paren ? ` <tspan x="${x1 + 6}" dy="12">${esc(paren)}</tspan>` : ""}</text>`;
      }
      else if (lbl && e.type === "EVIDENCE_IN_RULE" && !groupLabelled.has(e.to + "|" + lbl)) {
        groupLabelled.add(e.to + "|" + lbl); // members converge on the rule node: label the group once
        txt = `<text class="g-elabel grp${e.scope ? " scope" : ""}" x="${b.x + 2}" y="${b.y - 5}">${esc(lbl)}</text>`;
      }
      const cls = ["gedge", `t-${e.type}`, `s-${e.stance || "none"}`, e.points ? "has-pts" : "", e.scope ? "scoped" : ""].join(" ");
      const title = `${nodes.get(e.from)?.label || e.from} → ${nodes.get(e.to)?.label || e.to}: ${human(e.type)}${e.stance ? " · " + e.stance : ""}${e.group ? " · " + human(e.group) : ""}${e.scope ? " · " + human(e.scope) : ""}${e.type === "RULE_SCORES" && !mismatch() ? " · " + (e.points ?? 0) + " points" : ""}`;
      return `<g class="${cls}" data-edge-id="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><title>${esc(title)}</title><path d="${d}"/>${txt}</g>`;
    }).join("");
    const nodeSvg = [...L.pos.entries()].map(([id, p]) => {
      const n = nodes.get(id);
      const t = nodeText(n);
      const lines = Array.isArray(t) ? t : wrap(t, Math.floor((p.w - 14) / 6.4), n.type === "GuidancePassage" ? 1 : 2);
      const extra = n.type === "Classification" ? ` k-${clsKeyOf(n.label)}` : "";
      const double = n.epistemic === "human" ? `<rect class="inner" x="${p.x + 3}" y="${p.y + 3}" width="${p.w - 6}" height="${p.h - 6}" rx="4"/>` : "";
      return `<g class="gnode t-${esc(n.type)} e-${esc(n.epistemic || "unknown")}${extra}" data-node-id="${esc(id)}" data-node-type="${esc(n.type)}" tabindex="0" role="button" aria-label="${esc(n.type + ": " + (n.label || id))}">
        <title>${esc(n.label || id)}</title>
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6"/>${double}
        <text class="cap" x="${p.x + 8}" y="${p.y + 14}">${esc(short(caption(n), Math.floor((p.w - 14) / 6.3)))}</text>
        ${lines.map((l, i) => `<text class="lbl" x="${p.x + 8}" y="${p.y + 29 + i * 14}">${esc(l)}</text>`).join("")}
      </g>`;
    }).join("");
    return `<svg class="g-svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" style="max-width:${L.width}px;min-width:${Math.min(900, L.width)}px" role="img" aria-label="Evidence graph for ${esc(g.cid)}">${heads}<g class="g-edges">${edgeSvg}</g><g class="g-nodes">${nodeSvg}</g></svg>`;
  }

  function listHtml() {
    const nodes = byId();
    const edges = g.data.edges || [];
    const cols = layout().cols.filter((c) => c.nodes.length);
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
    }
    root.querySelectorAll("[data-list-node]").forEach((el) => el.classList.toggle("sel", el.dataset.listNode === id));
    const panel = $("#graph-panel");
    panel.innerHTML = panelHtml(n);
    panel.querySelectorAll("[data-goto]").forEach((el) => el.addEventListener("click", () => selectNode(el.dataset.goto)));
    panel.querySelector("[data-open-packet]")?.addEventListener("click", () => document.querySelector('.tab[data-tab="packet"]')?.click());
    if (scroll && window.innerWidth < 1100) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function srcLinkHtml(nct, page, quote, text) {
    if (!nct || !page) return "";
    return `<a class="src-link" data-nct="${esc(nct)}" data-page="${esc(page)}" data-quote="${esc(quote || "")}">${esc(text || `${nct} p.${page}`)}</a>`;
  }

  function panelHtml(n) {
    const d = n.data || {};
    const s = n.source || {};
    const nodes = byId();
    const edges = g.data.edges || [];
    let body = "";
    const quote = s.quote ? `<q class="gp-quote">${esc(s.quote)}</q>` : "";
    const pdf = s.url && s.page ? ` · <a class="src-link" href="${esc(s.url.split("#")[0])}#page=${esc(s.page)}" target="_blank" rel="noopener">official PDF</a>` : "";
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
        body = `<div><b>${esc(d.acronym || d.nct_id)}</b> <span class="src">${esc(d.nct_id)}</span> used <b>${esc(d.operator || "")}${esc(num(d.value_norm))} ${esc(d.unit_norm || "")}</b> · ${esc(human(d.direction))}</div>
          ${quote}<div class="gp-row">${srcLinkHtml(s.nct, s.page, s.quote, `Open ${s.nct} protocol p.${s.page}`)}${pdf} · <a class="src-link" href="https://clinicaltrials.gov/study/${esc(d.nct_id)}" target="_blank" rel="noopener">registry record</a></div>
          <div class="gp-kv"><span>Regimen coverage</span><span>${esc(d.coverage?.status || "?")}${(d.coverage?.missing_classes || []).length ? ` (lacks ${esc(d.coverage.missing_classes.join(", "))})` : ""}</span>
            ${sim.protocol_class_jaccard != null ? `<span>Drug-class overlap</span><span>${esc(num(sim.protocol_class_jaccard))} (protocol classes), ${esc(num(sim.registry_jaccard))} (registry)</span>` : ""}
            ${(sim.shared_classes || []).length ? `<span>Shared classes</span><span>${esc(sim.shared_classes.join(", "))}</span>` : ""}</div>
          <div class="src">${d.direction === "comparator looser" ? "A more permissive threshold in a comparable trial shows the value was used there; it is precedent for review, not evidence about this regimen." : d.direction === "same" ? "Agreement may reflect template carry-forward rather than independent justification." : "A difference from a comparable trial is a review question, not a mistake."}</div>`;
        break;
      }
      case "GuidancePassage":
        body = `${quote}<div class="gp-row">${s.url ? `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(d.citation || "FDA guidance")}</a>` : esc(d.citation || "")}</div>
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
          <div class="inv-checks">${checks.filter((c) => c.statement_id === s.id).map(badge).join(" ")}</div></li>`).join("")}</ol>
        ${general.length ? `<div class="inv-checks">${general.map(badge).join(" ")}</div>` : ""}
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
