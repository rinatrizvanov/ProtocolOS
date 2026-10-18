import type { ReactNode, SVGProps } from "react";

// Inline 20x20 stroke icons; they inherit currentColor and are decorative unless a title is passed.
type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Svg({ title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2.5 4 4.8v4.6c0 3.7 2.6 6.6 6 8.1 3.4-1.5 6-4.4 6-8.1V4.8L10 2.5Z" />
    <path d="m7.4 10 1.8 1.8 3.4-3.6" />
  </Svg>
);
export const TargetIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7" />
    <circle cx="10" cy="10" r="3.6" />
    <circle cx="10" cy="10" r="0.6" fill="currentColor" />
  </Svg>
);
export const LayersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m10 3 7 3.6-7 3.6-7-3.6L10 3Z" />
    <path d="m3 10.2 7 3.6 7-3.6" />
    <path d="m3 13.6 7 3.6 7-3.6" />
  </Svg>
);
export const DocCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 2.5h6.5L15 6v11.5H5V2.5Z" />
    <path d="M11.5 2.5V6H15" />
    <path d="m7.5 12 1.8 1.8 3.2-3.4" />
  </Svg>
);
export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12.8 3.6 3.6 3.6L7.6 16H4v-3.6l8.8-8.8Z" />
    <path d="m11 5.4 3.6 3.6" />
  </Svg>
);
export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="m8.4 7 4.4 3-4.4 3V7Z" />
  </Svg>
);
export const CompareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 15.5h14" />
    <path d="M6 15.5V9M10 15.5V5M14 15.5v-4" />
  </Svg>
);
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 4.5h13v8.5H9l-3.5 3v-3h-2V4.5Z" />
  </Svg>
);
export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="m6.8 10.2 2.2 2.2 4.2-4.6" />
  </Svg>
);
export const GavelIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 16.5h8" />
    <path d="m8.2 4.6 4 4M11 2.8l5 5M9.6 3.2l4.8 4.8-2.4 2.4L7.2 5.6l2.4-2.4Z" />
    <path d="m9.6 8.8-5 5" />
  </Svg>
);
export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 9v4.5M10 6.4v.1" />
  </Svg>
);
export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l14 14" />
    <path d="M8.2 5.2A7.6 7.6 0 0 1 10 5c4.2 0 7 5 7 5a12 12 0 0 1-2 2.6M12.2 14.5A6.4 6.4 0 0 1 10 15c-4.2 0-7-5-7-5a12.4 12.4 0 0 1 2.9-3.3" />
  </Svg>
);
export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10h12M11.5 5.5 16 10l-4.5 4.5" />
  </Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Svg>
);
export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="7" r="2.6" />
    <path d="M2.8 16c.4-2.6 2.3-4.2 4.7-4.2s4.3 1.6 4.7 4.2" />
    <circle cx="13.8" cy="7.6" r="2" />
    <path d="M13.6 11.8c1.9.1 3.3 1.5 3.6 3.6" />
  </Svg>
);
