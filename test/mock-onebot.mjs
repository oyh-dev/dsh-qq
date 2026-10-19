import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import wsPkg from 'file:///C:/Users/33930/.dsh/profiles/desktop/node_modules/ws/index.js';

const { WebSocketServer } = wsPkg;
const TOKEN = 'test-token';
const LOG = 'D:/dsh-qq-data/qq-debug/mock.log';
const PORT = 3001;

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, `${text}\n`);
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/test.png') {
    const bytes = readFileSync('D:/dsh-qq-data/dsh-qq/test/test.png');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
    res.end(bytes);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
httpServer.listen(3002, '127.0.0.1', () => log('http 3002 ready'));

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
let messageId = 1000;
let connected = 0;

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.searchParams.get('access_token') !== TOKEN) {
    socket.close(4001, 'bad token');
    return;
  }
  connected++;
  log(`client connected #${connected}`);
  socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));

  socket.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { action, params, echo } = payload;
    log(`CALL ${action} ${JSON.stringify(params)}`);
    const reply = (data, retcode = 0) => socket.send(JSON.stringify({ status: retcode === 0 ? 'ok' : 'failed', retcode, data, echo }));
    switch (action) {
      case 'get_login_info':
        reply({ user_id: 10000, nickname: 'DSH-TestBot' });
        break;
      case 'get_friend_list':
        reply([{ user_id: 10001, nickname: '测试用户', remark: 'tester' }]);
        break;
      case 'get_group_list':
        reply([{ group_id: 20002, group_name: '测试群', member_count: 3 }]);
        break;
      case 'send_private_msg':
      case 'send_group_msg': {
        const text = (params?.message ?? []).filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');
        log(`SENT_TEXT ${JSON.stringify(text)}`);
        const code = text.match(/配对码[：:]\s*(\d{6})/)?.[1];
        if (code) log(`PAIR_CODE ${code}`);
        reply({ message_id: ++messageId });
        break;
      }
      case 'send_qzone_msg':
        log(`QZONE ${JSON.stringify(params)}`);
        reply({ tid: 'mock-tid-001' });
        break;
      case 'get_msg':
        reply({
          message_id: Number(params?.message_id) || 1000,
          message: [
            { type: 'text', data: { text: '这是一条测试消息' } },
            { type: 'image', data: { url: 'http://127.0.0.1:3002/test.png', file: 'test.png' } },
          ],
          sender: { user_id: 10001, nickname: '测试用户' },
        });
        break;
      case 'get_friend_msg_history':
      case 'get_group_msg_history':
        reply({ messages: [] });
        break;
      default:
        reply({});
        break;
    }
  });
});

// Send a test inbound message shortly after each connection, once.
let sent = false;
wss.on('connection', () => {
  if (sent) return;
  sent = true;
  setTimeout(() => {
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          message_id: 9001,
          user_id: 10001,
          time: Math.floor(Date.now() / 1000),
          sender: { nickname: '测试用户', user_id: 10001 },
          message: [
            { type: 'text', data: { text: '你好，请看看这张图' } },
            { type: 'image', data: { url: 'http://127.0.0.1:3002/test.png', file: 'test.png' } },
          ],
          raw_message: '你好，请看看这张图[图片]',
        }));
        log('EVENT inbound private image sent');
      }
    }
  }, 1500);
});

log(`mock onebot ws ${PORT} started`);
