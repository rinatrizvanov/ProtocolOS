"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (v) => (v == null ? "—" : Number.isInteger(+v) ? String(+v) : String(+v));
const fmtCrit = (c) => (c ? `${c.operator}${fmtNum(c.value_norm)} ${c.unit_norm}` : "—");
const clsKey = (c) => (c.startsWith("Review") ? "review" : c.startsWith("Evidence") ? "retain" : "insufficient");

const state = { nct: null, asOf: "auto", review: null, selected: null, status: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ------------------------------------------------------------------ status chips
async function loadStatus() {
  const s = await api("/api/status");
  state.status = s;
  const chalk = s.chalk || {};
  $("#chips").innerHTML = [
    `<span class="chip on" title="Quotes verified verbatim against the FDA PDFs at startup">FDA passages verified: ${s.fda_passages.verified}${s.fda_passages.failed.length ? ` (${s.fda_passages.failed.length} failed)` : ""}</span>`,
    `<span class="chip ${s.llm.available ? "on" : "off"}">LLM critic: ${s.llm.available ? esc(s.llm.model) : "not configured"}</span>`,
    `<span class="chip ${(chalk.status || "").startsWith("operational") ? "on" : "off"}" title="${esc(chalk.detail || "")}">Chalk: ${esc(chalk.status || "unknown")}</span>`,
  ].join("");
}

// ------------------------------------------------------------------ load review
async function loadReview(nct, asOf, refresh = false) {
  state.nct = nct; state.asOf = asOf; state.selected = null;
  $("#loading").classList.remove("hidden");
  $("#error").classList.add("hidden");
  ["#study", "#summary", "#criteria", "#detail"].forEach((s) => ($(s).innerHTML = ""));
  try {
    state.review = await api(`/api/review/${encodeURIComponent(nct)}?as_of=${asOf}${refresh ? "&refresh=1" : ""}`);
    renderStudy(); renderSummary(); renderCriteria();
    const first = state.review.reviews.find((r) => r.classification.startsWith("Review")) || state.review.reviews[0];
    if (first) select(first.criterion.id);
  } catch (e) {
    $("#error").textContent = `Could not review ${nct}: ${e.message}`;
    $("#error").classList.remove("hidden");
  } finally {
    $("#loading").classList.add("hidden");
  }
}

function renderStudy() {
  const { study, regimen } = state.review.target;
  const doc = (study.protocol_docs || [])[0];
  const drugs = Object.entries(regimen.drugs).map(([n, d]) => {
    const flags = [d.myelosuppressive && "MYELO", d.hepatic && "HEP", d.renal && "REN", d.immunotherapy && "IO"].filter(Boolean);
    return `<span class="drug" title="${esc(d.sources.join(" | "))}">${esc(n)} <small>${esc(d.class)}</small>${flags.map((f) => `<span class="flag">${f}</span>`).join("")}</span>`;
  }).join("");
  $("#study").innerHTML = `
    <div class="card">
      <div class="study-head">
        <div>
          <a class="nct" href="${esc(study.registry_url)}" target="_blank" rel="noopener">${esc(study.nct_id)}</a>
          ${study.acronym ? `<span class="chip">${esc(study.acronym)}</span>` : ""}
          <div class="study-title">${esc(study.official_title || study.title)}</div>
          <div class="meta">
            <span><b>Sponsor</b> ${esc(study.sponsor)}</span>
            <span><b>Phase</b> ${esc((study.phases || []).join(", "))}</span>
            <span><b>Status</b> ${esc(study.status)}${study.why_stopped ? ` — ${esc(study.why_stopped)}` : ""}</span>
            <span><b>Start</b> ${esc(study.start_date)}</span>
            <span><b>Enrollment</b> ${esc(study.enrollment?.count)} (${esc(study.enrollment?.type)})</span>
          </div>
        </div>
        <div class="meta" style="flex-direction:column;align-items:flex-end">
          <span><b>Criteria source</b> ${esc(study.criteria_source)}</span>
          ${doc ? `<span><b>Protocol</b> <a class="src-link" href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(doc.filename)} (${esc(doc.date)})</a></span>` : ""}
          <span><b>Eligibility pages</b> ${esc((study.eligibility_pages || []).join(", ") || "—")}</span>
          <span><b>Comparator cutoff</b> ${esc(state.review.as_of || "none")}</span>
        </div>
      </div>
      <div class="regimen"><span class="chip">Regimen (all arms)</span>${drugs}</div>
      ${(regimen.unrecognized || []).length ? `<div class="src" style="margin-top:6px">Agents outside the curated pharmacology table: ${esc(regimen.unrecognized.join(", "))} (their toxicity relevance is not assessed).</div>` : ""}
      <div id="chalkProfile" class="src" style="margin-top:8px">Checking registry profile via Chalk…</div>
    </div>`;
  loadChalkProfile(study);
}

async function loadChalkProfile(study) {
  const el = $("#chalkProfile");
  try {
    const p = await api(`/api/chalk/registry/${encodeURIComponent(study.nct_id)}`);
    if (p.status !== "ok") { el.textContent = `Chalk registry profile: ${p.status}${p.detail ? " — " + p.detail : ""}`; return; }
    const v = p.values;
    const labPages = (state.review.target.criteria.filter((c) => c.category === "lab" && c.source.page).map((c) => c.source.page));
    el.innerHTML = `<span class="chip on">Chalk</span> Registry eligibility text: ${esc(v.registry_eligibility_chars)} characters · mentions neutrophil/ANC: <b>${v.registry_mentions_anc ? "yes" : "no"}</b> · ECOG in registry: ${esc(v.registry_ecog_max ?? "not stated")} · protocol PDF posted: ${v.has_protocol_pdf ? "yes" : "no"}.
      ${!v.registry_mentions_anc && labPages.length ? ` Lab thresholds were read from the protocol PDF (p.${esc([...new Set(labPages)].join(", "))}).` : ""}
      <span title="${esc(p.source)}">Served by Chalk online query ${esc(p.query_id || "")} (${esc(p.environment || "")}, ${esc(p.execution_seconds)} s).</span>`;
  } catch (e) { el.textContent = `Chalk registry profile unavailable: ${e.message}`; }
}

