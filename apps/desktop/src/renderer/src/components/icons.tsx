import type { ReactNode } from "react";

type IconProps = { size?: number };

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function Mark({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M14 21L19.5 15.5L36 32L19.5 48.5L14 43L25 32Z" fill="currentColor" />
      <path d="M34 42h17v7H34z" fill="var(--ember)" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function PencilIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    </svg>
  );
}

export function TrashIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

export function TerminalIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m5 7 5 5-5 5M12 17h7" />
    </svg>
  );
}

export function PlayIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M7 5v14l11-7L7 5Z" />
    </svg>
  );
}

export function PlusIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function GearIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

export function StopIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

export function FolderIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

const icon = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    {children}
  </svg>
);

export const FileIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
export const EditIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const GlobeIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
export const CursorIcon = ({ size = 14 }: IconProps) => icon(size, <path d="m4 4 7 17 2.5-7.5L21 11z" />);
export const ImageIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 17-5-5-9 8" /></>);
export const SparkleIcon = ({ size = 15 }: IconProps) =>
  icon(size, <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />);
export const PaperclipIcon = ({ size = 15 }: IconProps) =>
  icon(size, <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.4a1.7 1.7 0 0 1-2.4-2.4L15.5 7" />);
export const ArrowUpIcon = ({ size = 15 }: IconProps) => icon(size, <path d="M12 19V5M5 12l7-7 7 7" />);
export const CheckIcon = ({ size = 13 }: IconProps) => icon(size, <path d="M20 6 9 17l-5-5" />);
export const XIcon = ({ size = 13 }: IconProps) => icon(size, <path d="M18 6 6 18M6 6l12 12" />);
export const ChevronIcon = ({ size = 12 }: IconProps) => icon(size, <path d="m9 6 6 6-6 6" />);
export const MonitorIcon = ({ size = 15 }: IconProps) =>
  icon(size, <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
export const ListIcon = ({ size = 14 }: IconProps) => icon(size, <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />);
export const SearchSmallIcon = ({ size = 14 }: IconProps) => icon(size, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const MemoryIcon = ({ size = 15 }: IconProps) =>
  icon(
    size,
    <>
      <path d="M9 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10.5a3 3 0 0 0 1 2.2A3 3 0 0 0 6.5 18 2.5 2.5 0 0 0 9 20h0a3 3 0 0 0 3-3V7.5a3 3 0 0 0-3-3Z" />
      <path d="M15 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.2 3 3 0 0 1-1.5 5.3A2.5 2.5 0 0 1 15 20h0a3 3 0 0 1-3-3" />
    </>,
  );
export const PinIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><path d="M12 17v4" /><path d="M8 3h8l-1 6 3 4H6l3-4z" /></>);
export const ClockIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const BookIcon = ({ size = 14 }: IconProps) =>
  icon(size, <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M8 7h7" /></>);
export const BulbIcon = ({ size = 14 }: IconProps) =>
  icon(size, <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3Z" />);
export const AlertIcon = ({ size = 12 }: IconProps) =>
  icon(size, <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></>);
