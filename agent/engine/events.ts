import type { EngineEvent, EventBody } from "./protocol.ts";

/** The last events a chat keeps for a client that reconnects with `after` (SPEC 6.2). */
export const RING_SIZE = 2_000;

export type Subscriber = (event: EngineEvent) => void;

export type Subscription = {
  /** Lines to send first: `stream.ready`, then any replayed events. */
  initial: EngineEvent[];
  unsubscribe(): void;
};

/**
 * One chat's event stream. The host owns `seq` (per chat, per epoch), so it
 * survives a session being disposed and reopened; the ring buffer keeps the
 * last RING_SIZE events. `stream.ready` and `ping` carry the current `seq`
 * without advancing it and are never stored.
 */
export class ChatBus {
  private seq = 0;
  private readonly ring: EngineEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  readonly chatId: string;
  readonly epoch: string;
  private readonly now: () => Date;

  constructor(chatId: string, epoch: string, now: () => Date = () => new Date()) {
    this.chatId = chatId;
    this.epoch = epoch;
    this.now = now;
  }

  get tailSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get bufferedEvents(): number {
    return this.ring.length;
  }

  /**
   * Forgets the stored events and keeps `seq` and the epoch. A client that
   * reconnects with an `after` older than the tail then gets `resync: true`,
   * which is right: the chat was evicted and nothing is left to replay.
   */
  dropRing(): void {
    this.ring.length = 0;
  }

  /** Stamps the envelope, stores the event and hands it to every subscriber. */
  emit(body: EventBody, turnId?: string): EngineEvent {
    this.seq += 1;
    const event: EngineEvent = {
      seq: this.seq,
      epoch: this.epoch,
      at: this.now().toISOString(),
      chatId: this.chatId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...body,
    };
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // One broken subscriber (a closed socket) must not stop the others.
        this.subscribers.delete(subscriber);
      }
    }
    return event;
  }

  /** A keep-alive line at the current seq. Not stored. */
  ping(): EngineEvent {
    return { seq: this.seq, epoch: this.epoch, at: this.now().toISOString(), chatId: this.chatId, type: "ping" };
  }

  /**
   * Opens a stream. `after` is the last seq the client applied and `epoch` the
   * epoch it saw it in. A client that gives neither starts live. A client whose
   * epoch differs, or whose `after` fell out of the ring, is told to refetch
   * rows (`resync`) and gets no replay.
   */
  subscribe(
    send: Subscriber,
    options: { after?: number; epoch?: string; running: { turnId: string } | null },
  ): Subscription {
    const { after, epoch, running } = options;
    let resync = false;
    let replay: EngineEvent[] = [];
    if (after !== undefined || epoch !== undefined) {
      const oldest = this.ring.length > 0 ? this.ring[0].seq : this.seq + 1;
      if (epoch !== this.epoch || after === undefined || after > this.seq || after < oldest - 1) {
        resync = true;
      } else {
        replay = this.ring.filter((event) => event.seq > after);
      }
    }
    const ready: EngineEvent = {
      seq: this.seq,
      epoch: this.epoch,
      at: this.now().toISOString(),
      chatId: this.chatId,
      type: "stream.ready",
      tailSeq: this.seq,
      resync,
      running,
    };
    this.subscribers.add(send);
    return { initial: [ready, ...replay], unsubscribe: () => { this.subscribers.delete(send); } };
  }
}
