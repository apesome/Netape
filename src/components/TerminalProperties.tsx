import { useMemo } from "react";
import { newHost, type Host } from "../types";
import HostDialog from "./HostDialog";

export default function TerminalProperties({ title, protocol, host, hosts, width, onClose }: {
  title: string; protocol: string; host?: Host; hosts: Host[]; localShell?: string; sessionId?: string; width: number; onClose: () => void;
}) {
  const snapshot = useMemo(() => host ?? { ...newHost(), name: title, protocol }, [host, title, protocol]);
  return <HostDialog host={snapshot} hosts={hosts} mode="drawer" readOnly drawerWidth={width}
    onSave={() => {}} onClose={onClose}/>;
}
