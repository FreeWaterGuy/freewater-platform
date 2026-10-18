// Contract for sending sign-in codes and notices: an email service, an SMS service, or the test outbox.

export interface OutgoingMessage {
  channel: 'email' | 'sms';
  to: string;
  subject?: string;
  text: string;
}

export interface Messenger {
  readonly name: string;
  send(message: OutgoingMessage): Promise<{ delivered: boolean; error?: string }>;
}

/** Sends nothing; keeps every message so tests and demos can read the codes. */
export class TestOutbox implements Messenger {
  readonly name = 'test-outbox';
  readonly sent: OutgoingMessage[] = [];
  constructor(private echo = false) {}
  async send(message: OutgoingMessage) {
    this.sent.push(message);
    if (this.echo) console.log(`[test-outbox] to ${message.to}: ${message.text}`);
    return { delivered: true };
  }
  lastTo(to: string): OutgoingMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
