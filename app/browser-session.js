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
