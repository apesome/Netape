import type { Host } from "./types";

/** Empty ownerType belongs to SSH, matching the home host tree. */
export function folderBelongsToProtocol(host: Host, protocol: string): boolean {
  return host.protocol === "Folder" && (host.ownerType || "SSH") === protocol;
}
