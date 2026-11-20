export interface TransferClock {
  startedAt: number; elapsedMs?: number; pausedMs?: number; clockPausedAt?: number;
  status: string; paused?: boolean; speed: number; lastAt?: number; lastXfer?: number; transferred: number;
}
export function transferElapsed(clock: TransferClock, now = Date.now()): number {
  return clock.elapsedMs ?? Math.max(0, (clock.clockPausedAt ?? now) - clock.startedAt - (clock.pausedMs ?? 0));
}
export function syncTransferClock<T extends TransferClock>(next: T, previous: T | undefined, paused: boolean, now: number): T {
  if (previous?.elapsedMs !== undefined) return next;
  let pausedMs=previous?.pausedMs ?? next.pausedMs ?? 0;
  let clockPausedAt=previous?.clockPausedAt ?? next.clockPausedAt;
  const finished=next.status === "done" || next.status === "error";
  const resumed=clockPausedAt !== undefined && !paused;
  if (finished) {
    return {...next, pausedMs, clockPausedAt:undefined,
      elapsedMs:Math.max(0,(clockPausedAt ?? now)-next.startedAt-pausedMs),speed:0};
  }
  if (resumed) { pausedMs+=Math.max(0,now-clockPausedAt!);clockPausedAt=undefined; }
  if (paused && clockPausedAt === undefined) clockPausedAt=now;
  return {...next,pausedMs,clockPausedAt,...(paused?{speed:0}:{}),
    ...(resumed?{lastAt:now,lastXfer:next.transferred,speed:0}:{})};
}
export function syncTransferTimings<T extends TransferClock & {id:string;isDir?:boolean;subFiles?: (TransferClock & {relPath:string})[]}>(next:T[], previous:T[], now=Date.now()):T[] {
  const old=new Map(previous.map(t=>[t.id,t]));
  return next.map(t=>{
    const before=old.get(t.id),active=t.subFiles?.filter(f=>f.status!=="done")??[];
    const paused=!!t.paused || (!!t.isDir&&active.length>0&&active.every(f=>f.paused));
    const timed=syncTransferClock(t,before,paused,now);
    const prior=new Map(before?.subFiles?.map(f=>[f.relPath,f])??[]);
    return {...timed,subFiles:t.subFiles?.map(f=>syncTransferClock(f,prior.get(f.relPath),!!t.paused||!!f.paused,now))};
  });
}
