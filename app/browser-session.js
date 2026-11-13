/*
 * noVNC: remember browser authentication without storing the VNC password
 * Licensed under MPL 2.0 (see LICENSE.txt)
 */

async function request(endpoint, data) {
    const response = await fetch(new URL('api/files/' + endpoint, window.location.href), {
        method: 'POST',
        headers: { 'X-NoVNC-Transfer': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Browser session request failed: ' + response.status);
    return await response.json();
}

export async function remember(password) {
    await request('browser-session', { password });
}

export async function respond(challenge) {
    const data = await request('vnc-response', { challenge: Array.from(challenge) });
    if (!Array.isArray(data.response) || data.response.length !== 16 ||
        data.response.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error('Invalid VNC authentication response');
    }
    return new Uint8Array(data.response);
}

export async function forget() {
    await request('forget-browser', {});
}

// Committed text normally travels over one standing WebSocket, which spares
// every phrase the cost of a new request. HTTP remains the fallback, and
// also signs in the session the socket needs.
const SOCKET_RETRY = 30000;
const SOCKET_PING = 25000;
const SOCKET_REPLY = 8000;
let socket = null;
let socketOpen = false;
let socketPing = null;
let socketFailed = 0;
let socketHeard = 0;
let socketNext = 1;
const socketPending = new Map();

function closeSocket() {
    const current = socket;
    socket = null;
    socketOpen = false;
    clearInterval(socketPing);
    for (const settle of socketPending.values()) settle(null);
    socketPending.clear();
    if (current) {
        current.onopen = current.onmessage = current.onclose = current.onerror = null;
        try {
            current.close();
        } catch (err) { /* Already closed. */ }
    }
}

function openSocket() {
    if (socket || typeof WebSocket === 'undefined' ||
        Date.now() - socketFailed < SOCKET_RETRY) {
        return;
    }
    const url = new URL('api/files/input-socket', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let current;
    try {
        current = new WebSocket(url);
    } catch (err) {
        socketFailed = Date.now();
        return;
    }
    current.binaryType = 'arraybuffer';
    socket = current;
    current.onopen = () => {
        socketOpen = true;
        socketHeard = Date.now();
        socketPing = setInterval(() => {
            // A connection that stopped answering is dropped by a proxy
            if (Date.now() - socketHeard > 2 * SOCKET_PING + SOCKET_REPLY) {
                closeSocket();
                return;
            }
            current.send(new TextEncoder().encode('{"ping":true}'));
        }, SOCKET_PING);
    };
    current.onmessage = (event) => {
        socketHeard = Date.now();
        let data;
        try {
            data = JSON.parse(new TextDecoder().decode(event.data));
        } catch (err) {
            return;
        }
        const settle = socketPending.get(data.id);
        if (settle) {
            socketPending.delete(data.id);
            settle(data);
        }
    };
    current.onclose = current.onerror = () => {
        if (!socketOpen) socketFailed = Date.now();
        if (socket === current) closeSocket();
    };
}

// Resolves to the gateway's reply, or null when the connection was lost
// and it is unknown whether the text was typed.
function sendBySocket(text) {
    return new Promise((resolve) => {
        const id = socketNext++;
        const timer = setTimeout(() => {
            socketPending.delete(id);
            closeSocket();
            resolve(null);
        }, SOCKET_REPLY);
        socketPending.set(id, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
        try {
            socket.send(new TextEncoder().encode(JSON.stringify({ id, text })));
        } catch (err) {
            socketPending.delete(id);
            clearTimeout(timer);
            closeSocket();
            // Nothing left this browser: safe to use the fallback
            resolve({ unsent: true });
        }
    });
}

// Reuse the gateway's existing VNC authentication for local desktop input.
// Unsupported gateways can fall back before any text has been entered.
export async function typeText(text, password) {
    const send = async (endpoint, data) => await fetch(new URL('api/files/' + endpoint, window.location.href), {
        method: 'POST',
        headers: { 'X-NoVNC-Transfer': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
    });
    const characters = [...text];
    for (let offset = 0; offset < characters.length; offset += 128) {
        const data = { text: characters.slice(offset, offset + 128).join('') };
        if (socketOpen) {
            const reply = await sendBySocket(data.text);
            if (reply && reply.typed === true) continue;
            if (reply && reply.error === 'text_input_unavailable' && offset === 0) return false;
            if (!reply || !reply.unsent) throw new Error('Text input delivery failed');
        }
        let response = await send('input-text', data);
        if (response.status === 401 && typeof password === 'string') {
            const login = await send('session', { password });
            if (!login.ok) throw new Error('Text input authentication failed');
            response = await send('input-text', data);
        }
        if (offset === 0 && [401, 404, 501].includes(response.status)) return false;
        if (!response.ok || (await response.json()).typed !== true) {
            throw new Error('Text input delivery failed');
        }
        // The session is signed in now, so the socket can follow
        socketFailed = 0;
        openSocket();
    }
    return true;
}
