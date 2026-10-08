import UI from '../app/ui.js';
import KeyTable from '../core/input/keysym.js';
import keysyms from '../core/input/keysymdef.js';

describe('Local input method', function () {
    let clock;
    let input;
    let preedit;
    let keyboardButton;
    let previousRfb;
    let sends;

    beforeEach(function () {
        clock = sinon.useFakeTimers();
        previousRfb = UI.rfb;
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
        sinon.stub(UI, 'imeInputActive').returns(true);
        sinon.stub(UI, 'idleControlbar');
    });

    afterEach(function () {
        UI.rfb = previousRfb;
        UI.pacedKeys = [];
        UI.pacedKeysTimer = null;
        UI.imeComposing = false;
        UI.imeCommitTimer = null;
        UI.imeInputActive.restore();
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
    });

    it('should paste complete Unicode commits and serialize the following key', function () {
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
