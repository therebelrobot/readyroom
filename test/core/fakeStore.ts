/**
 * In-memory `TicketStore` for tests. Mirrors the single-writer semantics of the real
 * stores closely enough to exercise the lifecycle; it is not a durability test.
 */

import type { AuditEntry, Status, Ticket, TicketStore } from "../../src/core/types";

export class FakeTicketStore implements TicketStore {
  readonly tickets = new Map<string, Ticket>();
  readonly audit: AuditEntry[] = [];

  async load(): Promise<void> {
    // Nothing to load: state lives in memory for the duration of a test.
  }

  async list(filter: { status?: Status; since?: string }): Promise<Ticket[]> {
    return [...this.tickets.values()].filter((ticket) => {
      if (filter.status !== undefined && ticket.status !== filter.status) {
        return false;
      }
      if (filter.since !== undefined && Date.parse(ticket.created_at) < Date.parse(filter.since)) {
        return false;
      }
      return true;
    });
  }

  async get(id: string): Promise<Ticket | undefined> {
    const ticket = this.tickets.get(id);
    return ticket === undefined ? undefined : { ...ticket };
  }

  async put(ticket: Ticket): Promise<void> {
    this.tickets.set(ticket.id, { ...ticket });
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
  }

  countAudit(action: AuditEntry["action"]): number {
    return this.audit.filter((entry) => entry.action === action).length;
  }
}
