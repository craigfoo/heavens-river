// A small pool of terrain workers sharing one priority queue.

import type { ChunkRequest, ChunkResult, FarShellResult, WorkerRequest, WorkerResult } from './chunkTypes';
import type { TownResult } from '../../towns/townBuilder';

interface Slot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  job: string | null;
}

export class TerrainWorkerPool {
  private slots: Slot[] = [];
  private queue: ChunkRequest[] = [];
  private queued = new Set<string>();
  private inflight = new Set<string>();
  onChunk: (r: ChunkResult) => void = () => {};
  onFarShell: (r: FarShellResult) => void = () => {};
  onTown: (r: TownResult) => void = () => {};
  private townQueue: number[] = [];
  private townPending = new Set<number>();
  private epoch = 0;
  private slotEpoch = new Map<Slot, number>();
  generated = 0;
  totalGenMs = 0;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: false, ready: false, job: null };
      worker.onmessage = (e: MessageEvent<WorkerResult>) => this.handle(slot, e.data);
      worker.onerror = (e) => console.error('terrain worker error', e.message);
      this.slots.push(slot);
    }
  }

  get size() {
    return this.slots.length;
  }

  /** (Re)initialise every worker for a section; drops all pending work. */
  init(section: number, seed: number) {
    this.epoch++;
    this.queue.length = 0;
    this.queued.clear();
    this.inflight.clear();
    this.townQueue.length = 0;
    this.townPending.clear();
    for (const s of this.slots) {
      s.ready = false;
      s.busy = true;
      s.job = null;
      this.slotEpoch.set(s, this.epoch);
      s.worker.postMessage({ type: 'init', section, seed } satisfies WorkerRequest);
    }
  }

  private handle(slot: Slot, msg: WorkerResult) {
    slot.busy = false;
    const job = slot.job;
    slot.job = null;
    if (msg.type === 'ready') {
      slot.ready = this.slotEpoch.get(slot) === this.epoch;
    } else if (msg.type === 'chunk') {
      if (job) this.inflight.delete(job);
      this.generated++;
      this.totalGenMs += msg.genMs;
      if (this.slotEpoch.get(slot) === this.epoch) this.onChunk(msg);
    } else if (msg.type === 'farshell') {
      if (this.slotEpoch.get(slot) === this.epoch) this.onFarShell(msg);
    } else if (msg.type === 'town') {
      this.townPending.delete(msg.siteId);
      if (this.slotEpoch.get(slot) === this.epoch) this.onTown(msg);
    }
    this.pump();
  }

  /** Replace the pending queue (already sorted by priority). */
  setQueue(reqs: ChunkRequest[]) {
    this.queue = reqs.filter((r) => !this.inflight.has(r.key));
    this.queued = new Set(this.queue.map((r) => r.key));
    this.pump();
  }

  isPending(key: string) {
    return this.queued.has(key) || this.inflight.has(key);
  }

  requestFarShell(ns: number, nz: number) {
    const epoch = this.epoch;
    const trySend = () => {
      if (epoch !== this.epoch) return;
      const slot = this.slots.find((s) => s.ready && !s.busy);
      if (!slot) {
        setTimeout(trySend, 30);
        return;
      }
      slot.busy = true;
      slot.job = '__farshell';
      slot.worker.postMessage({ type: 'farshell', ns, nz } satisfies WorkerRequest);
    };
    trySend();
  }

  /** Queue a settlement build (skipped if already pending). High priority jumps the queue. */
  requestTown(siteId: number, urgent = false) {
    if (this.townPending.has(siteId)) {
      if (urgent) {
        const i = this.townQueue.indexOf(siteId);
        if (i > 0) {
          this.townQueue.splice(i, 1);
          this.townQueue.unshift(siteId);
        }
      }
      return;
    }
    this.townPending.add(siteId);
    if (urgent) this.townQueue.unshift(siteId);
    else this.townQueue.push(siteId);
    this.pump();
  }

  isTownPending(siteId: number) {
    return this.townPending.has(siteId);
  }

  /** Drop queued (not yet started) town builds that are no longer wanted. */
  pruneTowns(keep: (id: number) => boolean) {
    this.townQueue = this.townQueue.filter((id) => {
      const k = keep(id);
      if (!k) this.townPending.delete(id);
      return k;
    });
  }

  pump() {
    let townSlots = 0;
    for (const slot of this.slots) {
      if (!slot.ready || slot.busy) continue;
      // at most one idle worker at a time takes town work unless chunks are idle
      if (this.townQueue.length && (townSlots === 0 || this.queue.length === 0)) {
        const id = this.townQueue.shift()!;
        townSlots++;
        slot.busy = true;
        slot.job = `town:${id}`;
        slot.worker.postMessage({ type: 'town', siteId: id } satisfies WorkerRequest);
        continue;
      }
      const req = this.queue.shift();
      if (!req) return;
      this.queued.delete(req.key);
      this.inflight.add(req.key);
      slot.busy = true;
      slot.job = req.key;
      slot.worker.postMessage(req satisfies WorkerRequest);
    }
  }

  get pending() {
    return this.queue.length + this.inflight.size;
  }

  get allReady() {
    return this.slots.every((s) => s.ready);
  }
}
