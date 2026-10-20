import { AppHeader } from "./components/AppHeader";
import { ArrowRightIcon, DocCheckIcon, EyeOffIcon, PenIcon, PlayIcon } from "./components/Icons";
import { Onboarding } from "./components/Onboarding";

// Landing: two entry modes. Links are relative so they work at "/" and under a mount such as "/app/".
const MODES = [
  {
    testid: "mode-review",
    href: "./review",
    Icon: DocCheckIcon,
    kicker: "Finishing a trial",
    title: "Review an existing protocol",
    text: "Open a posted oncology protocol. Each lab, ECOG, washout and condition criterion gets its likely rationale (inferred unless the protocol states it), the arm whose drugs are linked to it where a drug link exists, the values similar trials used, and the deterministic verifier's verdict on any other limit you propose.",
    cta: "Open the review",
  },
  {
    testid: "mode-draft",
    href: "./draft",
    Icon: PenIcon,
    kicker: "Create criteria from an idea",
    title: "Draft criteria for a new concept",
    text: "Describe the condition, drugs and setting. ProtocolOS proposes values only from verified precedents, then critiques its own draft; otherwise it says Insufficient evidence.",
    cta: "Start a draft",
  },
];

export default function Landing() {
  return (
    <>
      <AppHeader mode="home" />
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink">
            The rationale behind every eligibility criterion, before the protocol is final.
          </h1>
          <p className="max-w-3xl text-base text-muted">
            For protocol authors and review teams in oncology. ProtocolOS prepares the rationale; the team decides.
          </p>
        </div>

        <Onboarding />

        <div className="grid gap-4 md:grid-cols-2">
          {MODES.map(({ testid, href, Icon, kicker, title, text, cta }) => (
            <a
              key={testid}
              data-testid={testid}
              href={href}
              className="group flex flex-col gap-3 rounded-lg border border-line bg-white/70 p-5 transition-colors duration-150 hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-muted">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-ink text-lg text-paper">
                  <Icon />
                </span>
                {kicker}
              </span>
              <span className="text-xl font-semibold text-ink">{title}</span>
              <span className="text-sm leading-relaxed text-muted">{text}</span>
              <span className="mt-auto flex items-center gap-1.5 text-sm font-medium text-ink">
                {cta}
                <ArrowRightIcon className="transition-transform duration-150 group-hover:translate-x-0.5" />
              </span>
            </a>
          ))}
        </div>
        <p data-testid="key-policy" className="-mt-2 max-w-3xl text-sm text-muted">
          Four worked examples and the draft examples open at once. Adding another trial, drafting a new idea and model answers
          in the Ask tab use your own OpenAI or Anthropic API key; this server has no model key of its own.
        </p>

        <div className="flex flex-col gap-3 border-t border-line pt-4 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2">
            <EyeOffIcon className="mt-0.5 shrink-0" />
            Public sources only. Rationale in non-public sources (preclinical toxicology, internal development data, regulator correspondence) cannot be seen by ProtocolOS.
          </p>
          <a href="./tour" className="flex shrink-0 items-center gap-1.5 font-medium text-ink hover:underline">
            <PlayIcon /> Take the 7-step guided tour
          </a>
        </div>
      </main>
    </>
  );
}
