import { loadWs } from './ws-loader.mjs';
import { OneBotClient } from '../lib/onebot.js';

const wsPkg = await loadWs();
const { WebSocketServer } = wsPkg;

const wss = new WebSocketServer({ port: 3011, path: '/', verifyClient: (info, done) => {
  const url = new URL(info.req.url, 'http://127.0.0.1');
  done(url.searchParams.get('access_token') === 'test-token', 401, 'bad token');
} });

const received = [];
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
  socket.send(JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    message_id: 42,
    user_id: 10001,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '测试用户' },
    message: [{ type: 'text', data: { text: '你好' } }],
    raw_message: '你好',
  }));
  socket.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());
    received.push(payload);
    if (payload.action === 'get_login_info') {
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1000000002, nickname: 'Bot' }, echo: payload.echo }));
    } else if (payload.action === 'send_private_msg') {
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 99 }, echo: payload.echo }));
    }
  });
});

const events = [];
const statuses = [];
const client = new OneBotClient({
  url: 'ws://127.0.0.1:3011',
  token: 'test-token',
  logger: (line) => console.log('[client]', line),
  onEvent: (event) => events.push(event),
  onStatus: (status) => statuses.push(status),
});

await client.start();
await new Promise((resolve) => setTimeout(resolve, 500));
const info = await client.call('get_login_info', {});
const sent = await client.call('send_private_msg', { user_id: 10001, message: [{ type: 'text', data: { text: 'hi' } }] });
await new Promise((resolve) => setTimeout(resolve, 300));

console.log(JSON.stringify({ info, sent, events: events.length, statuses, received: received.length }, null, 2));
await client.stop();
wss.close();
