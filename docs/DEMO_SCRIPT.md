# ProtocolOS: 3-minute live demo script

One presenter narrates while another drives the app. Step-by-step clicks and the checks behind them are in [DEMO_GUIDE.md](DEMO_GUIDE.md).

**Setup (before judges arrive):**
- Open tabs: https://protocolos-web.vercel.app (pick "Finishing a trial"); `/review?nct=NCT03409614&c=hemoglobin`; `/draft?preset=el3-design-time`; https://protocolos-api-production.up.railway.app/docs; the exported packet.
- Backup: the same code locally (`PROTOCOLOS_PUBLIC=1 .venv/bin/uvicorn trialforge.api:app --port 8765`, then `cd web-next && npm run dev -- -p 3765`, open http://localhost:3765), the guided demos `/tour` and `/tour/draft`, the video file, the deck PDF and the packet `.md`.
- Before the talk, open the design-time draft once and note which criterion the self-critique flags. Say what the screen shows; do not script it in advance.
- If the network fails, switch to localhost and say it is the same code on cached public documents.

| Time | Screen | What to say |
|---|---|---|
| 0:00–0:20 | Title, then the FDA passage | "Eligibility criteria are often carried forward from earlier trials without a written rationale. FDA's final guidance from July 2026 says lab restrictions from earlier trials 'should not be carried forward automatically'. ProtocolOS gives every criterion a rationale a protocol team can check. Every exclusion deserves a rationale." |
| 0:20–0:40 | **Finishing a trial** → NCT03409614 (EMPOWER-Lung 3, Regeneron) → **Hemoglobin ≥10 g/dL** → Rationale tab | "This is a real Regeneron phase 3. ProtocolOS read the thresholds from the posted protocol PDF, because the registry doesn't state them. The Rationale tab shows a Safety badge, and the arm line says why: every arm includes chemotherapy, and the protocol, on page 51, notes more grade 3–4 anemia with pemetrexed. That supports having a threshold, not this exact number." |
| 0:40–0:55 | **Compare** | "Among comparable trials that started earlier, three used 9 g/dL and eNERGY used more than 10. A looser peer shows a value was used, not that it was safe, so this is a review question for the team, not a mistake." |
| 0:55–1:10 | **Redraft workspace** → type 9.0 g/dL and a one-line rationale | "Suppose the team considers 9.0. This is my typed input, not a system finding. The deterministic checks re-run as I type and show which precedents and FDA passages support or contradict it; the verifier, not a model, has the last word. In the guided tour, the Verify step shows a plausible-but-wrong argument being rejected: the PD-1 drug is not myelosuppressive, but the other arms contain chemotherapy." |
| 1:10–1:20 | **Decide** → "Safety concern" → export the packet | "The team decides, with a structured reason, here Safety concern. The review packet records the criterion, its rationale, the evidence on both sides and the decision." |
| 1:20–1:40 | **Create criteria from an idea** → preset "EMPOWER-Lung 3 at design time" | "Now the other mode: a new trial idea. This preset is EMPOWER-Lung 3's own idea at its start date. Only trials that started earlier count, and its own protocol is left out." |
| 1:40–2:00 | A drafted criterion card | "Each criterion is drafted only from a verified precedent, with its checks and 'Why this value'. No verified precedent means Insufficient evidence and no value, never a guess." |
| 2:00–2:10 | The criterion the self-critique flags | Read what the screen shows: which criterion is flagged and the reason given. |
| 2:10–2:20 | **Before / after** | "Side by side with EMPOWER-Lung 3 as written. Each difference is a question for the team, not a correction." |
| 2:20–2:50 | `/docs`, the README evaluation section | "It is deployed: the web app on Vercel, the API on Railway, with its OpenAPI page. It is MIT-licensed with an install guide, tests and evals. We planted stricter thresholds into real, previously unseen protocols, and none was classified as 'Rationale supports keeping'. The verifier also ran on Chalk Evaluations: 24 of 24 designed faults rejected, 0 of 10 valid recommendations rejected. Guardrails: a model may only downgrade a flag, and no claims of safety, enrollment gains or clinical validation. Our blind spot: rationale in non-public sources, such as preclinical toxicology or internal data, cannot be seen." |
| 2:50–3:00 | Close | "ProtocolOS doesn't decide. It makes every exclusion come with a rationale the team can check." |

**If something fails live:** use the guided demos `/tour` (mode A) and `/tour/draft` (mode B), or the localhost copy. Use `?nct=NCT02578680` (KEYNOTE-189) as a backup trial.

**Likely judge questions**
- *So Regeneron's threshold was wrong?* No. EMPOWER-Lung 3 used chemotherapy combinations with known anemia risk, and its protocol discusses that. The ≥10 vs ≥9 difference is real and verifiable, but it is a question for the clinical team, not a mistake. Nothing we have shows which threshold is optimal, whether it changed across amendments, or that EMPOWER-Lung 1 influenced it.
- *Isn't this just search?* The value is the comparison logic (regimen coverage, permissive comparator is not proof of safety, toxicity supports a threshold but not its value) plus a verifier that rejects plausible-but-wrong reasoning, and drafting that refuses to propose a value without a verified precedent.
- *How does it differ from Regeneron/Keiji's ISPOR 2026 work?* Their published system drafts criteria from precedent. ProtocolOS reviews and challenges individual restrictions, and its drafting mode is gated by the same verifier. They are complementary, and we don't claim their system lacks anything beyond what their abstract describes.
- *What does the AI do?* The evidence engine is deterministic. An optional model mode (via the Chalk Model Gateway) may only downgrade a flag, and every statement passes the deterministic checks. The public deploy runs without model calls.
- *Does it learn from our decisions?* No. Decisions and structured reasons are recorded in the packet as an audit trail; nothing is retrained on them.
- *Would you use this on internal protocols?* That is the next step: internal precedent (past amendments, lessons learned) inside the sponsor's own environment.
