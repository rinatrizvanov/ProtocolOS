import { DocCheckIcon, PenIcon, PlayIcon } from "./Icons";

// Shared top bar. Links are relative so they also resolve under a basePath or the /app export mount.
const ITEMS = [
  { mode: "review", testid: "nav-review", href: "review", label: "Finishing a trial", Icon: DocCheckIcon },
  { mode: "draft", testid: "nav-draft", href: "draft", label: "Create criteria from an idea", Icon: PenIcon },
  { mode: "tour", testid: "nav-tour", href: "tour", label: "Guided tour", Icon: PlayIcon },
] as const;

export function AppHeader({ mode }: { mode: "home" | "review" | "draft" | "tour" }) {
  // Every route is one level deep, so "./" from the landing and "../" elsewhere both reach the root.
  const root = mode === "home" ? "./" : "../";
  return (
    <header data-mode={mode} className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6">
        <a href={root} className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded bg-ink text-xs font-bold text-paper">P</span>
          ProtocolOS
        </a>
        <nav aria-label="Modes" className="flex flex-wrap items-center gap-1 text-sm">
          {ITEMS.map(({ mode: m, testid, href, label, Icon }) => (
            <a
              key={m}
              data-testid={testid}
              href={`${root}${href}`}
              aria-current={m === mode ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
                m === mode ? "bg-line text-ink" : "text-muted hover:bg-line/60 hover:text-ink"
              }`}
            >
              <Icon className="text-base" />
              {label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
