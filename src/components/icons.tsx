// Shared protocol icons for the protocol dropdowns and tabs. Each is a small
// SVG that reads as its protocol's meaning. Color follows `currentColor`.

import type { ReactNode } from "react";

function Svg({ size = 15, strokeWidth = 1.7, children }: { size?: number; strokeWidth?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, verticalAlign: "-2px" }}
    >
      {children}
    </svg>
  );
}

/** SSH — a terminal window with a shell prompt. */
export const SshIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
    <path d="M6.5 9.5 9.5 12 6.5 14.5" />
    <path d="M12 14.5h3.5" />
  </Svg>
);

/** Telnet — a raw remote link between two nodes (unencrypted). */
export const TelnetIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="5.5" cy="12" r="2.4" />
    <circle cx="18.5" cy="12" r="2.4" />
    <path d="M7.9 12h8.2" />
  </Svg>
);

/** Local — your own machine: a monitor on a stand. */
export const LocalIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="4.5" width="18" height="12" rx="1.6" />
    <path d="M9.5 20h5" />
    <path d="M12 16.5V20" />
  </Svg>
);

/** WSL — a penguin (Linux). */
export const WslIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 4.5c-2.2 0-3.5 1.8-3.5 4 0 .5 0 .9.1 1.3C7 11 6 13 6 15.6 6 18.6 8.3 21 12 21s6-2.4 6-5.4c0-2.6-1-4.6-2.6-5.8.1-.4.1-.8.1-1.3 0-2.2-1.3-4-3.5-4z" />
    <circle cx="10.5" cy="8.9" r=".75" fill="currentColor" stroke="none" />
    <circle cx="13.5" cy="8.9" r=".75" fill="currentColor" stroke="none" />
    <path d="M11.1 10.3h1.8l-.9 1.4z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Serial — a microchip / hardware port. */
export const SerialIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <path d="M10 7V4.5M14 7V4.5M10 17v2.5M14 17v2.5M7 10H4.5M7 14H4.5M17 10h2.5M17 14h2.5" />
  </Svg>
);

/** FTP — a folder badge labelled "FTP". */
export const FtpFolderIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.8a1.5 1.5 0 0 1 1.2.6L10.7 7H19.5A1.5 1.5 0 0 1 21 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V6.5z" />
    <text
      x="12"
      y="15.6"
      textAnchor="middle"
      fontSize="6.6"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
      fontFamily="-apple-system, Segoe UI, Roboto, sans-serif"
    >
      FTP
    </text>
  </Svg>
);

/** SMB — a folder badge labelled "SMB". */
export const SmbFolderIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.8a1.5 1.5 0 0 1 1.2.6L10.7 7H19.5A1.5 1.5 0 0 1 21 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V6.5z" />
    <text
      x="12"
      y="15.6"
      textAnchor="middle"
      fontSize="6.2"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
      fontFamily="-apple-system, Segoe UI, Roboto, sans-serif"
    >
      SMB
    </text>
  </Svg>
);

/**
 * InboxEmptyIcon — an inbox/tray with a soft ground shadow. Used as the
 * shared "empty list" placeholder across dialogs (transfers, keyword
 * highlights, key manager). Size defaults to 46 to match the transfer panel.
 */
export const InboxEmptyIcon = ({ size = 46 }: { size?: number }) => (
  <Svg size={size} strokeWidth={1}>
    <ellipse cx="12" cy="23.5" rx="7" ry="0.8" fill="currentColor" stroke="none" />
    <path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M2.25 13.838V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 8.5a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.1 13.177a2.25 2.25 0 0 0-.1.661z" />
  </Svg>
);
export const SidebarPanelIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>
  </svg>
);
