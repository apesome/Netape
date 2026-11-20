export type RightDrawer = "monitor" | "properties" | "notes" | "host" | "ai";
export type RightDrawers = Record<string, RightDrawer>;

/** Each tab owns exactly one right drawer; reopening may optionally toggle it. */
export function updateRightDrawer(drawers: RightDrawers, tabId: string, drawer: RightDrawer | null, toggle = false): RightDrawers {
  const next = { ...drawers };
  if (drawer === null || (toggle && drawers[tabId] === drawer)) delete next[tabId];
  else next[tabId] = drawer;
  return next;
}
