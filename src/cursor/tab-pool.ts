import { randomBytes } from "node:crypto";
import { MAX_CHATGPT_BROWSER_TABS } from "../adapters/chatgpt-web/concurrency";
import { ChatGptWebTabLimitError } from "./errors";

export interface TabLease {
  slotId: string;
  jobId: string;
  release: () => void;
}

interface ActiveLease {
  jobId: string;
  leasedAt: number;
}

/**
 * Physical Electron/Playwright surfaces. A GPT Web job is logical work and may
 * occupy a slot only while it is in flight. Sequential jobs reuse the same five
 * slots; a sixth concurrent lease fails closed.
 */
export class TabPool {
  private readonly leases = new Map<string, ActiveLease>();

  constructor(readonly max = MAX_CHATGPT_BROWSER_TABS) {}

  get activeCount(): number {
    return this.leases.size;
  }

  snapshot(): Array<{ slotId: string; jobId: string; leasedAt: number }> {
    return [...this.leases.entries()].map(([slotId, lease]) => ({
      slotId,
      jobId: lease.jobId,
      leasedAt: lease.leasedAt,
    }));
  }

  lease(jobId: string, now = Date.now()): TabLease {
    const existing = [...this.leases.entries()].find(([, lease]) => lease.jobId === jobId);
    if (existing) {
      const [slotId] = existing;
      return { slotId, jobId, release: () => this.release(slotId, jobId) };
    }
    if (this.leases.size >= this.max) throw new ChatGptWebTabLimitError(this.max);
    const slotId = `tab-${randomBytes(6).toString("hex")}`;
    this.leases.set(slotId, { jobId, leasedAt: now });
    return { slotId, jobId, release: () => this.release(slotId, jobId) };
  }

  release(slotId: string, jobId?: string): void {
    const lease = this.leases.get(slotId);
    if (!lease) return;
    if (jobId && lease.jobId !== jobId) return;
    this.leases.delete(slotId);
  }
}
