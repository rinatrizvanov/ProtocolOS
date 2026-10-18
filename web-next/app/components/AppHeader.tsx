import Image from "next/image";
import mark from "../../public/protocolos-mark.png";
import { DocCheckIcon, PenIcon, PlayIcon } from "./Icons";

// Shared top bar. Links are relative so they also resolve under a basePath or the /app export mount.
// Phones get one row of short labels with 44px targets; the full mode names return from the sm breakpoint.
const ITEMS = [
  { mode: "review", testid: "nav-review", href: "review", label: "Finishing a trial", short: "Review", Icon: DocCheckIcon },
  { mode: "draft", testid: "nav-draft", href: "draft", label: "Create criteria from an idea", short: "Draft", Icon: PenIcon },
  { mode: "tour", testid: "nav-tour", href: "tour", label: "Guided tour", short: "Tour", Icon: PlayIcon },
] as const;

export function AppHeader({ mode }: { mode: "home" | "review" | "draft" | "tour" }) {
  // Every route is one level deep, so "./" from the landing and "../" elsewhere both reach the root.
  const root = mode === "home" ? "./" : "../";
  return (
    <header data-mode={mode} className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-x-3 px-4 py-1 sm:flex-wrap sm:justify-start sm:gap-x-5 sm:gap-y-2 sm:px-6 sm:py-1.5">
        <a
          href={root}
          className="flex min-h-11 shrink-0 items-center gap-2 text-base font-semibold tracking-tight text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          <Image src={mark} alt="" width={24} height={24} priority className="h-6 w-6 rounded" />
          <span>
            Protocol<span className="text-[#0066fa]">OS</span>
          </span>
        </a>
        <nav aria-label="Modes" className="flex items-center gap-0.5 text-sm sm:flex-wrap sm:gap-1">
          {ITEMS.map(({ mode: m, testid, href, label, short, Icon }) => (
            <a
              key={m}
              data-testid={testid}
              href={`${root}${href}`}
              aria-current={m === mode ? "page" : undefined}
              className={`flex min-h-11 items-center gap-1.5 rounded-md px-2.5 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:min-h-9 ${
                m === mode ? "bg-line text-ink" : "text-muted hover:bg-line/60 hover:text-ink"
              }`}
            >
              <Icon className="hidden text-base sm:block" />
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{label}</span>
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