function renderSummary() {
  const counts = {};
  state.review.reviews.forEach((r) => (counts[r.classification] = (counts[r.classification] || 0) + 1));
  const comps = state.review.comparators.map((c) => `<a class="src-link" href="${esc(c.study.registry_url)}" target="_blank">${esc(c.study.acronym || c.study.nct_id)}</a>`).join(", ");
  $("#summary").innerHTML = `<div class="summary">
    ${["Review recommended", "Evidence supports retaining", "Insufficient evidence"].map((k) =>
      `<div class="stat"><div class="n">${counts[k] || 0}</div><div class="l"><span class="cls ${clsKey(k)}">${k}</span></div></div>`).join("")}
    <div class="stat" style="flex:1"><div class="l">Comparable trials (auto-selected, protocol PDFs parsed)</div><div>${comps || "none found"}</div></div>
  </div>`;
}

function renderCriteria() {
  const groups = { lab: "Laboratory", performance_status: "Performance status", washout: "Washout periods" };
  let html = "";
  for (const [g, label] of Object.entries(groups)) {
    const items = state.review.reviews.filter((r) => r.criterion.category === g);
    if (!items.length) continue;
    html += `<div class="crit-group">${label}</div>`;
    html += items.map((r) => {
      const c = r.criterion;
      return `<div class="crit" data-id="${esc(c.id)}">
        <div class="lbl">${esc(c.label)}</div><div class="val">${esc(fmtCrit(c))}</div>
        <div class="src">${esc(c.section)} · ${c.source.page ? `p.${c.source.page}` : "registry"}</div>
        <div style="text-align:right"><span class="cls ${clsKey(r.classification)}">${esc(r.classification)}</span></div>
      </div>`;
    }).join("");
  }
  $("#criteria").innerHTML = html;
  $("#criteria").querySelectorAll(".crit").forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
}

// ------------------------------------------------------------------ detail
function select(id) {
  state.selected = id;
  document.querySelectorAll(".crit").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  renderDetail();
}

function srcLink(nct, page, quote, label) {
  if (!page) return `<span class="src-link" title="registry text">registry</span>`;
  return `<a class="src-link" data-nct="${esc(nct)}" data-page="${page}" data-quote="${esc(quote || "")}">${esc(label || `p.${page}`)}</a>`;
}

