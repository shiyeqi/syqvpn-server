const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8765;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('syqVPN relay server running');
});

const wss = new WebSocket.Server({ server });

// 房间：roomId -> { host: {ws, clientId, name, virtualIp}, members: Map<clientId, {ws, name, virtualIp}>, forwardPort, subnet, ipCounter }
const rooms = new Map();
const clientRoom = new Map();

const SUBNET_BASE = '10.0';
let subnetCounter = 1;

function allocateIp(room) {
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
    // 发给 host
    if (room.host && room.host.clientId !== excludeId && room.host.ws.readyState === WebSocket.OPEN)
        room.host.ws.send(data);
    // 发给所有成员
    room.members.forEach((member, id) => {
        if (id !== excludeId && member.ws.readyState === WebSocket.OPEN)
            member.ws.send(data);
    });
}

// TCP 转发通道：channelId -> { hostWs, clientWs }
const channels = new Map();

wss.on('connection', (ws) => {
    const clientId = uuidv4();

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25000);

    ws.on('message', (raw, isBinary) => {
        // 二进制 = TCP 数据转发
        if (isBinary) {
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            // 前16字节是 channelId（UUID）
            if (buf.length < 16) return;
            const channelId = buf.slice(0, 16).toString('hex');
            const data = buf.slice(16);
            const channel = channels.get(channelId);
            if (!channel) return;
            // 转发给对端
            const target = channel.hostClientId === clientId ? channel.memberWs : channel.hostWs;
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(buf, { binary: true });
            }
            return;
        }

        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // 主机创建房间，并声明转发端口
            case 'create_room': {
                const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
                const newRoom = { host: null, members: new Map(), forwardPort: msg.port || 25565, subnet: null, ipCounter: 1 };
                rooms.set(roomId, newRoom);
                const hostIp = allocateIp(newRoom);
                newRoom.host = { ws, clientId, name: msg.name || '主机', virtualIp: hostIp };
                clientRoom.set(clientId, roomId);
                ws.send(JSON.stringify({ type: 'room_created', roomId, clientId, virtualIp: hostIp, port: msg.port || 25565 }));
                console.log(`房间创建: ${roomId} IP: ${hostIp}`);
                break;
            }

            // 成员加入房间
            case 'join_room': {
                const { roomId, name } = msg;
                if (!rooms.has(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
                    return;
                }
                const room = rooms.get(roomId);
                if (room.members.size >= 7) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                    return;
                }
                const memberIp = allocateIp(room);
                room.members.set(clientId, { ws, name: name || '成员', virtualIp: memberIp });
                clientRoom.set(clientId, roomId);

                const memberList = [];
                room.members.forEach((m, id) => {
                    if (id !== clientId) memberList.push({ id, name: m.name, virtualIp: m.virtualIp });
                });
                // 加入主机信息
                memberList.unshift({ id: room.host.clientId, name: room.host.name, virtualIp: room.host.virtualIp });

                ws.send(JSON.stringify({
                    type: 'room_joined', roomId, clientId,
                    virtualIp: memberIp,
                    hostName: room.host.name,
                    forwardPort: room.forwardPort,
                    members: memberList
                }));

                // 通知主机有新成员
                room.host.ws.send(JSON.stringify({
                    type: 'member_joined', id: clientId, name: name || '成员', virtualIp: memberIp
                }));

                broadcastJson(roomId, { type: 'member_joined', id: clientId, name: name || '成员', virtualIp: memberIp }, clientId);
                console.log(`${name} 加入: ${roomId}`);
                break;
            }

            // 建立 TCP 转发通道（成员发起）
            case 'open_channel': {
                const roomId = clientRoom.get(clientId);
                const room = rooms.get(roomId);
                if (!room) return;
                const channelId = uuidv4().replace(/-/g, '');
                channels.set(channelId, {
                    hostClientId: room.host.clientId,
                    hostWs: room.host.ws,
                    memberWs: ws
                });
                // 通知主机建立到游戏服务器的连接
                room.host.ws.send(JSON.stringify({
                    type: 'open_channel', channelId, fromId: clientId
                }));
                // 告知成员通道已建立
                ws.send(JSON.stringify({ type: 'channel_ready', channelId }));
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

    ws.on('close', () => {
        clearInterval(pingInterval);
        handleLeave(clientId);
    });
});

function handleLeave(clientId) {
    const roomId = clientRoom.get(clientId);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const isHost = room.host.clientId === clientId;
    if (isHost) {
        // 主机离开，解散房间
        broadcastJson(roomId, { type: 'room_closed' }, clientId);
        room.members.forEach((_, id) => clientRoom.delete(id));
        rooms.delete(roomId);
        console.log(`房间解散: ${roomId}`);
    } else {
        const member = room.members.get(clientId);
        room.members.delete(clientId);
        clientRoom.delete(clientId);
        broadcastJson(roomId, { type: 'member_left', id: clientId, name: member?.name });
    }
    clientRoom.delete(clientId);
}

server.listen(PORT, () => {
    console.log(`syqVPN 中继服务器启动，端口 ${PORT}`);
});
