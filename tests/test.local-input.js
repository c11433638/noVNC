import UI from '../app/ui.js';
import KeyTable from '../core/input/keysym.js';
import keysyms from '../core/input/keysymdef.js';

describe('Local input method', function () {
    let clock;
    let input;
    let preedit;
    let keyboardButton;
    let previousRfb;
    let previousSameOrigin;
    let fetchStub;
    let sends;

    beforeEach(function () {
        clock = sinon.useFakeTimers();
        previousRfb = UI.rfb;
        previousSameOrigin = UI.sameOriginConnection;
        UI.sameOriginConnection = false;
        UI.pacedTextPending = null;
        fetchStub = null;
        sends = [];
        UI.rfb = {
            sendKey: (keysym, code, down) => sends.push([keysym, code, down, Date.now()]),
            pasteText: sinon.stub().returns(false),
        };
        UI.pacedKeys = [];
        UI.pacedKeysTimer = null;
        UI.imeComposing = false;
        UI.imeCommitTimer = null;
        input = document.createElement('textarea');
        input.id = 'noVNC_keyboardinput';
        preedit = document.createElement('div');
        preedit.id = 'noVNC_ime_preedit';
        keyboardButton = document.createElement('button');
        keyboardButton.id = 'noVNC_keyboard_button';
        document.body.append(input, preedit, keyboardButton);
        UI.keyboardinputReset();
        sinon.stub(UI, 'getSetting').callThrough();
        UI.getSetting.withArgs('ime_clipboard').returns(false);
        sinon.stub(UI, 'imeInputActive').returns(true);
        sinon.stub(UI, 'idleControlbar');
    });

    afterEach(function () {
        UI.rfb = previousRfb;
        UI.sameOriginConnection = previousSameOrigin;
        UI.pacedTextPending = null;
        if (fetchStub) fetchStub.restore();
        UI.pacedKeys = [];
        UI.pacedKeysTimer = null;
        UI.imeComposing = false;
        UI.imeCommitTimer = null;
        UI.imeInputActive.restore();
        UI.getSetting.restore();
        UI.idleControlbar.restore();
        input.remove();
        preedit.remove();
        keyboardButton.remove();
        clock.restore();
    });

    function insert(text) {
        input.value += text;
        UI.keyInput({ target: input, isComposing: false });
    }

    function sentKeysyms() {
        return sends.map(event => event[0]);
    }

    function symbols(text) {
        return [...text].map(ch => keysyms.lookup(ch.codePointAt(0)));
    }

    it('should pace a whole committed phrase and keep Enter after it', function () {
        UI.rfb.pasteText.returns(true);
        insert('你好世界');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        UI.keyEvent(KeyTable.XK_Return, 'Enter', false);

        expect(sentKeysyms()).to.deep.equal(symbols('你'));
        clock.tick(UI.pacedKeyDelay * 4);

        expect(sentKeysyms()).to.deep.equal([
            ...symbols('你好世界'), KeyTable.XK_Return, KeyTable.XK_Return,
        ]);
        expect(sends.slice(0, 4).map(event => event[3])).to.deep.equal([
            0, UI.pacedKeyDelay, UI.pacedKeyDelay * 2, UI.pacedKeyDelay * 3,
        ]);
        expect(UI.rfb.pasteText).to.not.have.been.called;
    });

    it('should type mixed Unicode commits without using an available clipboard', function () {
        UI.rfb.pasteText.returns(true);
        insert('你好😀abc');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        clock.tick(UI.pacedKeyDelay * 3);

        expect(sentKeysyms()).to.deep.equal([...symbols('你好😀abc'), KeyTable.XK_Return]);
        expect(UI.rfb.pasteText).to.not.have.been.called;
    });

    it('should wait for clipboard-free gateway input before sending Enter', async function () {
        UI.sameOriginConnection = true;
        let complete;
        fetchStub = sinon.stub(window, 'fetch').returns(new Promise((resolve) => { complete = resolve; }));
        insert('你好😀');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        expect(sends).to.be.empty;
        expect(JSON.parse(fetchStub.firstCall.args[1].body)).to.deep.equal({ text: '你好😀' });
        complete({ ok: true, status: 200, json: async () => ({ typed: true }) });
        await UI.pacedTextPending;
        await Promise.resolve();
        expect(sentKeysyms()).to.deep.equal([KeyTable.XK_Return]);
        expect(UI.rfb.pasteText).to.not.have.been.called;
    });

    it('should fall back to Unicode keys when the gateway lacks text input', async function () {
        UI.sameOriginConnection = true;
        fetchStub = sinon.stub(window, 'fetch').resolves({ ok: false, status: 501 });
        insert('你好');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        await UI.pacedTextPending;
        await Promise.resolve();
        clock.tick(UI.pacedKeyDelay * 2);
        expect(sentKeysyms()).to.deep.equal([...symbols('你好'), KeyTable.XK_Return]);
        expect(UI.rfb.pasteText).to.not.have.been.called;
    });

    it('should not replay possibly delivered text after a gateway error', async function () {
        UI.sameOriginConnection = true;
        fetchStub = sinon.stub(window, 'fetch').rejects(new Error('Connection lost'));
        const status = sinon.stub(UI, 'showStatus');
        try {
            insert('你好');
            UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
            await UI.pacedTextPending.catch(() => {});
            await Promise.resolve();
            expect(sends).to.be.empty;
            expect(UI.pacedKeys).to.be.empty;
            expect(status).to.have.been.calledOnce;
        } finally {
            status.restore();
        }
    });

    it('should ignore local input in view-only mode', function () {
        UI.sameOriginConnection = true;
        UI.rfb.viewOnly = true;
        fetchStub = sinon.stub(window, 'fetch');
        insert('中文');
        expect(fetchStub).to.not.have.been.called;
        expect(sends).to.be.empty;
        expect(UI.rfb.pasteText).to.not.have.been.called;
    });

    it('should paste complete Unicode commits and serialize the following key', function () {
        UI.getSetting.withArgs('ime_clipboard').returns(true);
        UI.rfb.pasteText.returns(true);
        insert('你好😀');
        insert('世界');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);

        expect(UI.rfb.pasteText).to.have.been.calledOnceWithExactly('你好😀');
        expect(sends).to.be.empty;
        clock.tick(UI.textPasteDelay);
        expect(UI.rfb.pasteText).to.have.been.calledWithExactly('世界');
        expect(sends).to.be.empty;
        clock.tick(UI.textPasteDelay);
        expect(sentKeysyms()).to.deep.equal([KeyTable.XK_Return]);
    });

    it('should combine consecutive queued commits without crossing editing keys', function () {
        UI.getSetting.withArgs('ime_clipboard').returns(true);
        UI.rfb.pasteText.returns(true);
        insert('你');
        insert('好');
        insert('世界');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        insert('下一行');
        clock.tick(UI.textPasteDelay * 3);

        expect(UI.rfb.pasteText.args).to.deep.equal([['你'], ['好世界'], ['下一行']]);
        expect(sentKeysyms()).to.deep.equal([KeyTable.XK_Return]);
    });

    it('should fall back to paced Unicode when clipboard compatibility is unavailable', function () {
        UI.getSetting.withArgs('ime_clipboard').returns(true);
        insert('你好😀');
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        clock.tick(UI.pacedKeyDelay * 3);

        expect(UI.rfb.pasteText).to.have.been.calledOnceWithExactly('你好😀');
        expect(sentKeysyms()).to.deep.equal([...symbols('你好😀'), KeyTable.XK_Return]);
    });

    it('should honor disabling compatibility for text queued behind a paste', function () {
        UI.getSetting.withArgs('ime_clipboard').returns(true);
        UI.rfb.pasteText.returns(true);
        insert('你');
        insert('好😀');
        UI.getSetting.withArgs('ime_clipboard').returns(false);
        clock.tick(UI.textPasteDelay + UI.pacedKeyDelay * 2);

        expect(UI.rfb.pasteText).to.have.been.calledOnceWithExactly('你');
        expect(sentKeysyms()).to.deep.equal(symbols('好😀'));
    });

    it('should keep the interval between separately committed characters', function () {
        insert('你');
        clock.tick(5);
        insert('好');

        expect(sentKeysyms()).to.deep.equal(symbols('你'));
        clock.tick(UI.pacedKeyDelay - 5);
        expect(sentKeysyms()).to.deep.equal(symbols('你好'));
    });

    it('should ignore preedit even when input lacks isComposing', function () {
        const baseline = input.value;
        UI.imeCompositionStart({ target: input, data: '' });
        input.value += 'nihao';
        UI.keyInput({ target: input });
        UI.keyEvent(KeyTable.XK_Return, 'Enter', false);

        expect(UI.lastKeyboardinput).to.equal(baseline);
        expect(sentKeysyms()).to.deep.equal([KeyTable.XK_Return]);
        input.value = baseline + '你好';
        UI.imeCompositionEnd({ target: input });
        UI.keyInput({ target: input, isComposing: false });
        clock.tick(UI.pacedKeyDelay * 2);

        expect(sentKeysyms()).to.deep.equal([KeyTable.XK_Return, ...symbols('你好')]);
    });

    for (const finalInputBeforeEnd of [true, false]) {
        it(`should commit once when final input ${finalInputBeforeEnd ? 'precedes' : 'follows'} compositionend`, function () {
            const baseline = input.value;
            UI.imeCompositionStart({ target: input, data: '' });
            input.value += 'ni';
            UI.keyInput({ target: input, isComposing: true });
            if (finalInputBeforeEnd) {
                input.value = baseline + '你好';
                UI.keyInput({ target: input, isComposing: false });
            }
            UI.imeCompositionEnd({ target: input });
            if (!finalInputBeforeEnd) {
                input.value = baseline + '你好';
                UI.keyInput({ target: input, isComposing: false });
            }
            clock.tick(UI.pacedKeyDelay * 3);

            expect(sentKeysyms()).to.deep.equal(symbols('你好'));
        });
    }

    it('should send a composition without a final input event before the next key', function () {
        UI.imeCompositionStart({ target: input, data: '' });
        input.value += '你好';
        UI.imeCompositionEnd({ target: input });
        UI.keyEvent(KeyTable.XK_Return, 'Enter', true);
        clock.tick(UI.pacedKeyDelay * 2);

        expect(sentKeysyms()).to.deep.equal([...symbols('你好'), KeyTable.XK_Return]);
    });

    it('should cancel composition without deleting remote text', function () {
        const baseline = input.value;
        UI.imeCompositionStart({ target: input, data: '' });
        input.value += 'nihao';
        UI.keyInput({ target: input, isComposing: true });
        input.value = baseline;
        UI.imeCompositionEnd({ target: input, data: '' });
        clock.tick(1);

        expect(sends).to.be.empty;
    });

    it('should replace an emoji without splitting its surrogate pair', function () {
        insert('😀');
        clock.tick(UI.pacedKeyDelay);
        input.value = input.value.slice(0, -2) + '😃';
        UI.keyInput({ target: input });
        clock.tick(UI.pacedKeyDelay);

        expect(sentKeysyms()).to.deep.equal([
            ...symbols('😀'), KeyTable.XK_BackSpace, ...symbols('😃'),
        ]);
    });

    it('should keep toolbar keys behind queued text', function () {
        insert('中文');
        UI.sendKey(KeyTable.XK_Tab, 'Tab');
        clock.tick(UI.pacedKeyDelay * 2);

        expect(sentKeysyms()).to.deep.equal([...symbols('中文'), KeyTable.XK_Tab]);
    });
});
