// Minimal in-memory accounting of CURRENT in-flight transfers for this
// process only. Nothing is persisted and no history is kept — entries exist
// strictly between a stream starting and it finishing, failing, or being
// cancelled, so the admin dashboard can show live activity without inventing
// historical metrics.

export type TransferDirection = "upload" | "download";

export interface ActiveTransfer {
  id: number;
  direction: TransferDirection;
  name: string;
  bytes: number;
  totalBytes: number | null;
  startedAt: string;
}

export class TransferRegistry {
  private nextId = 1;
  private readonly active = new Map<number, ActiveTransfer>();

  begin(
    direction: TransferDirection,
    name: string,
    totalBytes: number | null,
  ): number {
    const id = this.nextId;
    this.nextId += 1;
    this.active.set(id, {
      id,
      direction,
      name,
      bytes: 0,
      totalBytes,
      startedAt: new Date().toISOString(),
    });
    return id;
  }

  progress(id: number, deltaBytes: number): void {
    const entry = this.active.get(id);
    if (entry) entry.bytes += deltaBytes;
  }

  end(id: number): void {
    this.active.delete(id);
  }

  list(): ActiveTransfer[] {
    return [...this.active.values()].map((entry) => ({ ...entry }));
  }
}
