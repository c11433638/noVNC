import * as BrowserSession from '../app/browser-session.js';
import UI from '../app/ui.js';
import RFB from '../core/rfb.js';
import Websock from '../core/websock.js';

describe('Remember browser login', function () {
    const challenge = Uint8Array.from({ length: 16 }, (_, i) => i);
    const response = RFB.genDES('filetest', Array.from(challenge));
    let fetchStub;
    let previousRfb;
    let previousUI;

    beforeEach(function () {
        previousRfb = UI.rfb;
        previousUI = { connected: UI.connected, inhibitReconnect: UI.inhibitReconnect,
                       reconnectPassword: UI.reconnectPassword, fileTransfer: UI.fileTransfer,
                       rememberPendingPassword: UI.rememberPendingPassword,
                       browserLoginTask: UI.browserLoginTask };
        UI.rfb = { sendCredentials: sinon.spy() };
        UI.sameOriginConnection = true;
        UI.sessionRequest = null;
        fetchStub = sinon.stub(window, 'fetch').resolves({
            ok: true,
            json: async () => ({ response: Array.from(response) }),
        });
        sinon.stub(UI, 'showCredentials');
    });

    afterEach(function () {
        UI.rfb = previousRfb;
        Object.assign(UI, previousUI);
        UI.sameOriginConnection = false;
        UI.sessionRequest = null;
        UI.showCredentials.restore();
        fetchStub.restore();
    });

    it('should automatically answer a challenge using the browser session', async function () {
        await UI.credentials({ detail: { types: ['password'], challenge } });
        expect(UI.rfb.sendCredentials).to.have.been.calledOnce;
        expect(UI.rfb.sendCredentials.firstCall.args[0]).to.deep.equal({ vncResponse: response });
        expect(UI.showCredentials).to.not.have.been.called;
        const [url, options] = fetchStub.firstCall.args;
        expect(url.pathname).to.match(/\/api\/files\/vnc-response$/);
        expect(options.credentials).to.equal('same-origin');
        expect(options.cache).to.equal('no-store');
        expect(JSON.parse(options.body)).to.deep.equal({ challenge: Array.from(challenge) });
    });

    it('should ask for a password when the session is absent or expired', async function () {
        fetchStub.resolves({ ok: false, status: 401 });
        await UI.credentials({ detail: { types: ['password'], challenge } });
        expect(UI.showCredentials).to.have.been.calledOnce;
        expect(UI.rfb.sendCredentials).to.not.have.been.called;
    });

    it('should preserve password login when the gateway cannot be reached', async function () {
        fetchStub.rejects(new Error('unavailable'));
        await UI.credentials({ detail: { types: ['password'], challenge } });
        expect(UI.showCredentials).to.have.been.calledOnce;
    });

    it('should reject malformed challenge responses and show the password dialog', async function () {
        for (const value of [null, [0], Array(16).fill(256), Array(16).fill(1.5)]) {
            fetchStub.resolves({ ok: true, json: async () => ({ response: value }) });
            await UI.credentials({ detail: { types: ['password'], challenge } });
        }
        expect(UI.showCredentials).to.have.callCount(4);
        expect(UI.rfb.sendCredentials).to.not.have.been.called;
    });

    it('should keep other servers and authentication methods on their password flow', async function () {
        await UI.credentials({ detail: { types: ['username', 'password'] } });
        UI.sameOriginConnection = false;
        await UI.credentials({ detail: { types: ['password'], challenge } });
        expect(fetchStub).to.not.have.been.called;
        expect(UI.showCredentials).to.have.been.calledTwice;
    });

    it('should ignore a response after disconnecting or starting another connection', async function () {
        let resolveRequest;
        fetchStub.returns(new Promise((resolve) => { resolveRequest = resolve; }));
        const previous = UI.rfb;
        const task = UI.credentials({ detail: { types: ['password'], challenge } });
        UI.rfb = { sendCredentials: sinon.spy() };
        resolveRequest({ ok: true, json: async () => ({ response: Array.from(response) }) });
        await task;
        expect(previous.sendCredentials).to.not.have.been.called;
        expect(UI.rfb.sendCredentials).to.not.have.been.called;
        expect(UI.showCredentials).to.not.have.been.called;
    });

    it('should request one response when the same challenge event is repeated', async function () {
        let resolveRequest;
        fetchStub.returns(new Promise((resolve) => { resolveRequest = resolve; }));
        const event = { detail: { types: ['password'], challenge } };
        const task = UI.credentials(event);
        await UI.credentials(event);
        expect(fetchStub).to.have.been.calledOnce;
        resolveRequest({ ok: true, json: async () => ({ response: Array.from(response) }) });
        await task;
        expect(UI.rfb.sendCredentials).to.have.been.calledOnce;
    });

    it('should submit a password only to establish the remembered session', async function () {
        await BrowserSession.remember('filetest');
        const [url, options] = fetchStub.firstCall.args;
        expect(url.pathname).to.match(/\/api\/files\/browser-session$/);
        expect(JSON.parse(options.body)).to.deep.equal({ password: 'filetest' });
    });

    it('should revoke the remembered session through the gateway', async function () {
        await BrowserSession.forget();
        expect(fetchStub.firstCall.args[0].pathname).to.match(/\/api\/files\/forget-browser$/);
    });

    it('should respect the remember checkbox when submitting a password', function () {
        const input = { value: 'filetest' };
        const checkbox = { checked: false };
        const block = { classList: { contains: () => false } };
        const dialog = { classList: { remove() {} } };
        const elements = { 'noVNC_password_input': input,
                           'noVNC_username_input': { value: '' },
                           'noVNC_remember_browser': checkbox,
                           'noVNC_remember_browser_block': block,
                           'noVNC_credentials_dlg': dialog };
        const lookup = sinon.stub(document, 'getElementById').callsFake(id => elements[id]);
        try {
            UI.setCredentials({ preventDefault() {} });
            expect(UI.rememberPendingPassword).to.equal(null);
            expect(input.value).to.equal('');
            input.value = 'filetest';
            checkbox.checked = true;
            UI.setCredentials({ preventDefault() {} });
            expect(UI.rememberPendingPassword).to.equal('filetest');
            expect(input.value).to.equal('');
            expect(fetchStub).to.not.have.been.called;
        } finally {
            lookup.restore();
        }
    });

    it('should establish the browser session only after the desktop connection succeeds', async function () {
        const methods = ['getSetting', 'showStatus', 'updateVisualState', 'updateBeforeUnload', 'updateImeInput'];
        methods.forEach(method => sinon.stub(UI, method));
        try {
            UI.rememberPendingPassword = 'filetest';
            UI.connectFinished({});
            await UI.browserLoginTask;
            expect(fetchStub).to.have.been.calledOnce;
            expect(UI.rememberPendingPassword).to.equal(null);
            fetchStub.resetHistory();
            UI.connectFinished({});
            expect(fetchStub).to.not.have.been.called;
        } finally {
            methods.forEach(method => UI[method].restore());
        }
    });

    it('should clear the password used for automatic reconnection when forgetting login', async function () {
        UI.reconnectPassword = 'filetest';
        UI.rememberPendingPassword = 'filetest';
        UI.browserLoginTask = null;
        UI.fileTransfer = { _autoPassword: true };
        sinon.stub(UI, 'showStatus');
        try {
            await UI.forgetBrowser();
            expect(UI.reconnectPassword).to.equal(null);
            expect(UI.rememberPendingPassword).to.equal(null);
            expect(UI.fileTransfer._autoPassword).to.equal(false);
        } finally {
            UI.showStatus.restore();
        }
    });

    it('should consume the buffered challenge and send a gateway response', function () {
        const client = Object.create(RFB.prototype);
        const sock = new Websock();
        sock.init();
        sock._rQ.set(challenge);
        sock._rQlen = challenge.length;
        client._sock = sock;
        client._rfbCredentials = { vncResponse: response };
        expect(client._negotiateStdVNCAuth()).to.equal(true);
        expect(sock._rQi).to.equal(16);
        expect(Array.from(sock._sQ.subarray(0, sock._sQlen))).to.deep.equal(Array.from(response));
        expect(client._rfbInitState).to.equal('SecurityResult');
        expect(client._rfbCredentials.vncResponse).to.equal(undefined);
    });

    it('should preserve classic VNC password authentication', function () {
        const client = Object.create(RFB.prototype);
        const sock = new Websock();
        sock.init();
        sock._rQ.set(challenge);
        sock._rQlen = challenge.length;
        client._sock = sock;
        client._rfbCredentials = { password: 'filetest' };
        expect(client._negotiateStdVNCAuth()).to.equal(true);
        expect(Array.from(sock._sQ.subarray(0, sock._sQlen))).to.deep.equal(Array.from(response));
    });
});