function renderDetail() {
  const r = state.review.reviews.find((x) => x.criterion.id === state.selected);
  const c = r.criterion;
  const nct = state.review.target.study.nct_id;
  const rows = state.review.comparison[c.id] || [];
  const dirCls = (d) => (d.includes("looser") ? "looser" : d.includes("stricter") ? "stricter" : "same");

  const compTable = `<table>
    <thead><tr><th>Trial</th><th>Regimen</th><th>Threshold</th><th>vs target</th><th>Regimen coverage</th><th>Source</th></tr></thead>
    <tbody>
      <tr class="target"><td>${esc(nct)} (reviewed)</td><td>${esc(Object.keys(state.review.target.regimen.drugs).join(", "))}</td><td>${esc(fmtCrit(c))}</td><td>—</td><td>—</td><td>${srcLink(nct, c.source.page, c.source.text)}</td></tr>
      ${rows.map((x) => `<tr>
        <td><a class="src-link" href="https://clinicaltrials.gov/study/${esc(x.nct_id)}" target="_blank">${esc(x.acronym || x.nct_id)}</a><div class="src">${esc(x.nct_id)} · ${esc(x.sponsor || "")} · start ${esc(x.start_date)}</div></td>
        <td>${esc(x.regimen.join(", "))}</td>
        <td>${esc(x.criterion ? fmtCrit(x.criterion) : "not found")}</td>
        <td><span class="dir ${dirCls(x.direction)}">${esc(x.direction)}</span></td>
        <td><span class="cov ${esc(x.coverage.status)}" title="${esc(x.coverage.detail || (x.coverage.missing_classes || []).length ? "missing: " + (x.coverage.missing_classes || []).join(", ") : "")}">${esc(x.coverage.status)}</span>${(x.coverage.missing_classes || []).length ? `<div class="src">lacks ${esc(x.coverage.missing_classes.join(", "))}</div>` : ""}</td>
        <td>${x.criterion ? srcLink(x.nct_id, x.criterion.source.page, x.criterion.source.text) : ""}</td>
      </tr>`).join("")}
    </tbody></table>`;

  const evCols = ["supports", "challenges", "context"].map((stance) => {
    const items = r.evidence.filter((e) => e.stance === stance && e.kind !== "fda");
    // criterion-specific FDA recommendations are evidence; general principles are listed once below the grid
    const fda = r.evidence.filter((e) => e.stance === stance && e.kind === "fda" && e.strength === "specific");
    const title = { supports: "Supports retaining", challenges: "Challenges the restriction", context: "Context" }[stance];
    return `<div class="ev-col ${stance}"><h4>${title}</h4>
      ${items.map((e) => `<div class="ev"><div class="k">${esc(e.tier || e.kind)} · ${esc(e.strength)}</div>${esc(e.summary)}
        ${e.quote && e.kind === "protocol" ? `<q>${esc(e.quote.slice(0, 320))}</q><div>${srcLink(nct, e.page, e.quote.slice(0, 80))}</div>` : ""}
        ${e.kind === "comparator" && e.page ? `<div>${srcLink(e.nct_id, e.page, e.quote, `${e.nct_id} p.${e.page}`)}</div>` : ""}</div>`).join("")}
      ${fda.map((e) => `<div class="ev fda"><div class="k">FDA guidance · ${esc(e.strength)}</div><q>${esc(e.quote)}</q>
        <div><a class="src-link" href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.citation)}</a></div></div>`).join("")}
      ${!items.length && !fda.length ? `<div class="src">none</div>` : ""}</div>`;
  }).join("");

  $("#detail").innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><h2>${esc(c.label)} <span style="font-family:var(--mono)">${esc(fmtCrit(c))}</span></h2>
          <div class="src">${esc(c.section)} criterion · extracted by ${esc(c.method)}${(c.conditions || []).map((x) => ` · ${esc(x.when)}: ${esc(x.operator || "")}${esc(x.value_norm ?? x.text ?? "")}`).join("")}${(c.exceptions || []).map((x) => ` · ${esc(x)}`).join("")}</div></div>
        <div><span class="cls ${clsKey(r.classification)}" style="font-size:13px">${esc(r.classification)}</span></div>
      </div>
      <div class="verbatim" style="margin-top:10px">${esc(c.source.text)}</div>
      ${c.item_text && c.item_text !== c.source.text ? `<details class="src" style="margin-top:4px"><summary>surrounding text</summary>${esc(c.item_text)}</details>` : ""}
      <div class="src" style="margin-top:4px">Source: ${srcLink(nct, c.source.page, c.source.text, c.source.page ? `protocol p.${c.source.page}, line ${c.source.line}` : "registry")} · <a class="src-link" href="${esc(c.source.url)}${c.source.page ? "#page=" + c.source.page : ""}" target="_blank" rel="noopener">open official document</a></div>
      <p class="explain">${esc(r.explanation)}</p>
      <div class="action"><b>Suggested review question (${esc(r.suggested_action.action.replaceAll("_", " "))}):</b> ${esc(r.suggested_action.text)}</div>
      <div id="critic" style="margin-top:10px"></div>
    </div>

    <div class="card"><h3>Likely scientific purpose of this restriction <span class="src" style="text-transform:none;letter-spacing:0">(inferred by TrialLens unless a source is cited)</span></h3>
      <div class="purposes">${(r.purposes || []).map((p) => `<div class="purpose"><span class="ptag ${p.status === "not indicated" ? "muted" : ""}">${esc(p.purpose)}</span><span class="pstatus">${esc(p.status)}</span><div>${esc(p.basis)}</div>
        ${p.fda_context ? `<div class="src">FDA describes this kind of exclusion: “${esc(p.fda_context.quote)}” — <a class="src-link" href="${esc(p.fda_context.link)}" target="_blank" rel="noopener">${esc(p.fda_context.citation)}</a>. ${esc(p.fda_context.note)}</div>` : ""}</div>`).join("")}</div>
      <div class="src" style="margin-top:6px">Restrictions can protect safety, enrich for prognosis or response, or reduce heterogeneity. Loosening one is never judged on enrollment alone.</div></div>

    <div class="card"><h3>Side-by-side with comparable trials</h3>${compTable}
      <div class="src" style="margin-top:6px">Coverage = whether the comparator's regimen contains the same toxicity-relevant drug classes as this trial (e.g. myelosuppressive classes for hematologic criteria). Partial coverage weakens the comparison.</div></div>

    <div class="card"><h3>Evidence</h3><div class="ev-grid">${evCols}</div>
      ${(() => { const g = r.evidence.filter((e) => e.kind === "fda" && e.strength !== "specific"); return g.length ? `<details style="margin-top:8px"><summary class="src">General FDA principles that apply to this criterion (${g.length} verified passages)</summary>${g.map((e) => `<div class="ev fda"><div class="k">FDA guidance · general · ${esc(e.stance)}</div><q>${esc(e.quote)}</q><div><a class="src-link" href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.citation)}</a></div></div>`).join("")}</details>` : ""; })()}</div>

    <div class="card"><h3>Evidence that is missing</h3><ul class="missing">${r.missing_evidence.map((m) => `<li>${esc(m)}</li>`).join("") || "<li>none recorded</li>"}</ul></div>

    <div class="card" id="whatifCard"><h3>Inspect an alternative threshold</h3>
      ${c.value_norm != null ? `<div class="form-row"><label>Alternative value (${esc(c.unit_norm)})</label>
        <input type="number" id="altVal" step="any" value="${esc(suggestAlt(c, rows))}" style="width:110px" />
        <button class="small" id="runWhatif">Compare &amp; verify</button></div><div id="whatifOut"></div>` : "<div class='src'>No numeric value.</div>"}
    </div>

    <div class="card"><h3>Challenge a recommendation (verification layer)</h3>${challengeForm(c)}<div id="verifyOut"></div></div>`;

  bindDetail(c);
}

function suggestAlt(c, rows) {
  const looser = rows.filter((x) => x.direction === "comparator looser" && x.criterion).map((x) => x.criterion.value_norm);
  if (looser.length) return looser[0];
  if (c.analyte === "anc") return 1.2;
  return c.value_norm;
}

// ------------------------------------------------------------------ what-if
async function runWhatif(c) {
  const v = parseFloat($("#altVal").value);
  const out = $("#whatifOut");
  out.innerHTML = `<div class="src">Computing…</div>`;
  try {
    const w = await post("/api/whatif", { nct: state.nct, criterion_id: c.id, value: v, as_of: state.asOf });
    out.innerHTML = `
      <table><thead><tr><th>Comparator</th><th>Threshold</th><th>Relative to ${esc(c.operator)}${esc(v)}</th><th>Coverage</th></tr></thead>
      <tbody>${w.comparators.map((x) => `<tr><td>${esc(x.acronym || x.nct_id)}</td><td>${esc(fmtNum(x.threshold))} ${esc(c.unit_norm)}</td><td>${esc(x.relation_to_alternative)}</td><td><span class="cov ${esc(x.coverage)}">${esc(x.coverage)}</span></td></tr>`).join("")}</tbody></table>
      <div style="margin-top:10px"><b>Automatic verification of “consider ${esc(c.operator)}${esc(v)} ${esc(c.unit_norm)}”</b> (citing only comparators that used exactly this value):</div>
      ${renderVerification(w.verification)}
      ${w.population ? popChart(w.population.current, w.population.alternative) : ""}`;
  } catch (e) { out.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

function popChart(cur, alt) {
  const groups = cur.groups.filter((g) => g.pct != null);
  const max = Math.max(1, ...groups.map((g) => g.ci95 ? g.ci95[1] : g.pct), ...(alt ? alt.groups.filter((g) => g.ci95).map((g) => g.ci95[1]) : [0]));
  const pct = (x) => `${(100 * x) / max}%`;
  const row = (g) => {
    const a = alt && alt.groups.find((x) => x.group === g.group);
    return `<div class="pop-row"><div>${esc(g.group)} <span class="src">n=${g.n}</span></div>
      <div class="bars"><div class="bar cur" style="width:${pct(g.pct)}"></div>${g.ci95 ? `<div class="ci" style="left:${pct(g.ci95[0])};width:calc(${pct(g.ci95[1])} - ${pct(g.ci95[0])})"></div>` : ""}
        ${a && a.pct != null ? `<div class="bar alt" style="width:${pct(a.pct)}"></div>${a.ci95 ? `<div class="ci alt" style="left:${pct(a.ci95[0])};width:calc(${pct(a.ci95[1])} - ${pct(a.ci95[0])})"></div>` : ""}` : ""}</div>
      <div style="font-family:var(--mono);font-size:12px">${g.pct}%${a && a.pct != null ? ` → ${a.pct}%` : ""}${g.unstable ? " *" : ""}</div></div>`;
  };
  return `<div style="margin-top:14px"><b>US general-population context (NHANES 2017–2018, adults, survey-weighted)</b>
    <div class="legend"><span><span class="sw" style="background:#c58a3e"></span>% below current ${esc(cur.threshold)} ${esc(cur.unit)}</span>${alt ? `<span><span class="sw" style="background:#5f86b3"></span>% below alternative ${esc(alt.threshold)} ${esc(alt.unit)}</span>` : ""}<span>whiskers: 95% CI · * relative SE &gt; 30%</span></div>
    ${groups.map(row).join("")}
    <div class="caveat">${esc(cur.caveat)}</div></div>`;
}

// ------------------------------------------------------------------ challenge form
function challengeForm(c) {
  const drugs = Object.keys(state.review.target.regimen.drugs);
  return `
    <div class="form-row">
      <label>Action</label>
      <select id="chAction">${["relax", "remove", "tighten", "retain", "add_provision", "justify_in_protocol"].map((a) => `<option>${a}</option>`).join("")}</select>
      <label>Proposed value</label><input type="number" step="any" id="chValue" style="width:90px" /><span class="src">${esc(c.unit_norm || "")}</span>
    </div>
    <div id="claims"></div>
    <div class="form-row">
      <button class="small ghost" data-add="drug_property">+ drug property</button>
      <button class="small ghost" data-add="comparator_threshold">+ comparator threshold</button>
      <button class="small ghost" data-add="fda_quote">+ FDA quote</button>
      <button class="small ghost" data-add="protocol_quote">+ protocol quote</button>
    </div>
    <textarea id="chText" placeholder="Rationale text (checked for overclaims)"></textarea>
    <div class="form-row" style="margin-top:8px">
      <button id="chVerify">Verify recommendation</button>
      <select id="chExample"><option value="">Load example input…</option>
        <option value="naive">Example: “PD-1 is not myelosuppressive → relax ANC to 1.0”</option>
        <option value="cautious">Example: cautious hemoglobin justification</option>
        <option value="fabricated">Example: misquoted comparator value</option></select>
      <span class="example-note">Examples are user inputs to demonstrate the checks; they are not system findings.</span>
    </div>
    <div class="form-row">
      <textarea id="chFree" placeholder="${state.status?.llm?.available ? "Or type a recommendation in plain English; the LLM converts it to claims, then the deterministic verifier checks them." : "Free-text parsing needs a model (CHALK_ROUTER_API_KEY for the Chalk Model Gateway, or ANTHROPIC_API_KEY). Use the structured form above."}" ${state.status?.llm?.available ? "" : "disabled"}></textarea>
      <button class="small ghost" id="chParse" ${state.status?.llm?.available ? "" : "disabled"}>Parse &amp; verify free text</button>
    </div>
    <datalist id="drugList">${drugs.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>`;
}

function addClaim(type, pre = {}) {
  const el = document.createElement("div");
  el.className = "claim"; el.dataset.type = type;
  const fields = {
    drug_property: `<input type="text" list="drugList" data-k="drug" placeholder="drug" value="${esc(pre.drug || "")}" style="width:130px"/>
      <select data-k="property">${["myelosuppressive", "hepatic", "renal", "immunotherapy"].map((p) => `<option ${pre.property === p ? "selected" : ""}>${p}</option>`).join("")}</select>
      <select data-k="value"><option value="false" ${pre.value === false ? "selected" : ""}>is NOT</option><option value="true" ${pre.value === true ? "selected" : ""}>IS</option></select>`,
    comparator_threshold: `<input type="text" data-k="nct_id" placeholder="NCT…" value="${esc(pre.nct_id || "")}" style="width:120px"/>
      <input type="number" step="any" data-k="value" placeholder="value" value="${esc(pre.value ?? "")}" style="width:80px"/>
      <input type="text" data-k="unit" placeholder="unit" value="${esc(pre.unit || "")}" style="width:80px"/>`,
    fda_quote: `<select data-k="guidance">${["lab", "ps", "washout"].map((g) => `<option ${pre.guidance === g ? "selected" : ""}>${g}</option>`).join("")}</select>
      <input type="text" data-k="quote" placeholder="exact quote" value="${esc(pre.quote || "")}" style="flex:1;min-width:300px"/>`,
    protocol_quote: `<input type="text" data-k="quote" placeholder="exact protocol text" value="${esc(pre.quote || "")}" style="flex:1;min-width:300px"/>`,
  }[type];
  el.innerHTML = `<span class="type">${type.replace("_", " ")}</span>${fields}<button class="small ghost" data-rm>×</button>`;
  el.querySelector("[data-rm]").addEventListener("click", () => el.remove());
  $("#claims").appendChild(el);
}

function readForm(c) {
  const claims = [...document.querySelectorAll("#claims .claim")].map((el) => {
    const o = { type: el.dataset.type };
    el.querySelectorAll("[data-k]").forEach((f) => {
      let v = f.value;
      if (f.dataset.k === "value") v = el.dataset.type === "drug_property" ? v === "true" : v === "" ? null : parseFloat(v);
      o[f.dataset.k] = v;
    });
    return o;
  });
  const pv = $("#chValue").value;
  return { criterion_id: c.id, action: $("#chAction").value, proposed_value: pv === "" ? null : parseFloat(pv), proposed_unit: c.unit_norm, claims, text: $("#chText").value };
}

const EXAMPLES = {
  naive: (c) => ({ criterion: "anc", action: "relax", value: 1.0, text: "Cemiplimab is a PD-1 inhibitor and is not myelosuppressive, so the ANC floor can be lowered.",
    claims: [["drug_property", { drug: "cemiplimab", property: "myelosuppressive", value: false }],
             ["fda_quote", { guidance: "lab", quote: "Laboratory value-based eligibility criteria should be customized to the drug(s) under investigation." }]] }),
  cautious: () => ({ criterion: "hemoglobin", action: "justify_in_protocol", value: null, text: "Comparable PD-1 + chemotherapy trials used 9.0 g/dL; document why 10.0 g/dL is required.",
    claims: [["comparator_threshold", { nct_id: "NCT03215706", value: 9.0, unit: "g/dL" }],
             ["fda_quote", { guidance: "lab", quote: "Laboratory-based eligibility criteria should be only as restrictive as necessary to mitigate the clinical risk(s) of concern." }]] }),
  fabricated: () => ({ criterion: "hemoglobin", action: "relax", value: 8.0, text: "CheckMate 9LA allowed hemoglobin of 8.0 g/dL, so 8.0 g/dL is safe.",
    claims: [["comparator_threshold", { nct_id: "NCT03215706", value: 8.0, unit: "g/dL" }]] }),
};

function loadExample(key) {
  const ex = EXAMPLES[key]?.();
  if (!ex) return;
  if (!state.review.reviews.find((r) => r.criterion.id === ex.criterion)) return alert(`This trial has no ${ex.criterion} criterion.`);
  if (state.selected !== ex.criterion) select(ex.criterion);
  $("#chAction").value = ex.action;
  $("#chValue").value = ex.value ?? "";
  $("#chText").value = ex.text;
  $("#claims").innerHTML = "";
  ex.claims.forEach(([t, p]) => addClaim(t, p));
  $("#chExample").value = key;
}

function renderVerification(v) {
  const outcome = v.outcome || v.status.replaceAll("_", " ");
  const ocls = outcome === "Rejected" ? "REJECTED" : outcome === "Supported" ? "PASSED" : "PASSED_WITH_WARNINGS";
  return `<div style="margin:8px 0"><span class="vstatus ${ocls}">${esc(outcome)}</span>
      ${outcome === "Needs medical review" ? `<span class="src"> Factual checks passed, but changing a threshold is a clinical judgment, so it is escalated to a medical reviewer.</span>` : ""}</div>
    ${v.checks.map((k) => `<div class="check"><span class="r ${esc(k.result)}">${esc(k.result.toUpperCase())}</span><span class="c">${esc(k.check)}<br><span class="cat ${esc(k.category || "")}">${esc(k.category || "")}</span></span><span>${esc(k.detail)}</span></div>`).join("")}
    <div class="src" style="margin-top:6px">factual = claim checked against a source document · clinical-logic = hand-written reasoning rule. Neither is clinical validation.</div>`;
}

// ------------------------------------------------------------------ review packet
async function loadPacket() {
  const el = $("#packet");
  if (!state.nct) { el.innerHTML = `<div class="card">Review a protocol first.</div>`; return; }
  el.innerHTML = `<div class="loading">Building review packet…</div>`;
  try {
    const p = await api(`/api/packet/${encodeURIComponent(state.nct)}?as_of=${state.asOf}`);
    const opts = [["needs_medical_review", "Needs medical review"], ["accept", "Accept suggested action"], ["reject", "Reject (keep as written)"], ["defer", "Defer / need more evidence"]];
    el.innerHTML = `<div class="card">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
          <div><h2 style="margin:0">${esc(p.title)}</h2><div class="src">${esc(p.trial.acronym || "")} ${esc(p.trial.title)} · comparator cutoff ${esc(p.comparator_cutoff || "none")} · generated ${esc(p.generated_at)}</div></div>
          <div class="form-row" style="margin:0">
            <a class="btn-link" href="/api/packet/${esc(p.trial.nct_id)}?format=md&as_of=${state.asOf}">Export Markdown</a>
            <a class="btn-link" href="/api/packet/${esc(p.trial.nct_id)}?format=html&as_of=${state.asOf}" target="_blank" rel="noopener">Printable / PDF</a>
            <a class="btn-link" href="/api/packet/${esc(p.trial.nct_id)}?as_of=${state.asOf}" target="_blank" rel="noopener">JSON</a>
          </div></div>
        <div class="form-row" style="margin-top:10px"><label>Reviewer</label><input type="text" id="reviewerName" placeholder="name / role" style="width:200px" value="${esc(localStorage.getItem("tl_reviewer") || "")}"/>
          <span class="src">Decisions are saved with the packet. "Needs medical review" is always available; nothing forces approve/reject.</span></div>
      </div>
      ${p.items.map((it) => `<div class="card packet-item">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><b>${esc(it.requirement.label)} ${esc(it.requirement.threshold)}</b> <span class="src">${esc(it.requirement.section)} · ${esc(it.requirement.source)}</span></div>
          <div><span class="cls ${clsKey(it.classification)}">${esc(it.classification)}</span> <span class="chip">priority: ${esc(it.priority)}</span></div></div>
        <div class="verbatim" style="margin:6px 0">${esc(it.requirement.verbatim)}</div>
        <div class="src">Likely purpose (inferred): ${it.likely_purpose.filter((x) => x.status !== "not indicated").map((x) => esc(x.purpose)).join(" · ") || "unknown"}</div>
        <div class="packet-grid four">
          <div><h4>Supports retaining</h4>${list(it, "supports")}</div>
          <div><h4>Challenges the restriction</h4>${list(it, "challenges")}</div>
          <div><h4>Context (same-threshold precedent, protocol discussion)</h4>${list(it, "context")}</div>
          <div><h4>Unresolved questions</h4><ul>${it.unresolved_questions.map((q) => `<li>${esc(q)}</li>`).join("") || "<li>none recorded</li>"}</ul></div>
        </div>
        ${it.regulatory_guidance.length ? `<details class="src" style="margin-top:6px"><summary>Applicable FDA guidance (${it.regulatory_guidance.length} verified passages)</summary><ul>${it.regulatory_guidance.map((g) => `<li>[${esc(g.stance)}] “${esc(g.quote)}” <a class="src-link" href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.citation)}</a></li>`).join("")}</ul></details>` : ""}
        <div class="action"><b>Next action (${esc(it.next_action.action.replaceAll("_", " "))}):</b> ${esc(it.next_action.text)}</div>
        <div class="form-row" style="margin-top:8px">
          <select data-dec="${esc(it.criterion_id)}">${opts.map(([v, l]) => `<option value="${v}" ${it.decision?.decision === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <input type="text" data-reason="${esc(it.criterion_id)}" placeholder="reason / note for the protocol team" value="${esc(it.decision?.reason || "")}" style="flex:1;min-width:260px"/>
          <button class="small" data-save="${esc(it.criterion_id)}">Save decision</button>
          <span class="src" data-saved="${esc(it.criterion_id)}">${it.decision ? `saved: ${esc(it.decision.label)} (${esc(it.decision.reviewer)}, ${esc(it.decision.recorded_at)})` : "no decision yet"}</span>
        </div></div>`).join("")}
      <div class="card src">${p.notes.map((n) => esc(n)).join("<br>")}</div>`;
    el.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.save;
      const reviewer = $("#reviewerName").value;
      try { localStorage.setItem("tl_reviewer", reviewer); } catch (_) {}
      try {
        const d = await post("/api/decision", { nct: state.nct, criterion_id: id, decision: el.querySelector(`[data-dec="${id}"]`).value, reason: el.querySelector(`[data-reason="${id}"]`).value, reviewer });
        el.querySelector(`[data-saved="${id}"]`).textContent = `saved: ${d[id].label} (${d[id].reviewer}, ${d[id].recorded_at})`;
      } catch (e) { el.querySelector(`[data-saved="${id}"]`).textContent = e.message; }
    }));
  } catch (e) { el.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

function list(it, stance) {
  const rows = [];
  for (const [tier, evs] of Object.entries(it.evidence_by_tier)) {
    evs.filter((e) => e.stance === stance).forEach((e) => rows.push(`<li><span class="tier">${esc(tier)}</span> ${esc(e.summary)}${tier === "Direct protocol evidence" && e.quote ? ` <q>${esc(e.quote.slice(0, 220))}${e.quote.length > 220 ? "…" : ""}</q>` : ""}${e.source ? ` <span class="src">(${esc(e.source)})</span>` : ""}</li>`));
  }
  // only criterion-specific FDA recommendations are listed inline; general principles sit in the collapsible list
  it.regulatory_guidance.filter((g) => g.stance === stance && g.specific).forEach((g) => rows.push(`<li><span class="tier">Regulatory guidance (criterion-specific)</span> “${esc(g.quote)}” <a class="src-link" href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.citation)}</a></li>`));
  return `<ul>${rows.join("") || "<li class='src'>none</li>"}</ul>`;
}

async function verifyForm(c) {
  const rec = readForm(c);
  const out = $("#verifyOut");
  out.innerHTML = `<div class="src">Verifying against source documents…</div>`;
  try {
    const res = await post("/api/verify", { nct: state.nct, recommendation: rec, as_of: state.asOf, with_llm_baseline: !!state.status?.llm?.available });
    out.innerHTML = `<div style="margin-top:10px"><b>Deterministic verifier</b></div>${renderVerification(res.deterministic)}
      ${res.llm_only ? `<div style="margin-top:10px"><b>LLM-only verifier (baseline, for comparison)</b>: ${esc(res.llm_only.status || res.llm_only.error)}<ul>${(res.llm_only.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}`;
  } catch (e) { out.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

async function parseFree() {
  const out = $("#verifyOut");
  out.innerHTML = `<div class="src">Parsing with the LLM, then verifying deterministically…</div>`;
  try {
    const res = await post("/api/parse", { nct: state.nct, text: $("#chFree").value, as_of: state.asOf });
    out.innerHTML = `<div class="src">Parsed structure (LLM):</div><div class="verbatim">${esc(JSON.stringify(res.recommendation, null, 2))}</div>${renderVerification(res.verification)}`;
  } catch (e) { out.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

async function runCritic(c) {
  const el = $("#critic");
  el.innerHTML = `<div class="src">LLM critic reviewing this flag…</div>`;
  try {
    const r = await post("/api/critique", { nct: state.nct, criterion_id: c.id, as_of: state.asOf });
    el.innerHTML = `<div class="ev"><div class="k">LLM critic (${esc(state.status.llm.model)}) · can only downgrade</div>
      <b>${esc(r.verdict)}</b> — ${esc(r.summary)}<div class="src">${esc(r.safety_rationale_vs_threshold)}</div>
      <ul>${r.issues.map((i) => `<li><b>${esc(i.type)}</b>: ${esc(i.detail)}</li>`).join("")}</ul></div>`;
  } catch (e) { el.innerHTML = `<div class="src">${esc(e.message)}</div>`; }
}

function bindDetail(c) {
  $("#runWhatif")?.addEventListener("click", () => runWhatif(c));
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addClaim(b.dataset.add)));
  $("#chVerify").addEventListener("click", () => verifyForm(c));
  $("#chExample").addEventListener("change", (e) => loadExample(e.target.value));
  $("#chParse")?.addEventListener("click", parseFree);
  if (state.status?.llm?.available) {
    $("#critic").innerHTML = `<button class="small ghost" id="critBtn">Ask LLM critic to challenge this flag</button>`;
    $("#critBtn").addEventListener("click", () => runCritic(c));
  } else {
    $("#critic").innerHTML = `<span class="src">LLM critic not configured — classifications shown are fully deterministic.</span>`;
  }
}

// ------------------------------------------------------------------ source viewer
document.addEventListener("click", async (e) => {
  const a = e.target.closest("a.src-link[data-page]");
  if (!a) return;
  e.preventDefault();
  const { nct, page, quote } = a.dataset;
  $("#modalContent").innerHTML = `<div class="src">Loading ${esc(nct)} page ${esc(page)}…</div>`;
  $("#modal").classList.remove("hidden");
  try {
    const p = await api(`/api/protocol/${nct}/page/${page}`);
    let text = esc(p.text);
    const q = (quote || "").trim();
    if (q) {
      const needle = esc(q.slice(0, 60));
      text = text.replace(needle, `<mark>${needle}</mark>`);
    }
    $("#modalContent").innerHTML = `<h3>${esc(nct)} — protocol PDF page ${esc(page)}</h3>
      <div class="src">Extracted text of the official document. <a class="src-link" href="${esc(p.url)}" target="_blank" rel="noopener">Open the PDF at this page</a></div>
      <div class="page-text" style="margin-top:8px">${text}</div>`;
  } catch (err) { $("#modalContent").innerHTML = `<div class="error">${esc(err.message)}</div>`; }
});
$(".modal-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });

// ------------------------------------------------------------------ evals tab
async function loadEvals() {
  const r = await api("/api/evals");
  if (!r.available && !r.suites) { $("#evals").innerHTML = `<div class="card">No evaluation results yet. Run <code>.venv/bin/python -m evals.run_evals</code>.</div>`; return; }
  const s = r.suites;
  const m = (v, d) => `<div class="metric"><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const pct = (x) => (x == null ? "n/a" : `${(100 * x).toFixed(1)}%`);
  let html = `<div class="card"><h3>Run</h3><div class="meta"><span><b>Generated</b> ${esc(r.generated_at)}</span><span><b>Runner</b> ${esc(r.runner)}</span><span><b>Chalk Evaluations</b> ${esc(r.chalk?.status || "not run")}</span></div>
    <p class="src">Every number below is computed by <code>evals/run_evals.py</code> from the cached source documents and hand-verified gold labels in <code>evals/gold/</code>. Injected-error cases are synthetic test inputs, labelled as such; they are not findings about any trial.</p></div>`;
  if (s.extraction) {
    const e = s.extraction;
    html += `<div class="card"><h3>A · Original protocols — criterion extraction vs hand-verified gold labels</h3><div class="metric-grid">
      ${m(pct(e.field_accuracy), `field-level exact match (${e.correct}/${e.total} fields)`)}
      ${m(pct(e.value_recall), `criteria found with correct value (${e.found_correct}/${e.gold_criteria})`)}
      ${m(pct(e.precision), `extracted values that are correct (${e.found_correct}/${e.extracted})`)}
      ${m(e.protocols, "protocols (NSCLC, SCLC, TNBC, gastric, HCC, head & neck, renal)")}</div>
      <table><thead><tr><th>Split</th><th>Criteria correct (current)</th><th>First run (before fixes)</th><th>Meaning</th></tr></thead><tbody>
      ${Object.entries(e.by_split).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.found}/${v.gold}</td><td>${esc(r.first_run?.extraction_by_split?.[k] || "—")}</td><td class="src">${esc({ dev: "protocols used while developing the extractor", heldout: "outputs seen once, no code changed in response", unseen: "labelled before the extractor ever ran on them; first-run number is the honest generalization estimate", unseen2: "six further protocols labelled before first extraction run; measured once, not tuned" }[k] || "")}</td></tr>`).join("")}
      </tbody></table>
      ${r.first_run ? `<div class="src" style="margin:6px 0 10px">Fixes made after the first run: ${esc(r.first_run.fixes_after.join("; "))}. Current unseen-split numbers are therefore no longer unseen.</div>` : ""}
      <table><thead><tr><th>Trial</th><th>Criterion</th><th>Gold</th><th>Extracted</th><th>Result</th></tr></thead><tbody>
      ${e.rows.filter((x) => !x.ok).map((x) => `<tr><td>${esc(x.nct)}</td><td>${esc(x.id)}</td><td>${esc(x.gold)}</td><td>${esc(x.got)}</td><td class="bad">${esc(x.why)}</td></tr>`).join("") || `<tr><td colspan=5 class="ok">no errors</td></tr>`}
      </tbody></table>
      <div class="src">Regimen extraction: precision ${pct(s.regimen?.precision)}, recall ${pct(s.regimen?.recall)} over ${s.regimen?.protocols} protocols (reference regimens curated by the developer from registry arms and protocol treatment sections; not independently adjudicated). Gold labels: single annotator.</div></div>`;
  }
  if (s.comparison) {
    html += `<div class="card"><h3>A · Original protocols — comparable-trial threshold differences</h3><div class="metric-grid">
      ${m(pct(s.comparison.accuracy_when_compared), `direction correct when both values extracted (${s.comparison.correct}/${s.comparison.compared})`)}
      ${m(s.comparison.missing_extraction, "pairs not comparable (a value was not extracted)")}
      ${m(s.comparison.wrong_direction, "wrong direction calls")}</div>
      <div class="src">Pipeline direction (stricter / looser / same) vs direction computed from gold values for every target×comparator×criterion pair where both gold values exist.</div></div>`;
  }
  if (s.citations) {
    html += `<div class="card"><h3>A · Original protocols — citation existence and quote accuracy</h3><div class="metric-grid">
      ${m(pct(s.citations.fda_quote_accuracy), `FDA quotes found verbatim (${s.citations.fda_ok}/${s.citations.fda_total})`)}
      ${m(pct(s.citations.protocol_quote_accuracy), `protocol source lines found on cited page (${s.citations.prot_ok}/${s.citations.prot_total})`)}
      ${m(pct(s.citations.nct_exist), `cited NCT IDs exist (${s.citations.nct_ok}/${s.citations.nct_total})`)}</div></div>`;
  }
  let vhtml = "";
  if (s.verifier) {
    const v = s.verifier;
    const row = (name, x) => `<tr><td>${esc(name)}</td><td>${pct(x?.fault_catch_rate)}</td><td>${pct(x?.false_rejection_rate)}</td><td>${pct(x?.ambiguous_agreement)}</td><td>${esc(x?.note || "")}</td></tr>`;
    vhtml = `<div class="card"><h3>C · Developer-designed verifier faults — injected-error detection and false rejections</h3>
      <table><thead><tr><th>Verifier</th><th>Injected faults rejected</th><th>Valid/cautious recs rejected</th><th>Ambiguous cases flagged (warn or reject)</th><th>Notes</th></tr></thead>
      <tbody>${row("No verifier (baseline)", v.no_verifier)}${row("Deterministic verifier (TrialLens), local", v.deterministic)}
      ${r.chalk && r.chalk.n_fault ? `<tr><td>Deterministic verifier, executed on <b>Chalk Compute</b> (Chalk Evaluations)</td><td>${pct(r.chalk.fault_rejected / r.chalk.n_fault)}</td><td>${pct(r.chalk.valid_rejected / r.chalk.n_valid)}</td><td>${pct(r.chalk.ambiguous_flagged / r.chalk.n_ambiguous)}</td><td>evaluation ${esc(r.chalk.evaluation_id)} · run ${esc(r.chalk.run_id)} · ${esc(r.chalk.status)} · ${esc(r.chalk.task_errors)} task errors · Chalk scorer verdict_correct mean ${esc(r.chalk.verdict_correct_mean)} (n=${esc(r.chalk.verdict_correct_n)})</td></tr>` : ""}
      ${row("LLM-only verifier", v.llm_only)}</tbody></table>
      <div class="src">${v.n_faults} injected faults, ${v.n_valid} valid or clinically cautious recommendations, ${v.n_ambiguous} ambiguous cases (expected: warnings, not a pass).
      Caveat: the cases and the verifier were written by the same developer, so this measures the designed failure modes, not robustness to unanticipated errors. A 100% score here is expected for rule-based checks and should not be read as general accuracy.</div>
      <table style="margin-top:10px"><thead><tr><th>Case</th><th>Kind</th><th>Expected</th><th>Deterministic</th><th>LLM-only</th></tr></thead><tbody>
      ${v.cases.map((c) => `<tr><td>${esc(c.id)}<div class="src">${esc(c.description)}</div></td><td>${c.kind === "fault" ? `<span class="badge-injected">INJECTED: ${esc(c.fault_type)}</span>` : `<span class="badge-valid">${esc(c.kind)}</span>`}</td><td>${esc(c.expected)}</td><td class="${c.det_ok ? "ok" : "bad"}">${esc(c.det_status)}</td><td>${esc(c.llm_status || "not run")}</td></tr>`).join("")}
      </tbody></table></div>`;
  }
  if (s.classification) {
    html += `<div class="card"><h3>A · Original protocols — review classification vs hand-written expectations (not blind)</h3><div class="metric-grid">${m(pct(s.classification.accuracy), `agreement (${s.classification.correct}/${s.classification.total})`)}</div>
      <table><thead><tr><th>Trial</th><th>Criterion</th><th>Expected (hand-written, evals/gold — not blind)</th><th>Got</th></tr></thead><tbody>
      ${s.classification.rows.map((x) => `<tr><td>${esc(x.nct)}</td><td>${esc(x.id)}</td><td>${esc(x.expected)}</td><td class="${x.ok ? "ok" : "bad"}">${esc(x.got)}</td></tr>`).join("")}</tbody></table>
      <div class="src">${esc(s.classification.note || "")}</div></div>`;
  }
  html += await plantedHtml(m, pct);
  html += vhtml;
  html += `<div class="card"><h3>D · Model-based evaluations</h3>
    <p>${state.status?.llm?.available ? `Model available: ${esc(state.status.llm.model)}. Run <code>python -m evals.run_evals --llm</code> to add the LLM-only verifier baseline.` : "Not run: no model credentials configured yet (Chalk Model Gateway router key or Anthropic key). Every result on this page is deterministic."}</p>
    <div class="src">When run, the LLM-only verifier receives the same recommendation and context as the deterministic verifier and must answer PASSED or REJECTED.</div></div>`;
  // keep the planted section after the original-protocol cards and before verifier faults
  $("#evals").innerHTML = html;
}

async function plantedHtml(m, pct) {
  let p;
  try { p = await api("/api/planted"); } catch (_) { return ""; }
  if (!p.summary) return "";
  const block = (sum, label) => {
    if (!sum) return "";
    const f = (x) => (Array.isArray(x) ? `${x[0]}/${x[1]}` : x);
    const st = sum.stricter;
    return `<tr><td>${esc(label)}</td><td>${f(st.extracted)}</td><td>${f(st.discrepancy_surfaced)}</td><td>${f(st.escalated_strict)}</td><td>${f(st.escalated_lenient)}</td><td>${f(st.differential_detection_where_control_not_flagged)}</td><td>${f(sum.looser.false_over_restriction_flags)}</td></tr>`;
  };
  return `<div class="card"><h3>B · Planted-issue variants (synthetic modifications to authentic, previously unseen protocols)</h3>
    <p class="src">Following Regeneron's "Trial by Design, Part 2" guidance: one threshold per variant was made stricter (or looser) on the protocol's own source line, with the unmodified protocol kept as control. A stricter criterion is not assumed to be wrong; the system is scored on whether it notices and escalates the change for evidence review. Answer key: <code>evals/planted/answer_key.json</code>.</p>
    <table><thead><tr><th>Run</th><th>Planted value extracted</th><th>Discrepancy surfaced (more permissive comparator shown)</th><th>Escalated: Review recommended</th><th>Not "supports retaining" (lenient)</th><th>Differential (control not flagged)</th><th>Looser plants falsely flagged</th></tr></thead><tbody>
      ${block(p.first_run_summary, "First run (before fixes)")}
      ${block(p.summary, "Current, historical cutoff (comparators started before each protocol)")}
      ${block(p.no_cutoff_summary, "Current, no cutoff (draft-review-today)")}
    </tbody></table>
    <div class="src" style="margin-top:6px">Fixes after the first run: (1) arms containing agents outside the curated drug table no longer count as "no myelosuppressive agent" (KEYNOTE-426: axitinib, sunitinib); (2) SCLC targets no longer receive NSCLC comparators; (3) an evaluation-harness bug that left "1,500/µL" unmodified was fixed. Misses concentrate in protocols with no comparable precedent before their start date, where the system returns "Insufficient evidence" rather than retaining. Controls flagged on unmodified protocols: ${esc(p.summary.controls.review_recommended)}/${esc(p.summary.controls.criteria)} (mostly criterion-specific FDA recommendations: ECOG PS2, Duffy-null ANC).</div></div>`;
}

// ------------------------------------------------------------------ wiring
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
  if (t.dataset.tab === "evals") loadEvals();
  if (t.dataset.tab === "packet") loadPacket();
}));
$("#loadForm").addEventListener("submit", (e) => { e.preventDefault(); loadReview($("#nct").value.trim().toUpperCase(), $("#asOf").value); });

(async () => {
  try { await loadStatus(); } catch (_) {}
  const params = new URLSearchParams(location.search);
  const nct = params.get("nct") || $("#nct").value;
  $("#nct").value = nct;
  loadReview(nct, "auto");
  const hash = location.hash.replace("#", "");
  // demo/screenshot convenience: #challenge=<example> loads an example input and verifies it
  if (hash.startsWith("challenge=")) {
    const key = hash.split("=")[1];
    const wait = setInterval(() => { if (state.review) { clearInterval(wait); loadExample(key); setTimeout(() => $("#chVerify")?.click(), 50);  } }, 200);
  } else if (hash) document.querySelector(`.tab[data-tab="${hash}"]`)?.click();
})();
