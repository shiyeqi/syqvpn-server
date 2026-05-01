const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8765;

// 创建 HTTP 服务器（ngrok HTTP 穿透需要）
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('syqVPN relay server running');
});

const wss = new WebSocket.Server({ server });

// 房间：roomId -> { members: Map<clientId, {ws, name, virtualIp}>, subnet, ipCounter }
const rooms = new Map();
const clientRoom = new Map();
const ipToClient = new Map();

const SUBNET_BASE = '10.0';
let subnetCounter = 1;

function allocateVirtualIp(roomId) {
    const room = rooms.get(roomId);
    if (!room.subnet) {
        room.subnet = `${SUBNET_BASE}.${subnetCounter++}`;
        room.ipCounter = 1;
    }
    return `${room.subnet}.${room.ipCounter++}`;
}

function broadcastJson(roomId, message, excludeId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    room.members.forEach((member, id) => {
        if (id !== excludeId && member.ws.readyState === WebSocket.OPEN) {
            member.ws.send(data);
        }
    });
}

function parseDstIp(buf) {
    if (buf.length < 20) return null;
    return `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;
}

wss.on('connection', (ws) => {
    const clientId = uuidv4();

    ws.on('message', (raw, isBinary) => {
        if (isBinary) {
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            const dstIp = parseDstIp(buf);
            if (!dstIp) return;
            const roomId = clientRoom.get(clientId);
            const room = rooms.get(roomId);
            if (!room) return;
            const lastOctet = parseInt(dstIp.split('.')[3]);
            if (lastOctet === 255 || dstIp.startsWith('224.') || dstIp.startsWith('239.')) {
                room.members.forEach((member, id) => {
                    if (id !== clientId && member.ws.readyState === WebSocket.OPEN)
                        member.ws.send(buf, { binary: true });
                });
                return;
            }
            const targetClientId = ipToClient.get(dstIp);
            if (targetClientId) {
                const target = room.members.get(targetClientId);
                if (target && target.ws.readyState === WebSocket.OPEN)
                    target.ws.send(buf, { binary: true });
            }
            return;
        }

        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create_room': {
                const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
                rooms.set(roomId, { members: new Map(), subnet: null, ipCounter: 1 });
                const virtualIp = allocateVirtualIp(roomId);
                rooms.get(roomId).members.set(clientId, { ws, name: msg.name || '主机', virtualIp });
                clientRoom.set(clientId, roomId);
                ipToClient.set(virtualIp, clientId);
                ws.send(JSON.stringify({ type: 'room_created', roomId, virtualIp, clientId }));
                console.log(`房间创建: ${roomId}  IP: ${virtualIp}`);
                break;
            }
            case 'join_room': {
                const { roomId, name } = msg;
                if (!rooms.has(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
                    return;
                }
                const room = rooms.get(roomId);
                if (room.members.size >= 8) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间已满（最多8人）' }));
                    return;
                }
                const virtualIp = allocateVirtualIp(roomId);
                room.members.set(clientId, { ws, name: name || '成员', virtualIp });
                clientRoom.set(clientId, roomId);
                ipToClient.set(virtualIp, clientId);
                const memberList = [];
                room.members.forEach((m, id) => {
                    if (id !== clientId) memberList.push({ id, name: m.name, virtualIp: m.virtualIp });
                });
                ws.send(JSON.stringify({ type: 'room_joined', roomId, virtualIp, clientId, members: memberList }));
                broadcastJson(roomId, { type: 'member_joined', id: clientId, name: name || '成员', virtualIp }, clientId);
                console.log(`${name} 加入: ${roomId}  IP: ${virtualIp}`);
                break;
            }
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            case 'leave_room':
                handleLeave(clientId);
                break;
        }
    });

    ws.on('close', () => handleLeave(clientId));

    // 心跳保活，防止 Railway 断开空闲连接
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25000);
    ws.on('close', () => clearInterval(pingInterval));
});

function handleLeave(clientId) {
    const roomId = clientRoom.get(clientId);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(clientId);
    if (member) ipToClient.delete(member.virtualIp);
    room.members.delete(clientId);
    clientRoom.delete(clientId);
    broadcastJson(roomId, { type: 'member_left', id: clientId, name: member?.name });
    if (room.members.size === 0) {
        rooms.delete(roomId);
        console.log(`房间删除: ${roomId}`);
    }
}

server.listen(PORT, () => {
    console.log(`syqVPN 中继服务器启动，端口 ${PORT}`);
    console.log(`本地访问: ws://localhost:${PORT}`);
});
