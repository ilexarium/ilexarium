import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net';

/** A mail received by `FakeSmtp`. */
export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  user: string | null;
}

/**
 * A tiny SMTP server on loopback for tests: no TLS (the app allows that only to this machine),
 * AUTH PLAIN and LOGIN checked against one user, every mail kept. Just enough of RFC 5321 for
 * nodemailer.
 */
export class FakeSmtp {
  readonly mails: ReceivedMail[] = [];
  private readonly server: NetServer;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly account: { user: string; pass: string } | null = null) {
    this.server = createNetServer((socket) => this.session(socket));
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private session(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let mail: ReceivedMail = { from: '', to: [], data: '', user: null };
    let user: string | null = null;
    let mode: 'command' | 'data' | 'loginUser' | 'loginPass' = 'command';
    let loginUser = '';
    let buffer = '';
    const accept = (name: string, pass: string) => {
      if (this.account && (name !== this.account.user || pass !== this.account.pass)) {
        reply('535 5.7.8 Authentication credentials invalid');
      } else {
        user = name;
        reply('235 2.7.0 Authentication successful');
      }
    };
    reply('220 fake.smtp ESMTP');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (mode === 'data') {
          if (line === '.') {
            this.mails.push({ ...mail, user });
            mail = { from: '', to: [], data: '', user: null };
            mode = 'command';
            reply('250 2.0.0 Queued');
          } else mail.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        if (mode === 'loginUser') {
          loginUser = Buffer.from(line, 'base64').toString();
          mode = 'loginPass';
          reply(`334 ${Buffer.from('Password:').toString('base64')}`);
          continue;
        }
        if (mode === 'loginPass') {
          mode = 'command';
          accept(loginUser, Buffer.from(line, 'base64').toString());
          continue;
        }
        const [verb, ...rest] = line.split(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            reply('250-fake.smtp');
            reply('250 AUTH PLAIN LOGIN');
            break;
          case 'HELO':
            reply('250 fake.smtp');
            break;
          case 'AUTH':
            if (rest[0]?.toUpperCase() === 'PLAIN') {
              const [, name, pass] = Buffer.from(rest[1] ?? '', 'base64')
                .toString()
                .split('\0');
              accept(name, pass);
            } else {
              mode = 'loginUser';
              reply(`334 ${Buffer.from('Username:').toString('base64')}`);
            }
            break;
          case 'MAIL':
            if (this.account && !user) reply('530 5.7.0 Authentication required');
            else {
              mail.from = /<(.*)>/.exec(line)?.[1] ?? '';
              reply('250 2.1.0 OK');
            }
            break;
          case 'RCPT':
            mail.to.push(/<(.*)>/.exec(line)?.[1] ?? '');
            reply('250 2.1.5 OK');
            break;
          case 'DATA':
            mode = 'data';
            reply('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            mail = { from: '', to: [], data: '', user: null };
            reply('250 OK');
            break;
          case 'QUIT':
            reply('221 Bye');
            socket.end();
            break;
          default:
            reply('502 5.5.2 Command not recognized');
        }
      }
    });
  }
}

/** A message received by `FakeNtfy`. */
export interface ReceivedNtfy {
  path: string;
  authorization: string | null;
  body: { topic: string; title: string; message: string; priority: number; tags: string[] };
}

/** An ntfy server on loopback for tests: keeps every JSON publish; `status` sets the answer. */
export class FakeNtfy {
  readonly messages: ReceivedNtfy[] = [];
  status = 200;
  private readonly server: Server;

  constructor() {
    this.server = createHttpServer((req: IncomingMessage, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString()));
      req.on('end', () => {
        if (this.status < 300) {
          this.messages.push({
            path: req.url ?? '',
            authorization: req.headers.authorization ?? null,
            body: JSON.parse(data) as ReceivedNtfy['body'],
          });
        }
        res.writeHead(this.status, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
