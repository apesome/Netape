import type { Host } from "./types";

export function compareHostOrder(a: Host, b: Host): number {
  return Number(b.protocol === "Folder") - Number(a.protocol === "Folder")
    || a.sort - b.sort || a.name.localeCompare(b.name);
}

export type HostDropPosition = "before" | "after" | "inside";
export interface HostDropPlan { ids: string[]; parentId: string; }
const hostProtocol = (host: Host) => host.protocol === "Folder" ? host.ownerType || "SSH" : host.protocol;

/** Plan a reorder or folder move, keeping node kinds and protocols separate. */
export function planHostDrop(hosts: Host[], sourceId: string, targetId: string, position: HostDropPosition): HostDropPlan | null {
  const source = hosts.find(host => host.id === sourceId && !host.deleted);
  const target = hosts.find(host => host.id === targetId && !host.deleted);
  if (!source || sourceId === targetId || (!target && targetId !== "0")) return null;
  if (target && hostProtocol(source) !== hostProtocol(target)) return null;
  const inside = position === "inside";
  if (inside ? targetId !== "0" && target?.protocol !== "Folder"
    : !target || (source.protocol === "Folder") !== (target.protocol === "Folder")) return null;
  const parentId = inside ? targetId : target!.parentId || "0";
  const seen = new Set<string>();
  for (let id = parentId; id !== "0";) {
    if (id === sourceId || seen.has(id)) return null;
    seen.add(id);
    const parent = hosts.find(host => host.id === id && !host.deleted && host.protocol === "Folder");
    if (!parent || hostProtocol(parent) !== hostProtocol(source)) return null;
    id = parent.parentId || "0";
  }
  const siblings = hosts.filter(host => !host.deleted && host.id !== sourceId
    && (host.parentId || "0") === parentId && (host.protocol === "Folder") === (source.protocol === "Folder")
    && hostProtocol(host) === hostProtocol(source)).sort(compareHostOrder).map(host => host.id);
  const ids = [...siblings];
  ids.splice(inside ? ids.length : ids.indexOf(targetId) + Number(position === "after"), 0, sourceId);
  if (parentId === (source.parentId || "0")) {
    if (inside) return null;
    const previous = [...siblings, sourceId].map(id => hosts.find(host => host.id === id)!).sort(compareHostOrder);
    if (previous.every((host, index) => host.id === ids[index])) return null;
  }
  return { ids, parentId };
}

/** Reorder siblings without changing folders, protocols, or unrelated entries. */
export function reorderedHostIds(hosts: Host[], sourceId: string, targetId: string, after: boolean): string[] | null {
  const source = hosts.find(host => host.id === sourceId && !host.deleted);
  const target = hosts.find(host => host.id === targetId && !host.deleted);
  if (!source || !target || sourceId === targetId) return null;
  const protocol = (host: Host) => host.protocol === "Folder" ? host.ownerType || "SSH" : host.protocol;
  const sameGroup = (host: Host) => (host.parentId || "0") === (source.parentId || "0")
    && (host.protocol === "Folder") === (source.protocol === "Folder")
    && protocol(host) === protocol(source);
  if (!sameGroup(target)) return null;
  const siblings = hosts.filter(host => !host.deleted && sameGroup(host)).sort(compareHostOrder).map(host => host.id);
  const result = siblings.filter(id => id !== sourceId);
  result.splice(result.indexOf(targetId) + Number(after), 0, sourceId);
  return result.every((id, index) => id === siblings[index]) ? null : result;
}
