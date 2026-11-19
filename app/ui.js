/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import * as Log from '../core/util/logging.js';
import _, { l10n } from './localization.js';
import { isTouchDevice, isMac, isIOS, isAndroid, isChromeOS, isSafari,
         hasScrollbarGutter, dragThreshold, browserAsyncClipboardSupport }
    from '../core/util/browser.js';
import { setCapture, getPointerEvent } from '../core/util/events.js';
import KeyTable from "../core/input/keysym.js";
import keysyms from "../core/input/keysymdef.js";
import Keyboard from "../core/input/keyboard.js";
import RFB from "../core/rfb.js";
import WakeLockManager from './wakelock.js';
import FileTransfer, { sizeLabel } from './file-transfer.js';
import * as BrowserSession from './browser-session.js';
import * as WebUtil from "./webutil.js";

const PAGE_TITLE = "noVNC";
const CLIPBOARD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_CACHED_CLIPBOARD_BYTES = 16 * 1024 * 1024;

const FALLBACK_TIMEOUT = 4000;
const RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const LOW_BANDWIDTH_SIZE = { w: 1600, h: 900 };

const LINGUAS = ["cs", "de", "el", "es", "fr", "hr", "hu", "it", "ja", "ko", "nl", "pl", "pt_BR", "ru", "sv", "tr", "uk", "zh_CN", "zh_TW"];

const UI = {

    customSettings: {},

    connected: false,
    desktopName: "",

    statusTimeout: null,
    hideKeyboardTimeout: null,
    idleControlbarTimeout: null,
    closeControlbarTimeout: null,

    controlbarGrabbed: false,
    controlbarDrag: false,
    controlbarToggledAt: 0,
    controlbarMouseDownClientX: 0,
    controlbarMouseDownOffsetX: 0,
    controlbarMouseDownClientY: 0,
    controlbarMouseDownOffsetY: 0,

    lastKeyboardinput: null,
    lastTouchY: null,
    smallTouchScreen: false,
    fullViewport: { w: 0, h: 0 },
    fitWindowsTimer: null,
    phoneWindowsFitted: false,
    mobileKeyboardOpen: false,
    minPhoneDesktopSide: 600,
    mobileKeys: {
        esc: [KeyTable.XK_Escape, 'Escape'],
        tab: [KeyTable.XK_Tab, 'Tab'],
        left: [KeyTable.XK_Left, 'ArrowLeft'],
        down: [KeyTable.XK_Down, 'ArrowDown'],
        up: [KeyTable.XK_Up, 'ArrowUp'],
        right: [KeyTable.XK_Right, 'ArrowRight'],
        home: [KeyTable.XK_Home, 'Home'],
        end: [KeyTable.XK_End, 'End'],
        pgup: [KeyTable.XK_Page_Up, 'PageUp'],
        pgdn: [KeyTable.XK_Page_Down, 'PageDown'],
        del: [KeyTable.XK_Delete, 'Delete'],
    },
    mobileStickyKeys: {
        ctrl: [KeyTable.XK_Control_L, 'ControlLeft'],
        alt: [KeyTable.XK_Alt_L, 'AltLeft'],
        shift: [KeyTable.XK_Shift_L, 'ShiftLeft'],
    },
    defaultKeyboardinputLen: 100,
    imeComposing: false,
    imeCommitTimer: null,

    pacedKeys: [],
    pacedKeysTimer: null,
    pacedTextPending: null,
    pacedKeyDelay: 50,
    textPasteDelay: 500,
    textInputRevision: 0,

    inhibitReconnect: true,
    reconnectCallback: null,
    reconnectPassword: null,
    reconnectAttempts: 0,
    connectionTimeout: null,
    connectionTimedOut: false,
    fallbackURL: null,
    connectionStartedAt: null,
    firstFrameMs: null,
    sameOriginConnection: false,
    clipboardWatchRevision: 0,
    clipboardNoticeTimer: null,
    localImageBaseline: null,
    localImagePublished: null,
    localImageSync: null,
    localImageSend: null,
    localImageRevision: 0,
    remoteCopiedSinceConnect: false,
    pasteKeyHeld: false,
    pendingPaste: null,
    pendingPasteTimer: null,
    uploadedClipboardFiles: null,
    remoteFilesAt: 0,
    remotePathHold: null,
    encryptedConnection: false,
    rememberPendingPassword: null,
    sessionRequest: null,
    browserLoginTask: null,

    wakeLockManager: new WakeLockManager(),

    async start(options={}) {
        UI.customSettings = options.settings || {};
        if (UI.customSettings.defaults === undefined) {
            UI.customSettings.defaults = {};
        }
        if (UI.customSettings.mandatory === undefined) {
            UI.customSettings.mandatory = {};
        }

        // A phone cannot show a desktop-sized screen legibly. Unless the
        // user chose otherwise, let the desktop follow the phone's screen
        // instead, somewhat enlarged so applications still have room.
        UI.smallTouchScreen = isTouchDevice &&
            Math.min(window.screen.width, window.screen.height) <= 600;
        if (UI.smallTouchScreen) {
            const defaults = UI.customSettings.defaults;
            defaults['remote_scale'] = String(defaults.mobile_remote_scale || '1.5');
        }

        // Set up translations
        try {
            await l10n.setup(LINGUAS, "app/locale/", '20261119c');
        } catch (err) {
            Log.Error("Failed to load translations: " + err);
        }

        // Initialize setting storage
        await WebUtil.initSettings();

        // Wait for the page to load
        if (document.readyState !== "interactive" && document.readyState !== "complete") {
            await new Promise((resolve, reject) => {
                document.addEventListener('DOMContentLoaded', resolve);
            });
        }

        UI.initSettings();

        // Translate the DOM
        l10n.translateDOM();

        // We rely on modern APIs which might not be available in an
        // insecure context
        if (!window.isSecureContext) {
            // FIXME: This gets hidden when connecting
            UI.showStatus(_("Running without HTTPS is not recommended, crashes or other issues are likely."), 'error');
        }

        // Try to fetch version number
        try {
            let response = await fetch('./package.json');
            if (!response.ok) {
                throw Error("" + response.status + " " + response.statusText);
            }

            let packageInfo = await response.json();
            Array.from(document.getElementsByClassName('noVNC_version')).forEach(el => el.innerText = packageInfo.version);
        } catch (err) {
            Log.Error("Couldn't fetch package.json: " + err);
            Array.from(document.getElementsByClassName('noVNC_version_wrapper'))
                .concat(Array.from(document.getElementsByClassName('noVNC_version_separator')))
                .forEach(el => el.style.display = 'none');
        }

        // Adapt the interface for touch screen devices
        if (isTouchDevice) {
            // Remove the address bar
            setTimeout(() => window.scrollTo(0, 1), 100);
        }

        // Restore control bar position
        const savedPos = WebUtil.readSetting('controlbar_pos');
        // Keep the primary controls reachable on narrow touch screens.
        const pos = isTouchDevice && window.innerWidth <= 700 ? 'bottom' : savedPos;
        if (['left', 'right', 'top', 'bottom'].includes(pos)) {
            UI.toggleControlbarSide(pos);
        } else {
            UI.toggleControlbarSide('left');
        }

        UI.initFullscreen();

        // Setup event handlers
        UI.addControlbarHandlers();
        UI.addTouchSpecificHandlers();
        UI.addImeInputHandlers();
        UI.addExtraKeysHandlers();
        UI.addMachineHandlers();
        UI.addConnectionControlHandlers();
        UI.addClipboardHandlers();
        UI.addFileTransferHandlers();
        UI.addMobileHandlers();
        UI.addSettingsHandlers();
        document.getElementById("noVNC_status")
            .addEventListener('click', UI.hideStatus);

        // Bootstrap fallback input handler
        UI.keyboardinputReset();

        UI.openControlbar();

        UI.updateVisualState('init');

        document.documentElement.classList.remove("noVNC_loading");

        let autoconnect = UI.getSetting('autoconnect');
        if (autoconnect === 'true' || autoconnect == '1') {
            UI.connect();
        } else {
            // Show the connect panel on first load unless autoconnecting
            UI.openConnectPanel();
        }
    },

    initFullscreen() {
        // Only show the button if fullscreen is properly supported
        // * Safari doesn't support alphanumerical input while in fullscreen
        if (!isSafari() &&
            (document.documentElement.requestFullscreen ||
             document.documentElement.mozRequestFullScreen ||
             document.documentElement.webkitRequestFullscreen ||
             document.body.msRequestFullscreen)) {
            document.getElementById('noVNC_fullscreen_button')
                .classList.remove("noVNC_hidden");
            UI.addFullscreenHandlers();
        }
    },

    initSettings() {
        // Logging selection dropdown
        const llevels = ['error', 'warn', 'info', 'debug'];
        for (let i = 0; i < llevels.length; i += 1) {
            UI.addOption(document.getElementById('noVNC_setting_logging'), llevels[i], llevels[i]);
        }

        // Settings with immediate effects
        UI.initSetting('logging', 'warn');
        UI.updateLogging();

        UI.setupSettingLabels();

        /* Populate the controls if defaults are provided in the URL */
        UI.initSetting('host', '');
        UI.initSetting('port', 0);
        UI.initSetting('encrypt', (window.location.protocol === "https:"));
        UI.initSetting('password');
        UI.initSetting('autoconnect', false);
        UI.initSetting('view_clip', false);
        UI.initSetting('resize', 'remote');
        UI.initSetting('remote_scale', '1');
        UI.initSetting('device_mode', 'auto');
        UI.initSetting('phone_local_scale', false);
        UI.initSetting('quality', 6);
        UI.initSetting('compression', 2);
        UI.initSetting('fast_mode', false);
        UI.initSetting('low_bandwidth', false);
        UI.initSetting('dynamic_quality', true);
        UI.updateFastMode();
        UI.initSetting('shared', true);
        UI.initSetting('bell', 'on');
        UI.initSetting('view_only', false);
        UI.initSetting('ime_input', true);
        UI.initSetting('ime_clipboard', false);
        UI.initSetting('mac_shortcuts', true);
        // Fingers are too coarse to point with on a phone or tablet
        UI.initSetting('touch_mode', isTouchDevice &&
                       (UI.smallTouchScreen || isIOS() || isAndroid()) ? 'touchpad' : 'direct');
        UI.initSetting('wheel_reverse', false);
        UI.initSetting('wheel_speed', '1');
        UI.initSetting('show_dot', false);
        UI.initSetting('path', 'websockify');
        UI.initSetting('repeaterID', '');
        UI.initSetting('reconnect', false);
        UI.initSetting('reconnect_delay', RECONNECT_DELAY);
        UI.initSetting('keep_device_awake', false);
    },
    // Adds a link to the label elements on the corresponding input elements
    setupSettingLabels() {
        const labels = document.getElementsByTagName('LABEL');
        for (let i = 0; i < labels.length; i++) {
            const htmlFor = labels[i].htmlFor;
            if (htmlFor != '') {
                const elem = document.getElementById(htmlFor);
                if (elem) elem.label = labels[i];
            } else {
                // If 'for' isn't set, use the first input element child
                const children = labels[i].children;
                for (let j = 0; j < children.length; j++) {
                    if (children[j].form !== undefined) {
                        children[j].label = labels[i];
                        break;
                    }
                }
            }
        }
    },

/* ------^-------
*     /INIT
* ==============
* EVENT HANDLERS
* ------v------*/

    addControlbarHandlers() {
        document.getElementById("noVNC_control_bar")
            .addEventListener('mousemove', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('mouseup', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('mousedown', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('keydown', UI.activateControlbar);

        document.getElementById("noVNC_control_bar")
            .addEventListener('mousedown', UI.keepControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('keydown', UI.keepControlbar);

        // Opening the bar slides its buttons under the pointer, so a second
        // click or tap right after the handle would hit a button by mistake
        for (const type of ['mousedown', 'touchstart', 'click']) {
            document.getElementById("noVNC_control_bar")
                .addEventListener(type, UI.swallowControlbarMistap,
                                  { capture: true, passive: false });
        }

        document.getElementById("noVNC_view_drag_button")
            .addEventListener('click', UI.toggleViewDrag);

        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mousedown', UI.controlbarHandleMouseDown);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mouseup', UI.controlbarHandleMouseUp);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('mousemove', UI.dragControlbarHandle);
        // resize events aren't available for elements
        window.addEventListener('resize', UI.updateControlbarHandle);

        const exps = document.getElementsByClassName("noVNC_expander");
        for (let i = 0;i < exps.length;i++) {
            exps[i].addEventListener('click', UI.toggleExpander);
        }
    },

    // Phones and tablets: a row of keys the on-screen keyboard lacks, shown
    // right above it, and a view that stays put while the keyboard is open.
    addMobileHandlers() {
        UI.applyDeviceMode();
        // Before the session notices a resize: the keyboard handling may
        // keep its size as it is
        window.addEventListener('resize', () => {
            UI.updateMobileKeyboard();
            UI.applyResizeMode();
            if (UI.phoneDesktop()) UI.fitRemoteWindows();
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && UI.connected) UI.fitRemoteWindows();
        });

        const bar = document.getElementById('noVNC_mobile_keys');
        // Tapping a key must not take the focus from the text field,
        // which would close the on-screen keyboard
        bar.addEventListener('mousedown', e => e.preventDefault());
        bar.addEventListener('click', UI.mobileKeyClick);

        // Remember where the user last touched the screen: usually where
        // they are about to type
        document.getElementById('noVNC_container')
            .addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) UI.lastTouchY = e.touches[0].clientY;
            }, { capture: true, passive: true });

        const input = document.getElementById('noVNC_keyboardinput');
        const update = () => setTimeout(UI.updateMobileKeyboard, 0);
        input.addEventListener('focus', update);
        input.addEventListener('blur', update);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', UI.updateMobileKeyboard);
            window.visualViewport.addEventListener('scroll', UI.updateMobileKeyboard);
        }
    },

    // The on-screen keyboard covers the lower part of the page without
    // resizing it. Leave the session as it is and move the view instead.
    updateMobileKeyboard() {
        const bar = document.getElementById('noVNC_mobile_keys');
        const container = document.getElementById('noVNC_container');
        const viewport = window.visualViewport;
        const focused = UI.virtualKeyboardActive();

        // Some browsers shrink the page for the keyboard, others only the
        // visible part of it. Remember the height without a keyboard so
        // both look the same from here on.
        const full = UI.fullViewport;
        if (full.w !== window.innerWidth) {
            full.w = window.innerWidth;
            full.h = window.innerHeight;
        } else if (!focused || window.innerHeight > full.h) {
            full.h = window.innerHeight;
        }

        let visibleBottom = window.innerHeight;
        if (viewport && Math.abs(viewport.scale - 1) < 0.01) {
            visibleBottom = Math.min(visibleBottom,
                                     viewport.offsetTop + viewport.height);
        }
        const covered = Math.max(0, full.h - visibleBottom);
        const open = focused && UI.connected && covered > 80;

        // Keep the session at its full size while the page is squeezed
        container.style.height = open && window.innerHeight < full.h ?
            full.h + 'px' : '';

        bar.classList.toggle('noVNC_open', open);
        if (open) bar.style.top = (visibleBottom - bar.offsetHeight) + 'px';
        if (UI.rfb) {
            UI.rfb.setViewInset(open ? covered + bar.offsetHeight : 0,
                                open && !UI.mobileKeyboardOpen ? UI.lastTouchY : null);
        }
        if (!open && UI.mobileKeyboardOpen) {
            UI.releaseStickyKeys();
            if (focused) UI.hideVirtualKeyboard();
        }
        UI.mobileKeyboardOpen = open;
    },

    mobileKeyClick(event) {
        const button = event.target.closest('button');
        if (!button || !UI.rfb) return;
        const name = button.dataset.key;

        if (name === 'hide') {
            UI.hideVirtualKeyboard();
            return;
        }
        if (name in UI.mobileStickyKeys) {
            // Held until the next key, e.g. Ctrl then C
            const [keysym, code] = UI.mobileStickyKeys[name];
            const held = button.classList.toggle('noVNC_selected');
            UI.sendKeyPaced(keysym, code, held);
            return;
        }
        if (name in UI.mobileKeys) {
            const [keysym, code] = UI.mobileKeys[name];
            UI.sendKeyPaced(keysym, code, true);
            UI.sendKeyPaced(keysym, code, false);
            UI.releaseStickyKeys();
        }
    },

    releaseStickyKeys() {
        for (const button of document.querySelectorAll('#noVNC_mobile_keys .noVNC_selected')) {
            button.classList.remove('noVNC_selected');
            const [keysym, code] = UI.mobileStickyKeys[button.dataset.key];
            UI.sendKeyPaced(keysym, code, false);
        }
    },

    addTouchSpecificHandlers() {
        document.getElementById("noVNC_keyboard_button")
            .addEventListener('click', UI.toggleVirtualKeyboard);
        document.getElementById('noVNC_floating_keyboard')
            ?.addEventListener('click', UI.openFloatingKeyboard);

        UI.touchKeyboard = new Keyboard(document.getElementById('noVNC_keyboardinput'));
        UI.updateMacShortcuts();
        UI.touchKeyboard.onkeyevent = UI.keyEvent;
        UI.touchKeyboard.grab();
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('input', UI.keyInput);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('focus', UI.onKeyboardInputFocus);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('blur', UI.onKeyboardInputBlur);
        document.getElementById("noVNC_keyboardinput")
            .addEventListener('submit', () => false);

        document.documentElement
            .addEventListener('mousedown', UI.keepVirtualKeyboard, true);

        document.getElementById("noVNC_control_bar")
            .addEventListener('touchstart', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('touchmove', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('touchend', UI.activateControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('input', UI.activateControlbar);

        document.getElementById("noVNC_control_bar")
            .addEventListener('touchstart', UI.keepControlbar);
        document.getElementById("noVNC_control_bar")
            .addEventListener('input', UI.keepControlbar);

        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchstart', UI.controlbarHandleMouseDown);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchend', UI.controlbarHandleMouseUp);
        document.getElementById("noVNC_control_bar_handle")
            .addEventListener('touchmove', UI.dragControlbarHandle);
    },

    addImeInputHandlers() {
        const input = document.getElementById("noVNC_keyboardinput");
        input.addEventListener('compositionstart', UI.imeCompositionStart);
        input.addEventListener('compositionupdate', UI.imeCompositionUpdate);
        input.addEventListener('compositionend', UI.imeCompositionEnd);
        input.addEventListener('focus', UI.imeInputFocus);

        // Restore IME focus before the screen handles mouse or touch input.
        document.getElementById("noVNC_container")
            .addEventListener('pointerdown', UI.imeScreenPointerDown, true);
    },

    addExtraKeysHandlers() {
        document.getElementById("noVNC_toggle_extra_keys_button")
            .addEventListener('click', UI.toggleExtraKeys);
        document.getElementById("noVNC_toggle_ctrl_button")
            .addEventListener('click', UI.toggleCtrl);
        document.getElementById("noVNC_toggle_windows_button")
            .addEventListener('click', UI.toggleWindows);
        document.getElementById("noVNC_toggle_alt_button")
            .addEventListener('click', UI.toggleAlt);
        document.getElementById("noVNC_send_tab_button")
            .addEventListener('click', UI.sendTab);
        document.getElementById("noVNC_send_esc_button")
            .addEventListener('click', UI.sendEsc);
        document.getElementById("noVNC_send_ctrl_alt_del_button")
            .addEventListener('click', UI.sendCtrlAltDel);
    },

    addMachineHandlers() {
        document.getElementById("noVNC_shutdown_button")
            .addEventListener('click', () => UI.rfb.machineShutdown());
        document.getElementById("noVNC_reboot_button")
            .addEventListener('click', () => UI.rfb.machineReboot());
        document.getElementById("noVNC_reset_button")
            .addEventListener('click', () => UI.rfb.machineReset());
        document.getElementById("noVNC_power_button")
            .addEventListener('click', UI.togglePowerPanel);
    },

    addConnectionControlHandlers() {
        document.getElementById("noVNC_disconnect_button")
            .addEventListener('click', UI.disconnect);
        document.getElementById("noVNC_connect_button")
            .addEventListener('click', UI.connect);
        document.getElementById("noVNC_cancel_reconnect_button")
            .addEventListener('click', UI.cancelReconnect);

        document.getElementById("noVNC_approve_server_button")
            .addEventListener('click', UI.approveServer);
        document.getElementById("noVNC_reject_server_button")
            .addEventListener('click', UI.rejectServer);
        document.getElementById("noVNC_credentials_button")
            .addEventListener('click', UI.setCredentials);
        document.getElementById("noVNC_forget_browser")
            .addEventListener('click', UI.forgetBrowser);
    },

    addClipboardHandlers() {
        document.getElementById("noVNC_clipboard_button")
            .addEventListener('click', UI.toggleClipboardPanel);
        document.getElementById("noVNC_clipboard_text")
            .addEventListener('change', UI.clipboardSend);
        document.getElementById('noVNC_clipboard').addEventListener('paste', (e) => {
            if (!UI.canTransferClipboardFiles()) return;
            const data = e.clipboardData;
            if (!data?.files.length && !Array.from(data?.types || []).includes('Files')) return;
            e.preventDefault();
            const files = Array.from(data.files);
            if (files.length) UI.clipboardUpload(files);
        });
        document.getElementById('noVNC_clipboard_file_input').addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            e.target.value = '';
            if (!files.length || !UI.canTransferClipboardFiles()) return;
            const rfb = UI.rfb;
            UI.closeClipboardPanel();
            UI.pasteLocalFiles(files, 0).then(sent => sent && UI.pasteRemote(rfb));
        });
        document.getElementById('noVNC_clipboard_notice_close')
            .addEventListener('click', UI.hideClipboardNotice);
        window.addEventListener('keydown', UI.handlePasteKeyDown, true);
        window.addEventListener('keyup', UI.handlePasteKeyUp, true);
        window.addEventListener('paste', UI.handleDesktopPaste, true);
        window.addEventListener('blur', () => {
            UI.pasteKeyHeld = false;
        });
        document.getElementById('noVNC_clipboard_read_files').addEventListener('click', () => {
            if (!UI.canTransferClipboardFiles()) return;
            UI.openFilesPanel(false);
            UI.fileTransfer.readClipboard();
        });
    },

    // Add a call to save settings when the element changes,
    // unless the optional parameter changeFunc is used instead.
    addSettingChangeHandler(name, changeFunc) {
        const settingElem = document.getElementById("noVNC_setting_" + name);
        if (changeFunc === undefined) {
            changeFunc = () => UI.saveSetting(name);
        }
        settingElem.addEventListener('change', changeFunc);
    },

    addSettingsHandlers() {
        document.getElementById("noVNC_settings_button")
            .addEventListener('click', UI.toggleSettingsPanel);

        UI.addSettingChangeHandler('encrypt');
        UI.addSettingChangeHandler('resize');
        UI.addSettingChangeHandler('resize', UI.applyResizeMode);
        UI.addSettingChangeHandler('resize', UI.fitRemoteWindows);
        UI.addSettingChangeHandler('resize', () => { if (UI.rfb) UI.rfb.resetViewZoom(); });
        UI.addSettingChangeHandler('device_mode');
        UI.addSettingChangeHandler('device_mode', UI.applyDeviceMode);
        UI.addSettingChangeHandler('phone_local_scale');
        UI.addSettingChangeHandler('phone_local_scale', UI.applyDeviceMode);
        UI.addSettingChangeHandler('remote_scale');
        UI.addSettingChangeHandler('remote_scale', UI.applyResizeMode);
        UI.addSettingChangeHandler('quality');
        UI.addSettingChangeHandler('quality', UI.updateQuality);
        UI.addSettingChangeHandler('compression');
        UI.addSettingChangeHandler('compression', UI.updateCompression);
        UI.addSettingChangeHandler('fast_mode');
        UI.addSettingChangeHandler('fast_mode', UI.updateFastMode);
        UI.addSettingChangeHandler('fast_mode', UI.applyResizeMode);
        UI.addSettingChangeHandler('low_bandwidth');
        UI.addSettingChangeHandler('low_bandwidth', UI.updateFastMode);
        UI.addSettingChangeHandler('low_bandwidth', UI.applyResizeMode);
        UI.addSettingChangeHandler('dynamic_quality');
        UI.addSettingChangeHandler('dynamic_quality', UI.updateDynamicQuality);
        UI.addSettingChangeHandler('view_clip');
        UI.addSettingChangeHandler('view_clip', UI.updateViewClip);
        UI.addSettingChangeHandler('shared');
        UI.addSettingChangeHandler('view_only');
        UI.addSettingChangeHandler('view_only', UI.updateViewOnly);
        UI.addSettingChangeHandler('ime_input');
        UI.addSettingChangeHandler('ime_input', UI.updateImeInput);
        UI.addSettingChangeHandler('ime_clipboard');
        UI.addSettingChangeHandler('mac_shortcuts');
        UI.addSettingChangeHandler('mac_shortcuts', UI.updateMacShortcuts);
        UI.addSettingChangeHandler('touch_mode');
        UI.addSettingChangeHandler('touch_mode', UI.updateTouchMode);
        UI.addSettingChangeHandler('wheel_reverse');
        UI.addSettingChangeHandler('wheel_reverse', UI.updateWheel);
        UI.addSettingChangeHandler('wheel_speed');
        UI.addSettingChangeHandler('wheel_speed', UI.updateWheel);
        UI.addSettingChangeHandler('show_dot');
        UI.addSettingChangeHandler('show_dot', UI.updateShowDotCursor);
        UI.addSettingChangeHandler('keep_device_awake');
        UI.addSettingChangeHandler('keep_device_awake', UI.updateRequestWakelock);
        UI.addSettingChangeHandler('host');
        UI.addSettingChangeHandler('port');
        UI.addSettingChangeHandler('path');
        UI.addSettingChangeHandler('repeaterID');
        UI.addSettingChangeHandler('logging');
        UI.addSettingChangeHandler('logging', UI.updateLogging);
        UI.addSettingChangeHandler('reconnect');
        UI.addSettingChangeHandler('reconnect_delay');
    },

    addFullscreenHandlers() {
        document.getElementById("noVNC_fullscreen_button")
            .addEventListener('click', UI.toggleFullscreen);

        window.addEventListener('fullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('mozfullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('webkitfullscreenchange', UI.updateFullscreenButton);
        window.addEventListener('msfullscreenchange', UI.updateFullscreenButton);
    },

/* ------^-------
 * /EVENT HANDLERS
 * ==============
 *     VISUAL
 * ------v------*/

    // Disable/enable controls depending on connection state
    updateVisualState(state) {

        document.documentElement.classList.remove("noVNC_connecting");
        document.documentElement.classList.remove("noVNC_connected");
        document.documentElement.classList.remove("noVNC_disconnecting");
        document.documentElement.classList.remove("noVNC_reconnecting");

        const transitionElem = document.getElementById("noVNC_transition_text");
        switch (state) {
            case 'init':
                break;
            case 'connecting':
                transitionElem.textContent = _("Connecting...");
                document.documentElement.classList.add("noVNC_connecting");
                break;
            case 'connected':
                document.documentElement.classList.add("noVNC_connected");
                break;
            case 'disconnecting':
                transitionElem.textContent = _("Disconnecting...");
                document.documentElement.classList.add("noVNC_disconnecting");
                break;
            case 'disconnected':
                break;
            case 'reconnecting':
                transitionElem.textContent = _("Reconnecting...");
                document.documentElement.classList.add("noVNC_reconnecting");
                break;
            default:
                Log.Error("Invalid visual state: " + state);
                UI.showStatus(_("Internal error"), 'error');
                return;
        }

        if (UI.connected) {
            UI.updateViewClip();

            UI.disableSetting('encrypt');
            UI.disableSetting('shared');
            UI.disableSetting('host');
            UI.disableSetting('port');
            UI.disableSetting('path');
            UI.disableSetting('repeaterID');

            // Hide the controlbar after 2 seconds
            UI.closeControlbarTimeout = setTimeout(UI.closeControlbar, 2000);
        } else {
            UI.enableSetting('encrypt');
            UI.enableSetting('shared');
            UI.enableSetting('host');
            UI.enableSetting('port');
            UI.enableSetting('path');
            UI.enableSetting('repeaterID');
            UI.updatePowerButton();
            UI.keepControlbar();
        }

        // State change closes dialogs as they may not be relevant
        // anymore
        UI.closeAllPanels();
        document.getElementById('noVNC_verify_server_dlg')
            .classList.remove('noVNC_open');
        document.getElementById('noVNC_credentials_dlg')
            .classList.remove('noVNC_open');
    },

    showStatus(text, statusType, time) {
        const statusElem = document.getElementById('noVNC_status');

        if (typeof statusType === 'undefined') {
            statusType = 'normal';
        }

        // Don't overwrite more severe visible statuses and never
        // errors. Only shows the first error.
        if (statusElem.classList.contains("noVNC_open")) {
            if (statusElem.classList.contains("noVNC_status_error")) {
                return;
            }
            if (statusElem.classList.contains("noVNC_status_warn") &&
                statusType === 'normal') {
                return;
            }
        }

        clearTimeout(UI.statusTimeout);

        switch (statusType) {
            case 'error':
                statusElem.classList.remove("noVNC_status_warn");
                statusElem.classList.remove("noVNC_status_normal");
                statusElem.classList.add("noVNC_status_error");
                break;
            case 'warning':
            case 'warn':
                statusElem.classList.remove("noVNC_status_error");
                statusElem.classList.remove("noVNC_status_normal");
                statusElem.classList.add("noVNC_status_warn");
                break;
            case 'normal':
            case 'info':
            default:
                statusElem.classList.remove("noVNC_status_error");
                statusElem.classList.remove("noVNC_status_warn");
                statusElem.classList.add("noVNC_status_normal");
                break;
        }

        statusElem.textContent = text;
        statusElem.classList.add("noVNC_open");

        // If no time was specified, show the status for 1.5 seconds
        if (typeof time === 'undefined') {
            time = 1500;
        }

        // Error messages do not timeout
        if (statusType !== 'error') {
            UI.statusTimeout = window.setTimeout(UI.hideStatus, time);
        }
    },

    hideStatus() {
        clearTimeout(UI.statusTimeout);
        document.getElementById('noVNC_status').classList.remove("noVNC_open");
    },

    activateControlbar(event) {
        clearTimeout(UI.idleControlbarTimeout);
        // We manipulate the anchor instead of the actual control
        // bar in order to avoid creating new a stacking group
        document.getElementById('noVNC_control_bar_anchor')
            .classList.remove("noVNC_idle");
        UI.idleControlbarTimeout = window.setTimeout(UI.idleControlbar, 2000);
    },

    idleControlbar() {
        // Don't fade if a child of the control bar has focus
        if (document.getElementById('noVNC_control_bar')
            .contains(document.activeElement) && document.hasFocus()) {
            UI.activateControlbar();
            return;
        }

        document.getElementById('noVNC_control_bar_anchor')
            .classList.add("noVNC_idle");
    },

    keepControlbar() {
        clearTimeout(UI.closeControlbarTimeout);
    },

    openControlbar() {
        document.getElementById('noVNC_control_bar')
            .classList.add("noVNC_open");
    },

    closeControlbar() {
        UI.closeAllPanels();
        document.getElementById('noVNC_control_bar')
            .classList.remove("noVNC_open");
        UI.focusKeyboard();
    },

    toggleControlbar() {
        if (document.getElementById('noVNC_control_bar')
            .classList.contains("noVNC_open")) {
            UI.closeControlbar();
        } else {
            UI.openControlbar();
        }
    },

    getControlbarPos() {
        const anchor = document.getElementById('noVNC_control_bar_anchor');
        if (anchor.classList.contains('noVNC_right')) return 'right';
        if (anchor.classList.contains('noVNC_top')) return 'top';
        if (anchor.classList.contains('noVNC_bottom')) return 'bottom';
        return 'left';
    },

    toggleControlbarSide(pos) {
        // Temporarily disable animation, if bar is displayed, to avoid weird
        // movement. The transitionend-event will not fire when display=none.
        const bar = document.getElementById('noVNC_control_bar');
        const barDisplayStyle = window.getComputedStyle(bar).display;
        if (barDisplayStyle !== 'none') {
            bar.style.transitionDuration = '0s';
            bar.addEventListener('transitionend', () => bar.style.transitionDuration = '');
        }

        const anchor = document.getElementById('noVNC_control_bar_anchor');

        anchor.classList.remove('noVNC_right', 'noVNC_top', 'noVNC_bottom');
        if (['right', 'top', 'bottom'].includes(pos)) {
            anchor.classList.add(`noVNC_${pos}`);
        }
        WebUtil.writeSetting('controlbar_pos', pos);

        // Consider this a movement of the handle
        UI.controlbarDrag = true;

        // The user has "followed" hint, let's hide it until the next drag
        UI.showControlbarHint(false, false);
    },

    showControlbarHint(show, animate=true) {
        const getPos = element =>
            ['right', 'top', 'bottom'].find(pos =>
                element.classList.contains(`noVNC_${pos}`)
            ) ?? 'left';

        const anchor = document.getElementById('noVNC_control_bar_anchor');
        const anchorPos = getPos(anchor);

        document.querySelectorAll('.noVNC_control_bar_hint').forEach((hint) => {
            const hintPos = getPos(hint.parentElement);
            const shouldShow = show && (hintPos !== anchorPos);

            hint.classList.toggle('noVNC_active', shouldShow);
            hint.classList.toggle('noVNC_notransition', !animate || !shouldShow);
        });
    },

    dragControlbarHandle(e) {
        if (!UI.controlbarGrabbed) return;

        const ptr = getPointerEvent(e);

        let controlBarPos = UI.getControlbarPos();

        if (ptr.clientX < (window.innerWidth * 0.1) &&
            ptr.clientY > (window.innerHeight * 0.25) &&
            ptr.clientY < (window.innerHeight * 0.75)) {
            if (controlBarPos !== 'left') {
                UI.toggleControlbarSide('left');
                controlBarPos = 'left';
            }

        } else if (ptr.clientX > (window.innerWidth * 0.9) &&
                   ptr.clientY > (window.innerHeight * 0.25) &&
                   ptr.clientY < (window.innerHeight * 0.75)) {
            if (controlBarPos !== 'right') {
                UI.toggleControlbarSide('right');
                controlBarPos = 'right';
            }

        // Slightly increased height thresholds since 10% of the
        // height proved small in practice
        } else if (ptr.clientX > (window.innerWidth * 0.25) &&
                   ptr.clientX < (window.innerWidth * 0.75) &&
                   ptr.clientY < (window.innerHeight * 0.2)) {
            if (controlBarPos !== 'top') {
                UI.toggleControlbarSide('top');
                controlBarPos = 'top';
            }

        } else if (ptr.clientX > (window.innerWidth * 0.25) &&
                   ptr.clientX < (window.innerWidth * 0.75) &&
                   ptr.clientY > (window.innerHeight * 0.8)) {
            if (controlBarPos !== 'bottom') {
                UI.toggleControlbarSide("bottom");
                controlBarPos = 'bottom';
            }
        }

        const isVertical = controlBarPos === 'left' || controlBarPos === 'right';

        if (!UI.controlbarDrag) {
            const dragDistance = isVertical
                ? Math.abs(ptr.clientY - UI.controlbarMouseDownClientY)
                : Math.abs(ptr.clientX - UI.controlbarMouseDownClientX);

            if (dragDistance < dragThreshold) return;

            UI.controlbarDrag = true;
        }

        if (isVertical) {
            const eventY = ptr.clientY - UI.controlbarMouseDownOffsetY;
            UI.moveControlbarHandle(eventY, true);
        } else {
            const eventX = ptr.clientX - UI.controlbarMouseDownOffsetX;
            UI.moveControlbarHandle(eventX, false);
        }

        e.preventDefault();
        e.stopPropagation();
        UI.keepControlbar();
        UI.activateControlbar();
    },

    // Move the handle but don't allow any position outside the bounds
    moveControlbarHandle(viewportRelativeCoord, isVertical) {
        const handle = document.getElementById("noVNC_control_bar_handle");

        const handleSpan = isVertical
            ? handle.getBoundingClientRect().height
            : handle.getBoundingClientRect().width;

        const controlbarBounds = document.getElementById("noVNC_control_bar")
            .getBoundingClientRect();
        const controlbarBoundsStart = isVertical
            ? controlbarBounds.top
            : controlbarBounds.left;
        const controlbarBoundsSpan  = isVertical
            ? controlbarBounds.height
            : controlbarBounds.width;

        const margin = 10;

        // These heights need to be non-zero for the below logic to work
        if (handleSpan === 0 || controlbarBoundsSpan === 0) {
            return;
        }

        let newCoord = viewportRelativeCoord;

        // Check if the coordinates are outside the control bar
        if (newCoord < controlbarBoundsStart + margin) {
            // Force coordinates to be below the start of the control bar
            newCoord = controlbarBoundsStart + margin;

        } else if (newCoord > controlbarBoundsStart +
                   controlbarBoundsSpan - handleSpan - margin) {
            // Force coordinates to be before the end of the control bar
            newCoord = controlbarBoundsStart +
                controlbarBoundsSpan - handleSpan - margin;
        }

        // Corner case: control bar too small for stable position
        if (controlbarBoundsSpan < (handleSpan + margin * 2)) {
            newCoord = controlbarBoundsStart +
                (controlbarBoundsSpan - handleSpan) / 2;
        }

        // The transform needs coordinates that are relative to the parent
        const parentRelativeCoord = newCoord - controlbarBoundsStart;
        if (isVertical) {
            handle.style.transform = "translateY(" + parentRelativeCoord + "px)";
        } else {
            handle.style.transform = "translateX(" + parentRelativeCoord + "px)";
        }
    },

    updateControlbarHandle() {
        // Since the control bar is fixed on the viewport and not the page,
        // the move function expects coordinates relative the the viewport.
        const handle = document.getElementById("noVNC_control_bar_handle");
        const handleBounds = handle.getBoundingClientRect();

        const controlBarPos = UI.getControlbarPos();
        const isVertical = controlBarPos === 'left' || controlBarPos === 'right';

        if (isVertical) {
            UI.moveControlbarHandle(handleBounds.top, true);
        } else {
            UI.moveControlbarHandle(handleBounds.left, false);
        }
    },

    controlbarHandleMouseUp(e) {
        if ((e.type == "mouseup") && (e.button != 0)) return;

        // mouseup and mousedown on the same place toggles the controlbar
        if (UI.controlbarGrabbed && !UI.controlbarDrag) {
            UI.toggleControlbar();
            UI.controlbarToggledAt = Date.now();
            e.preventDefault();
            e.stopPropagation();
            UI.keepControlbar();
            UI.activateControlbar();
        }
        UI.controlbarGrabbed = false;
        UI.showControlbarHint(false);
    },

    // Ignore presses on the bar's buttons while it is still sliding in or
    // out after the handle toggled it
    swallowControlbarMistap(e) {
        if (Date.now() - UI.controlbarToggledAt > 600) return;
        if (document.getElementById("noVNC_control_bar_handle")
            .contains(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    },

    controlbarHandleMouseDown(e) {
        if ((e.type == "mousedown") && (e.button != 0)) return;

        const ptr = getPointerEvent(e);

        const handle = document.getElementById("noVNC_control_bar_handle");
        const bounds = handle.getBoundingClientRect();

        // Touch events have implicit capture
        if (e.type === "mousedown") {
            setCapture(handle);
        }

        UI.controlbarGrabbed = true;
        UI.controlbarDrag = false;

        UI.showControlbarHint(true);

        UI.controlbarMouseDownClientY = ptr.clientY;
        UI.controlbarMouseDownOffsetY = ptr.clientY - bounds.top;
        UI.controlbarMouseDownClientX = ptr.clientX;
        UI.controlbarMouseDownOffsetX = ptr.clientX - bounds.left;
        e.preventDefault();
        e.stopPropagation();
        UI.keepControlbar();
        UI.activateControlbar();
    },

    toggleExpander(e) {
        if (this.classList.contains("noVNC_open")) {
            this.classList.remove("noVNC_open");
        } else {
            this.classList.add("noVNC_open");
        }
    },

/* ------^-------
 *    /VISUAL
 * ==============
 *    SETTINGS
 * ------v------*/

    // Initial page load read/initialization of settings
    initSetting(name, defVal) {
        // Has the user overridden the default value?
        if (name in UI.customSettings.defaults) {
            defVal = UI.customSettings.defaults[name];
        }
        // Check Query string followed by cookie
        let val = WebUtil.getConfigVar(name);
        if (val === null) {
            val = WebUtil.readSetting(name, defVal);
        }
        WebUtil.setSetting(name, val);
        UI.updateSetting(name);
        // Has the user forced a value?
        if (name in UI.customSettings.mandatory) {
            val = UI.customSettings.mandatory[name];
            UI.forceSetting(name, val);
        }
        return val;
    },

    // Set the new value, update and disable form control setting
    forceSetting(name, val) {
        WebUtil.setSetting(name, val);
        UI.updateSetting(name);
        UI.disableSetting(name);
    },

    // Update cookie and form control setting. If value is not set, then
    // updates from control to current cookie setting.
    updateSetting(name) {

        // Update the settings control
        let value = UI.getSetting(name);

        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl === null) {
            return;
        }

        if (ctrl.type === 'checkbox') {
            ctrl.checked = value;
        } else if (typeof ctrl.options !== 'undefined') {
            for (let i = 0; i < ctrl.options.length; i += 1) {
                if (ctrl.options[i].value === value) {
                    ctrl.selectedIndex = i;
                    break;
                }
            }
        } else {
            ctrl.value = value;
        }
    },

    // Save control setting to cookie
    saveSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        let val;
        if (ctrl.type === 'checkbox') {
            val = ctrl.checked;
        } else if (typeof ctrl.options !== 'undefined') {
            val = ctrl.options[ctrl.selectedIndex].value;
        } else {
            val = ctrl.value;
        }
        WebUtil.writeSetting(name, val);
        //Log.Debug("Setting saved '" + name + "=" + val + "'");
        return val;
    },

    // Read form control compatible setting from cookie
    getSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        let val = WebUtil.readSetting(name);
        if (typeof val !== 'undefined' && val !== null &&
            ctrl !== null && ctrl.type === 'checkbox') {
            if (val.toString().toLowerCase() in {'0': 1, 'no': 1, 'false': 1}) {
                val = false;
            } else {
                val = true;
            }
        }
        return val;
    },

    // These helpers compensate for the lack of parent-selectors and
    // previous-sibling-selectors in CSS which are needed when we want to
    // disable the labels that belong to disabled input elements.
    disableSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl !== null) {
            ctrl.disabled = true;
            if (ctrl.label !== undefined) {
                ctrl.label.classList.add('noVNC_disabled');
            }
        }
    },

    enableSetting(name) {
        const ctrl = document.getElementById('noVNC_setting_' + name);
        if (ctrl !== null) {
            ctrl.disabled = false;
            if (ctrl.label !== undefined) {
                ctrl.label.classList.remove('noVNC_disabled');
            }
        }
    },

/* ------^-------
 *   /SETTINGS
 * ==============
 *    PANELS
 * ------v------*/

    closeAllPanels() {
        UI.closeSettingsPanel();
        UI.closePowerPanel();
        UI.closeClipboardPanel();
        UI.closeFilesPanel();
        UI.closeExtraKeys();
    },

/* ------^-------
 *   /PANELS
 * ==============
 * SETTINGS (panel)
 * ------v------*/

    openSettingsPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        // Refresh UI elements from saved cookies
        UI.updateSetting('encrypt');
        UI.updateSetting('view_clip');
        UI.updateSetting('resize');
        UI.updateSetting('remote_scale');
        UI.updateSetting('device_mode');
        UI.updateSetting('phone_local_scale');
        UI.updateDeviceModeHint();
        UI.updateSetting('quality');
        UI.updateSetting('compression');
        UI.updateSetting('fast_mode');
        UI.updateSetting('low_bandwidth');
        UI.updateSetting('dynamic_quality');
        UI.updateFastMode();
        UI.updateSetting('shared');
        UI.updateSetting('view_only');
        UI.updateSetting('ime_clipboard');
        UI.updateSetting('mac_shortcuts');
        UI.updateSetting('touch_mode');
        UI.updateSetting('wheel_reverse');
        UI.updateSetting('wheel_speed');
        UI.updateSetting('path');
        UI.updateSetting('repeaterID');
        UI.updateSetting('logging');
        UI.updateSetting('reconnect');
        UI.updateSetting('reconnect_delay');

        document.getElementById('noVNC_settings')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_settings_button')
            .classList.add("noVNC_selected");
        UI.updateLine();
    },

    closeSettingsPanel() {
        document.getElementById('noVNC_settings')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_settings_button')
            .classList.remove("noVNC_selected");
        clearTimeout(UI.lineTimer);
    },

    toggleSettingsPanel() {
        if (document.getElementById('noVNC_settings')
            .classList.contains("noVNC_open")) {
            UI.closeSettingsPanel();
        } else {
            UI.openSettingsPanel();
        }
    },

/* ------^-------
 *   /SETTINGS
 * ==============
 *     POWER
 * ------v------*/

    openPowerPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_power')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_power_button')
            .classList.add("noVNC_selected");
    },

    closePowerPanel() {
        document.getElementById('noVNC_power')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_power_button')
            .classList.remove("noVNC_selected");
    },

    togglePowerPanel() {
        if (document.getElementById('noVNC_power')
            .classList.contains("noVNC_open")) {
            UI.closePowerPanel();
        } else {
            UI.openPowerPanel();
        }
    },

    // Disable/enable power button
    updatePowerButton() {
        if (UI.connected &&
            UI.rfb.capabilities.power &&
            !UI.rfb.viewOnly) {
            document.getElementById('noVNC_power_button')
                .classList.remove("noVNC_hidden");
        } else {
            document.getElementById('noVNC_power_button')
                .classList.add("noVNC_hidden");
            // Close power panel if open
            UI.closePowerPanel();
        }
    },

/* ------^-------
 *    /POWER
 * ==============
 *   CLIPBOARD
 * ------v------*/

    openClipboardPanel() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_clipboard')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_clipboard_button')
            .classList.add("noVNC_selected");
        if (!isTouchDevice) document.getElementById('noVNC_clipboard_text').focus();
    },

    closeClipboardPanel() {
        document.getElementById('noVNC_clipboard')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_clipboard_button')
            .classList.remove("noVNC_selected");
    },

    toggleClipboardPanel() {
        if (document.getElementById('noVNC_clipboard')
            .classList.contains("noVNC_open")) {
            UI.closeClipboardPanel();
        } else {
            UI.openClipboardPanel();
        }
    },

    clipboardReceive(e) {
        Log.Debug(">> UI.clipboardReceive: " + e.detail.text.substr(0, 40) + "...");
        document.getElementById('noVNC_clipboard_text').value = e.detail.text;
        // Plain HTTP pages have no automatic clipboard access
        if (e.detail.text && !navigator.clipboard?.writeText) {
            UI.showClipboardNotice(_('Text was copied on the remote computer.'), [{
                label: _('Copy to local clipboard'),
                action: UI.copyReceivedText,
            }]);
        }
        Log.Debug("<< UI.clipboardReceive");
    },

    clipboardSend() {
        const text = document.getElementById('noVNC_clipboard_text').value;
        Log.Debug(">> UI.clipboardSend: " + text.substr(0, 40) + "...");
        UI.rfb?.clipboardPasteFrom(text);
        Log.Debug("<< UI.clipboardSend");
    },

    copyReceivedText() {
        const text = document.getElementById('noVNC_clipboard_text');
        text.select();
        const copied = document.execCommand('copy');
        UI.showClipboardNotice(copied ? _('Copied to the local clipboard.') :
            _('The browser blocked clipboard access.'));
    },

    showClipboardNotice(message, actions = []) {
        clearTimeout(UI.clipboardNoticeTimer);
        document.getElementById('noVNC_clipboard_notice_text').textContent = message;
        const buttons = actions.map(({ label, action }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', () => {
                action();
                if (!isTouchDevice) UI.focusKeyboard();
            });
            return button;
        });
        document.getElementById('noVNC_clipboard_notice_actions').replaceChildren(...buttons);
        document.getElementById('noVNC_clipboard_notice').hidden = false;
        if (!actions.length) UI.clipboardNoticeTimer = setTimeout(UI.hideClipboardNotice, 5000);
    },

    hideClipboardNotice() {
        clearTimeout(UI.clipboardNoticeTimer);
        document.getElementById('noVNC_clipboard_notice').hidden = true;
    },

    // Runs for as long as this connection lasts. Each request returns when
    // the remote clipboard changes, or after a while without a change.
    async watchRemoteClipboard() {
        const revision = ++UI.clipboardWatchRevision;
        let since = '';
        let failures = 0;
        while (revision === UI.clipboardWatchRevision) {
            try {
                const state = await UI.fileTransfer.watchClipboard(since);
                if (revision !== UI.clipboardWatchRevision) return;
                since = state.token;
                failures = 0;
                if (state.changed && !UI.rfb?.viewOnly) UI.remoteClipboardChanged(state);
            } catch (err) {
                const delay = Math.min(60000, 2000 * 2 ** failures++);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    },

    canSyncLocalImage() {
        return UI.canTransferClipboardFiles() && !!navigator.clipboard?.read &&
               !!window.crypto?.subtle;
    },

    // The PNG on the local clipboard. Spreadsheets and word processors add
    // a picture of copied text, so those selections stay text. Apps that
    // copy a picture with a file name or placeholder as text stay images.
    async readLocalImage() {
        const items = await navigator.clipboard.read();
        const item = items.find(entry => entry.types.includes('image/png'));
        if (!item) return null;
        const text = item.types.includes('text/plain') ?
            await (await item.getType('text/plain')).text() : '';
        if (item.types.includes('text/html') && text.replace(/[\s\uFFFC]/g, '')) return null;
        // File managers can offer a copied file's icon along with its name
        const fileIcon = /^[^\r\n/\\]+\.\w{1,10}$/.test(text.trim());
        return { blob: await item.getType('image/png'), fileIcon };
    },

    async hashClipboardBlob(blob) {
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    },

    // Resolves true when the local clipboard holds an image, so that it
    // is not also sent as text. A paste key press may send an image copied
    // before this page opened. Focus alone only sends newly copied images.
    syncLocalImage(pasting = false) {
        if (!UI.canSyncLocalImage()) return Promise.resolve(false);
        if (UI.localImageSync) {
            return UI.localImageSync.then(result => (pasting ? UI.syncLocalImage(true) : result));
        }
        const task = UI.publishLocalImage(pasting).catch((err) => {
            Log.Warn("Local image sync failed: " + err);
            return false;
        }).finally(() => { UI.localImageSync = null; });
        UI.localImageSync = task;
        return task;
    },

    async publishLocalImage(pasting) {
        const rfb = UI.rfb;
        const revision = UI.localImageRevision;
        const image = await UI.readLocalImage();
        if (UI.rfb !== rfb || UI.localImageRevision !== revision) return true;
        if (!image) {
            UI.localImageBaseline ??= '';
            return false;
        }
        // A file manager may expose only the icon through the async API.
        if (image.fileIcon && !pasting) return true;
        const { blob } = image;
        const hash = await UI.hashClipboardBlob(blob);
        if (UI.rfb !== rfb || UI.localImageRevision !== revision) return true;
        const first = UI.localImageBaseline === null;
        if (first) UI.localImageBaseline = hash;
        const stale = hash === UI.localImageBaseline &&
                      (!pasting || UI.remoteCopiedSinceConnect);
        if (hash === UI.localImagePublished || stale) return true;

        if (await UI.queueLocalImage(blob, rfb)) UI.localImagePublished = hash;
        return true;
    },

    queueLocalImage(blob, rfb, name) {
        const task = Promise.resolve(UI.localImageSend)
            .then(() => UI.sendLocalImage(blob, rfb, name))
            .finally(() => {
                if (UI.localImageSend === task) UI.localImageSend = null;
            });
        UI.localImageSend = task;
        return task;
    },

    async sendLocalImage(blob, rfb, name) {
        if (UI.rfb !== rfb || !UI.canTransferClipboardFiles()) return false;
        rfb.preserveClipboardOnFocus();
        UI.showClipboardNotice(_('Sending the local image to the remote computer…'));
        try {
            await UI.fileTransfer.sendClipboardImage(blob, name);
            if (UI.rfb !== rfb) return false;
            UI.showClipboardNotice(_('The local image is on the remote clipboard.'));
            return true;
        } catch (err) {
            if (UI.rfb === rfb) {
                UI.showClipboardNotice(err.message, [{
                    label: _('Close'),
                    action: UI.hideClipboardNotice,
                }]);
            }
            return false;
        }
    },

    async pasteLocalImage(file) {
        const rfb = UI.rfb;
        // An earlier asynchronous clipboard read may still be waiting for
        // permission. Ignore its result in favor of the actual paste event.
        ++UI.localImageRevision;
        const sent = await UI.queueLocalImage(file, rfb, file.name);
        if (sent && file.type === 'image/png' && window.crypto?.subtle) {
            UI.hashClipboardBlob(file).then((hash) => {
                if (UI.rfb === rfb) UI.localImagePublished = hash;
            }).catch(() => {});
        }
        return sent;
    },

    handlePasteKeyDown(e) {
        if (e.code !== 'KeyV' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
        const onDesktop = e.target?.id === 'noVNC_keyboardinput' ||
                          e.target === document.querySelector('#noVNC_container canvas');
        if (!onDesktop || !UI.canTransferClipboardFiles()) return;
        // Only the browser's own paste action exposes copied files, so
        // the default action of this key press has to go ahead.
        e.stopImmediatePropagation();
        UI.pasteKeyHeld = true;
        if (e.repeat) {
            e.preventDefault();
            return;
        }

        const rfb = UI.rfb;
        const keysym = e.shiftKey ? KeyTable.XK_V : KeyTable.XK_v;
        UI.pendingPaste = () => UI.pasteRemote(rfb, keysym);
        clearTimeout(UI.pendingPasteTimer);
        UI.pendingPasteTimer = setTimeout(() => {
            const paste = UI.pendingPaste;
            UI.pendingPaste = null;
            if (paste) UI.syncLocalImage(true).finally(paste);
        }, 250);
    },

    pasteRemote(rfb, keysym = KeyTable.XK_v) {
        if (UI.rfb !== rfb || !UI.canTransferClipboardFiles()) return;
        // On Windows Ctrl may still be waiting for AltGr detection. A
        // transfer can also outlast the physical modifier press.
        const sendControl = !rfb.controlKeyDown;
        if (sendControl) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true);
        rfb.sendKey(keysym, 'KeyV', true);
        rfb.sendKey(keysym, 'KeyV', false);
        if (sendControl) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
    },

    handleDesktopPaste(e) {
        const paste = UI.pendingPaste;
        if (!paste) return;
        UI.pendingPaste = null;
        clearTimeout(UI.pendingPasteTimer);
        e.preventDefault();
        e.stopImmediatePropagation();

        const { files, folders } = UI.pastedFiles(e.clipboardData);
        if (!folders && files.length === 1 && CLIPBOARD_IMAGE_TYPES.has(files[0].type)) {
            const data = e.clipboardData;
            const richText = Array.from(data.types).includes('text/html') &&
                             data.getData('text/plain').replace(/[\s\uFFFC]/g, '');
            if (richText) paste();
            else UI.pasteLocalImage(files[0]).then(sent => sent && paste());
        } else if (files.length) {
            UI.pasteLocalFiles(files, folders).then(sent => sent && paste());
        } else if (folders) {
            UI.showClipboardNotice(_('Folders cannot be pasted. Compress the folder first.'));
        } else {
            UI.syncLocalImage(true).finally(paste);
        }
    },

    pastedFiles(data) {
        const files = [];
        let folders = 0;
        for (const item of data?.items || []) {
            if (item.kind !== 'file') continue;
            if (item.webkitGetAsEntry?.()?.isDirectory) {
                folders++;
                continue;
            }
            const file = item.getAsFile();
            if (file) files.push(file);
        }
        // Some browsers expose the files on DataTransfer.files only.
        if (!files.length && !folders) files.push(...Array.from(data?.files || []));
        return { files, folders };
    },

    async clipboardFilesKey(files) {
        const bytes = files.reduce((total, file) => total + file.size, 0);
        if (!window.crypto?.subtle || bytes > MAX_CACHED_CLIPBOARD_BYTES || files.length > 100) return null;
        try {
            const fingerprints = await Promise.all(files.map(async file => [file.name, await UI.hashClipboardBlob(file)]));
            return JSON.stringify(fingerprints);
        } catch (err) {
            return null;
        }
    },

    async pasteLocalFiles(files, folders) {
        const rfb = UI.rfb;
        const key = await UI.clipboardFilesKey(files);
        if (UI.rfb !== rfb || !UI.canTransferClipboardFiles()) return false;
        if (UI.fileTransfer.busy) {
            UI.showClipboardNotice(_('Another file transfer is still running.'));
            return false;
        }
        const previous = UI.uploadedClipboardFiles;
        let uploaded;
        if (key && previous?.key === key) {
            try {
                rfb.preserveClipboardOnFocus();
                await UI.fileTransfer.copyToClipboard(previous.files);
                uploaded = previous.files;
            } catch (err) {
                if (!['not_found', 'invalid_path', 'file_changed'].includes(err.code)) {
                    if (UI.rfb === rfb) UI.showClipboardNotice(err.message);
                    return false;
                }
            }
        }
        if (UI.rfb !== rfb) return false;
        if (!uploaded) {
            // On failure the file panel stays open and shows the reason.
            uploaded = await UI.clipboardUpload(files);
            if (!uploaded || UI.rfb !== rfb) return false;
            UI.uploadedClipboardFiles = key ? { key, files: uploaded } : null;
            UI.closeFilesPanel();
            UI.focusKeyboard();
        }
        UI.localImagePublished = null;
        UI.showClipboardNotice(folders ?
            _('Files sent. Folders were skipped, compress them first.') :
            _('The local files are on the remote clipboard.'));
        return true;
    },

    // File managers also offer copied files as text paths. Wait to learn
    // what was copied, so that the paths do not replace the local clipboard.
    holdRemotePaths(text) {
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (!lines.length || !lines.every(line => line.startsWith('/'))) return null;
        if (Date.now() - UI.remoteFilesAt < 3000) return Promise.resolve(false);
        return new Promise((resolve) => {
            UI.remotePathHold?.(true);
            const timer = setTimeout(() => UI.remotePathHold?.(true), 2500);
            UI.remotePathHold = (allowed) => {
                clearTimeout(timer);
                UI.remotePathHold = null;
                resolve(allowed);
            };
        });
    },

    handlePasteKeyUp(e) {
        if (e.code === 'KeyV' && UI.pasteKeyHeld) {
            UI.pasteKeyHeld = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    },

    remoteClipboardChanged(state) {
        // Selections published from this page need no announcement
        if (state.kind === 'none') return;
        UI.remoteCopiedSinceConnect = true;
        if (state.kind === 'files') UI.remoteFilesAt = Date.now();
        UI.remotePathHold?.(state.kind !== 'files');
        if (state.kind === 'image') UI.receiveRemoteImage();
        else if (state.kind === 'files') UI.receiveRemoteFiles(state);
        else if (navigator.clipboard?.writeText) UI.hideClipboardNotice();
    },

    async copyRemoteImage() {
        // Safari needs the write to start before the image has arrived
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': UI.fileTransfer.clipboardImage() })
        ]);
        UI.showClipboardNotice(_('The remote image is on the local clipboard.'));
        // Browsers re-encode images. Remember the result so that it is not
        // mistaken for a new local copy and sent back.
        const copied = await UI.readLocalImage().catch(() => null);
        if (copied) UI.localImagePublished = await UI.hashClipboardBlob(copied.blob);
    },

    async receiveRemoteImage() {
        const save = { label: _('Download'), action: () => UI.fileTransfer.saveClipboardImage() };
        const message = _('An image was copied on the remote computer.');
        if (!navigator.clipboard?.write || !window.ClipboardItem) {
            UI.showClipboardNotice(message, [save]);
            return;
        }
        const copy = {
            label: _('Copy to local clipboard'),
            action: () => UI.copyRemoteImage().catch(() => {
                UI.showClipboardNotice(_('The browser blocked clipboard access.'), [save]);
            }),
        };
        try {
            await UI.copyRemoteImage();
        } catch (err) {
            // Usually the page lacks focus. A click grants the access.
            UI.showClipboardNotice(message, [copy, save]);
        }
    },

    receiveRemoteFiles({ files, skipped }) {
        if (!files.length) {
            UI.showClipboardNotice(_('The copied items cannot be read on the remote computer.'),
                                   [{ label: _('Close'), action: UI.hideClipboardNotice }]);
            return;
        }
        const total = files.reduce((sum, file) => sum + file.size, 0);
        let message = files.length === 1 ? files[0].name :
            _('%s files were copied on the remote computer.').replace('%s', files.length);
        // The size of a folder is only known once it has been packed
        if (!files.some(file => file.folder)) message += ' · ' + sizeLabel(total);
        if (skipped) message += ' · ' + _('Some clipboard items could not be downloaded.');
        UI.showClipboardNotice(message, [{
            label: _('Download'),
            action: () => {
                UI.hideClipboardNotice();
                UI.fileTransfer.saveClipboardFiles(files);
            },
        }]);
    },

    canTransferClipboardFiles() {
        return UI.connected && UI.sameOriginConnection && UI.rfb?.viewOnly === false;
    },

    // Resolves true once the files are on the remote clipboard
    async clipboardUpload(files) {
        if (!UI.canTransferClipboardFiles() || !files.length) return null;
        UI.openFilesPanel(false);
        const rfb = UI.rfb;
        let published = null;
        await UI.fileTransfer.upload(files, {
            onUploaded: async (uploaded) => {
                if (UI.rfb !== rfb || !UI.canTransferClipboardFiles()) {
                    throw new Error(_('The remote connection changed. The uploaded files are in the transfer folder.'));
                }
                rfb.preserveClipboardOnFocus();
                await UI.fileTransfer.copyToClipboard(uploaded);
                published = uploaded;
            },
        });
        return published;
    },

    addFileTransferHandlers() {
        UI.fileTransfer = new FileTransfer(() => UI.reconnectPassword);
        document.getElementById('noVNC_files_button')
            .addEventListener('click', UI.toggleFilesPanel);

        // Files can be dropped anywhere on the page to upload them into
        // the folder currently shown in the file panel
        const overlay = document.getElementById('noVNC_drop_overlay');
        // Always claim file drags, also when they cannot be uploaded, so
        // the browser never navigates away from the session to open them
        const hasFiles = e => e.dataTransfer &&
                              Array.from(e.dataTransfer.types).includes('Files');
        let depth = 0;
        const hide = () => {
            depth = 0;
            overlay.classList.remove('noVNC_open');
        };
        window.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth++;
            if (UI.connected) overlay.classList.add('noVNC_open');
        });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect =
                UI.connected && !UI.fileTransfer.busy ? 'copy' : 'none';
        });
        window.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            if (--depth <= 0) hide();
        });
        window.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            hide();
            if (!UI.connected) return;
            // Folders cannot be read as files
            const files = Array.from(e.dataTransfer.items)
                .filter(item => item.kind === 'file' &&
                                !item.webkitGetAsEntry?.()?.isDirectory)
                .map(item => item.getAsFile())
                .filter(file => file !== null);
            if (!files.length || UI.fileTransfer.busy) return;
            UI.openFilesPanel(false);
            UI.fileTransfer.upload(files);
        });
    },

    closeFilesPanel() {
        document.getElementById('noVNC_files')?.classList.remove('noVNC_open');
        document.getElementById('noVNC_files_button')?.classList.remove('noVNC_selected');
    },

    toggleFilesPanel() {
        if (document.getElementById('noVNC_files').classList.contains('noVNC_open')) {
            UI.closeFilesPanel();
            return;
        }
        UI.openFilesPanel();
    },

    openFilesPanel(refresh = true) {
        UI.closeAllPanels();
        UI.openControlbar();
        document.getElementById('noVNC_files').classList.add('noVNC_open');
        document.getElementById('noVNC_files_button').classList.add('noVNC_selected');
        if (refresh) UI.fileTransfer.refresh();
    },

/* ------^-------
 *  /CLIPBOARD
 * ==============
 *  CONNECTION
 * ------v------*/

    openConnectPanel() {
        document.getElementById('noVNC_connect_dlg')
            .classList.add("noVNC_open");
    },

    closeConnectPanel() {
        document.getElementById('noVNC_connect_dlg')
            .classList.remove("noVNC_open");
    },

    connect(event, password, alternateURL = null) {

        // Ignore when rfb already exists
        if (typeof UI.rfb !== 'undefined') {
            return;
        }

        const host = UI.getSetting('host');
        const port = UI.getSetting('port');
        const path = UI.getSetting('path');
        UI.rememberPendingPassword = null;
        UI.sessionRequest = null;

        if (typeof password === 'undefined') {
            password = UI.getSetting('password');
            UI.reconnectPassword = password;
        }

        if (password === null) {
            password = undefined;
        }

        UI.hideStatus();

        UI.closeConnectPanel();

        UI.updateVisualState('connecting');

        let url;

        if (alternateURL) {
            url = alternateURL;
        } else if (host) {
            url = new URL("https://" + host);

            url.protocol = UI.getSetting('encrypt') ? 'wss:' : 'ws:';
            if (port) {
                url.port = port;
            }

            // "./" is needed to force URL() to interpret the path-variable as
            // a path and not as an URL. This is relevant if for example path
            // starts with more than one "/", in which case it would be
            // interpreted as a host name instead.
            url = new URL("./" + path, url);
        } else {
            // Current (May 2024) browsers support relative WebSocket
            // URLs natively, but we need to support older browsers for
            // some time.
            url = new URL(path, location.href);
            url.protocol = (window.location.protocol === "https:") ? 'wss:' : 'ws:';
        }

        if (!alternateURL) {
            UI.connectionStartedAt = performance.now();
            UI.firstFrameMs = null;
        }
        UI.fallbackURL = alternateURL ? null : UI.getFallbackURL(url);
        UI.connectionTimedOut = false;
        UI.encryptedConnection = url.protocol === 'wss:';
        UI.sameOriginConnection = url.host === window.location.host &&
            url.protocol === (window.location.protocol === 'https:' ? 'wss:' : 'ws:') &&
            (alternateURL !== null || url.pathname === new URL('websockify', window.location.href).pathname);

        UI.lineId = null;
        if (UI.sameOriginConnection) {
            UI.lineId = Array.from(window.crypto.getRandomValues(new Uint8Array(8)),
                                   b => b.toString(16).padStart(2, '0')).join('');
            url.searchParams.set('line', UI.lineId);
        }

        if (UI.getSetting('keep_device_awake')) {
            UI.wakeLockManager.acquire();
        }

        try {
            UI.rfb = new RFB(document.getElementById('noVNC_container'),
                             url.href,
                             { shared: UI.getSetting('shared'),
                               repeaterID: UI.getSetting('repeaterID'),
                               credentials: { password: password } });
        } catch (exc) {
            Log.Error("Failed to connect to server: " + exc);
            UI.disconnectFinished({ detail: { clean: false } });
            return;
        }

        UI.rfb.addEventListener("connect", UI.connectFinished);
        UI.rfb.addEventListener("firstframe", UI.firstFrame);
        UI.rfb.addEventListener("disconnect", UI.disconnectFinished);
        UI.rfb.addEventListener("serververification", UI.serverVerify);
        UI.rfb.addEventListener("credentialsrequired", UI.credentials);
        UI.rfb.addEventListener("securityfailure", UI.securityFailed);
        UI.rfb.addEventListener("clippingviewport", UI.updateViewDrag);
        UI.rfb.addEventListener("capabilities", UI.updatePowerButton);
        UI.rfb.addEventListener("clipboard", UI.clipboardReceive);
        UI.rfb.addEventListener("bell", UI.bell);
        UI.rfb.addEventListener("desktopname", UI.updateDesktopName);
        UI.rfb.addEventListener('textcursorchange', UI.updateFloatingKeyboard);
        UI.rfb.clipViewport = UI.getSetting('view_clip');
        UI.applyDeviceMode();
        UI.updateFastMode();
        UI.rfb.dynamicQuality = UI.getSetting('dynamic_quality');
        UI.rfb.showDotCursor = UI.getSetting('show_dot');
        UI.updateMacShortcuts();
        UI.updateWheel();
        UI.updateTouchMode();

        UI.updateViewOnly(); // requires UI.rfb
        UI.updateClipboard();

        if (UI.fallbackURL || alternateURL) {
            UI.connectionTimeout = setTimeout(() => {
                UI.connectionTimedOut = true;
                UI.rfb.disconnect();
            }, FALLBACK_TIMEOUT);
        }
    },

    getFallbackURL(primary) {
        // A deployment can opt into a second WebSocket endpoint for the same
        // session. Only use the operator's config, never a query parameter.
        const configured = UI.customSettings.mandatory.fallback_url ??
            UI.customSettings.defaults.fallback_url;
        if (!configured) return null;
        try {
            const alternate = new URL(configured, primary);
            if (alternate.protocol === primary.protocol && !alternate.username &&
                !alternate.password && !alternate.hash && alternate.href !== primary.href) {
                return alternate;
            }
        } catch (err) {
            Log.Warn("Invalid fallback WebSocket URL: " + err);
        }
        return null;
    },

    stopConnectionFallback() {
        clearTimeout(UI.connectionTimeout);
        UI.connectionTimeout = null;
        UI.fallbackURL = null;
    },

    disconnect() {
        UI.inhibitReconnect = true;
        UI.stopConnectionFallback();
        UI.connected = false;
        UI.updateVisualState('disconnecting');
        UI.rfb.disconnect();
    },

    reconnect() {
        UI.reconnectCallback = null;

        // if reconnect has been disabled in the meantime, do nothing.
        if (UI.inhibitReconnect || !UI.getSetting('reconnect')) {
            UI.cancelReconnect();
            return;
        }

        UI.connect(null, UI.reconnectPassword ?? null);
    },

    cancelReconnect() {
        UI.inhibitReconnect = true;
        UI.reconnectAttempts = 0;
        if (UI.reconnectCallback !== null) {
            clearTimeout(UI.reconnectCallback);
            UI.reconnectCallback = null;
        }

        UI.updateVisualState('disconnected');

        UI.openControlbar();
        UI.openConnectPanel();
    },

    connectFinished(e) {
        UI.stopConnectionFallback();
        UI.connected = true;
        UI.inhibitReconnect = false;
        UI.reconnectAttempts = 0;
        UI.updateLine();
        UI.fitRemoteWindows();

        let msg;
        if (UI.encryptedConnection) {
            msg = _("Connected (encrypted) to ") + UI.desktopName;
        } else {
            msg = _("Connected (unencrypted) to ") + UI.desktopName;
        }
        if (UI.phoneMode()) msg += " · " + _("Phone mode");
        UI.showStatus(msg);
        UI.updateVisualState('connected');

        UI.updateBeforeUnload();

        // Do this last because it can only be used on rendered elements
        UI.updateImeInput();
        UI.localImageBaseline = null;
        UI.remoteCopiedSinceConnect = false;
        UI.uploadedClipboardFiles = null;
        UI.rfb.beforeClipboardSync = () => UI.syncLocalImage();
        if (UI.sameOriginConnection) UI.rfb.clipboardWriteHold = UI.holdRemotePaths;
        if (UI.sameOriginConnection) UI.watchRemoteClipboard();
        const password = UI.rememberPendingPassword;
        UI.rememberPendingPassword = null;
        if (password !== null) {
            UI.browserLoginTask = BrowserSession.remember(password).catch(() => {
                UI.showStatus(_("Connected, but browser login could not be remembered."), 'warning');
            });
        }
    },

    firstFrame() {
        UI.firstFrameMs = Math.round(performance.now() - UI.connectionStartedAt);
        UI.updateLine();
    },

    disconnectFinished(e) {
        const wasConnected = UI.connected;

        // This variable is ideally set when disconnection starts, but
        // when the disconnection isn't clean or if it is initiated by
        // the server, we need to do it here as well since
        // UI.disconnect() won't be used in those cases.
        UI.connected = false;
        UI.clipboardWatchRevision++;
        UI.hideClipboardNotice();
        const alternateURL = UI.fallbackURL;
        UI.stopConnectionFallback();

        UI.rfb = undefined;
        UI.updateFloatingKeyboard();
        UI.rememberPendingPassword = null;
        UI.sessionRequest = null;
        clearTimeout(UI.pacedKeysTimer);
        UI.pacedKeysTimer = null;
        UI.pacedTextPending = null;
        UI.pacedKeys = [];
        clearTimeout(UI.imeCommitTimer);
        UI.imeCommitTimer = null;
        UI.imeComposing = false;
        UI.keyboardinputReset();
        UI.hideImePreedit();
        UI.wakeLockManager.release();
        UI.updateLine();

        if (alternateURL) {
            UI.connect(null, UI.reconnectPassword ?? null, alternateURL);
            UI.showStatus(_("Connecting through the backup endpoint…"));
            return;
        }

        const failed = UI.connectionTimedOut || !e.detail.clean;
        if (failed) {
            if (wasConnected) {
                UI.showStatus(_("Something went wrong, connection is closed"),
                              'error');
            } else {
                UI.showStatus(_("Failed to connect to server"), 'error');
            }
        }
        // If reconnecting is allowed process it now
        if (UI.getSetting('reconnect', false) === true && !UI.inhibitReconnect) {
            UI.updateVisualState('reconnecting');

            const configured = Number(UI.getSetting('reconnect_delay'));
            const initial = Number.isFinite(configured) && configured > 0 ?
                Math.min(Math.max(250, configured), 2147483647) : RECONNECT_DELAY;
            const delay = Math.min(initial * 2 ** UI.reconnectAttempts,
                                   Math.max(initial, MAX_RECONNECT_DELAY));
            UI.reconnectAttempts++;
            UI.reconnectCallback = setTimeout(UI.reconnect, delay);
            return;
        }

        UI.updateVisualState('disconnected');
        if (!failed) UI.showStatus(_("Disconnected"), 'normal');
        UI.updateBeforeUnload();

        document.title = PAGE_TITLE;

        UI.openControlbar();
        UI.openConnectPanel();
    },

    securityFailed(e) {
        UI.stopConnectionFallback();
        UI.inhibitReconnect = true;
        UI.reconnectAttempts = 0;
        UI.reconnectPassword = null;
        let msg;
        // On security failures we might get a string with a reason
        // directly from the server. Note that we can't control if
        // this string is translated or not.
        if ('reason' in e.detail) {
            msg = _("New connection has been rejected with reason: ") +
                e.detail.reason;
        } else {
            msg = _("New connection has been rejected");
        }
        UI.showStatus(msg, 'error');
    },

    handleBeforeUnload(e) {
        // Trigger a "Leave site?" warning prompt before closing the
        // page. Modern browsers (Oct 2025) accept either (or both)
        // preventDefault() or a nonempty returnValue, though the latter is
        // considered legacy. The custom string is ignored by modern browsers,
        // which display a native message, but older browsers will show it.
        e.preventDefault();
        e.returnValue = _("Are you sure you want to disconnect the session?");
    },

    updateBeforeUnload() {
        // Remove first to avoid adding duplicates
        window.removeEventListener("beforeunload", UI.handleBeforeUnload);
        if (!UI.rfb?.viewOnly && UI.connected) {
            window.addEventListener("beforeunload", UI.handleBeforeUnload);
        }
    },

/* ------^-------
 *  /CONNECTION
 * ==============
 * SERVER VERIFY
 * ------v------*/

    async serverVerify(e) {
        UI.stopConnectionFallback();
        const type = e.detail.type;
        if (type === 'RSA') {
            const publickey = e.detail.publickey;
            let fingerprint = await window.crypto.subtle.digest("SHA-1", publickey);
            // The same fingerprint format as RealVNC
            fingerprint = Array.from(new Uint8Array(fingerprint).slice(0, 8)).map(
                x => x.toString(16).padStart(2, '0')).join('-');
            document.getElementById('noVNC_verify_server_dlg').classList.add('noVNC_open');
            document.getElementById('noVNC_fingerprint').innerHTML = fingerprint;
        }
    },

    approveServer(e) {
        e.preventDefault();
        document.getElementById('noVNC_verify_server_dlg').classList.remove('noVNC_open');
        UI.rfb.approveServer();
    },

    rejectServer(e) {
        e.preventDefault();
        document.getElementById('noVNC_verify_server_dlg').classList.remove('noVNC_open');
        UI.disconnect();
    },

/* ------^-------
 * /SERVER VERIFY
 * ==============
 *   PASSWORD
 * ------v------*/

    async credentials(e) {
        UI.stopConnectionFallback();
        const rfb = UI.rfb;
        if (UI.sameOriginConnection && e.detail.challenge) {
            // The gateway answers the challenge using the HttpOnly cookie.
            // Do not send the password back to the browser on later visits.
            if (UI.sessionRequest === rfb) return;
            UI.sessionRequest = rfb;
            try {
                const response = await BrowserSession.respond(e.detail.challenge);
                if (UI.rfb !== rfb) return;
                rfb.sendCredentials({ vncResponse: response });
                return;
            } catch {
                if (UI.rfb !== rfb) return;
            } finally {
                if (UI.sessionRequest === rfb) UI.sessionRequest = null;
            }
        }
        UI.showCredentials(e);
    },

    showCredentials(e) {
        // FIXME: handle more types

        document.getElementById("noVNC_username_block").classList.remove("noVNC_hidden");
        document.getElementById("noVNC_password_block").classList.remove("noVNC_hidden");
        document.getElementById('noVNC_remember_browser_block')
            .classList.toggle('noVNC_hidden', !UI.sameOriginConnection || !e.detail.challenge);

        let inputFocus = "none";
        if (e.detail.types.indexOf("username") === -1) {
            document.getElementById("noVNC_username_block").classList.add("noVNC_hidden");
        } else if (document.getElementById("noVNC_username_input").value === "") {
            inputFocus = "noVNC_username_input";
        }
        if (e.detail.types.indexOf("password") === -1) {
            document.getElementById("noVNC_password_block").classList.add("noVNC_hidden");
        } else if (inputFocus === "none") {
            inputFocus = "noVNC_password_input";
        }
        document.getElementById('noVNC_credentials_dlg')
            .classList.add('noVNC_open');

        setTimeout(() => document
            .getElementById(inputFocus).focus(), 100);

        Log.Warn("Server asked for credentials");
        UI.showStatus(_("Credentials are required"), "warning");
    },

    setCredentials(e) {
        // Prevent actually submitting the form
        e.preventDefault();

        let inputElemUsername = document.getElementById('noVNC_username_input');
        const username = inputElemUsername.value;

        let inputElemPassword = document.getElementById('noVNC_password_input');
        const password = inputElemPassword.value;
        // Clear the input after reading the password
        inputElemPassword.value = "";

        UI.reconnectPassword = password;
        UI.rememberPendingPassword = UI.sameOriginConnection &&
            !document.getElementById('noVNC_remember_browser_block').classList.contains('noVNC_hidden') &&
            document.getElementById('noVNC_remember_browser').checked ? password : null;
        UI.rfb.sendCredentials({ username: username, password: password });
        document.getElementById('noVNC_credentials_dlg')
            .classList.remove('noVNC_open');
    },

    async forgetBrowser() {
        try {
            await UI.browserLoginTask;
            await BrowserSession.forget();
            UI.reconnectPassword = null;
            UI.rememberPendingPassword = null;
            UI.fileTransfer._autoPassword = false;
            UI.showStatus(_("Browser login forgotten. Enter your password next time."));
        } catch {
            UI.showStatus(_("Could not forget browser login. Please try again."), 'error');
        }
    },

/* ------^-------
 *  /PASSWORD
 * ==============
 *   FULLSCREEN
 * ------v------*/

    toggleFullscreen() {
        if (document.fullscreenElement || // alternative standard method
            document.mozFullScreenElement || // currently working methods
            document.webkitFullscreenElement ||
            document.msFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        } else {
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen();
            } else if (document.documentElement.mozRequestFullScreen) {
                document.documentElement.mozRequestFullScreen();
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
            } else if (document.body.msRequestFullscreen) {
                document.body.msRequestFullscreen();
            }
        }
        UI.updateFullscreenButton();
    },

    updateFullscreenButton() {
        if (document.fullscreenElement || // alternative standard method
            document.mozFullScreenElement || // currently working methods
            document.webkitFullscreenElement ||
            document.msFullscreenElement ) {
            document.getElementById('noVNC_fullscreen_button')
                .classList.add("noVNC_selected");
        } else {
            document.getElementById('noVNC_fullscreen_button')
                .classList.remove("noVNC_selected");
        }
    },

/* ------^-------
 *  /FULLSCREEN
 * ==============
 *     RESIZE
 * ------v------*/

    // Phone mode: the desktop takes the shape of this screen, windows are
    // maximized to fit it, and touch gestures zoom and pan the view
    phoneMode() {
        const mode = UI.getSetting('device_mode');
        return mode === 'phone' || (mode !== 'desktop' && UI.smallTouchScreen);
    },

    resizeMode() {
        if (UI.phoneMode() && UI.getSetting('phone_local_scale')) return 'scale';
        return UI.getSetting('resize');
    },

    // The desktop takes the shape of the phone's screen
    phoneDesktop() {
        return UI.phoneMode() && UI.resizeMode() === 'remote';
    },

    applyDeviceMode() {
        const phone = UI.phoneMode();
        document.documentElement.classList.toggle('noVNC_phone_mode', phone);
        UI.updateDeviceModeHint();
        if (!UI.rfb) return;

        UI.applyResizeMode();
        UI.rfb.localPinchZoom = phone || isTouchDevice;
        UI.fitRemoteWindows();
    },

    updateDeviceModeHint() {
        const hint = document.getElementById('noVNC_device_mode_hint');
        if (!hint) return;
        const map = document.querySelector('script[type="importmap"]');
        const version = map && /\/v\/([0-9a-f]{8})/.exec(map.textContent);
        hint.textContent = (UI.phoneMode() ? _("Phone mode is on") : _("Computer mode is on")) +
                           (version ? " · " + version[1] : "");
    },

    // Once the desktop has its new size, make the windows fit a phone
    // sized one, or give them back their own size on a large one
    fitRemoteWindows() {
        clearTimeout(UI.fitWindowsTimer);
        UI.fitWindowsTimer = setTimeout(() => {
            if (!UI.connected || !UI.sameOriginConnection || UI.rfb.viewOnly) return;
            const fit = UI.phoneDesktop();
            if (!fit && UI.phoneMode() && UI.getSetting('phone_local_scale') &&
                !UI.phoneWindowsFitted) return;
            UI.phoneWindowsFitted = fit;
            BrowserSession.fitWindows(fit ? 'fit' : 'restore').catch(() => {});
        }, 1500);
    },

    // Apply remote resizing or local scaling
    applyResizeMode() {
        if (!UI.rfb) return;

        const phoneLocal = UI.phoneMode() && UI.getSetting('phone_local_scale');
        const weakNetwork = UI.lowBandwidthMode();
        let fixedSize = phoneLocal ? null : UI.defaultDesktopSize();
        if (weakNetwork && !phoneLocal &&
            (!fixedSize || fixedSize.w > LOW_BANDWIDTH_SIZE.w || fixedSize.h > LOW_BANDWIDTH_SIZE.h)) {
            fixedSize = LOW_BANDWIDTH_SIZE;
        }
        UI.rfb.scaleViewport = UI.viewportScaled();
        UI.rfb.setDesktopResize({
            remote: UI.resizeMode() === 'remote',
            scale: UI.remoteScale(),
            tolerance: UI.phoneDesktop() ? 0.1 : 0,
            fixedSize,
            maximum: weakNetwork ? LOW_BANDWIDTH_SIZE : null,
        });
        UI.updateViewClip();
    },

    // How much larger than the browser the remote desktop is made
    remoteScale() {
        let scale = Number(UI.getSetting('remote_scale'));
        if (!(scale >= 1 && scale <= 4)) scale = 1;
        if (UI.phoneDesktop()) {
            // Applications need some room: many windows cannot get
            // narrower than about 500 pixels
            const container = document.getElementById('noVNC_container');
            const side = Math.min(container.clientWidth, container.clientHeight);
            if (side > 0) {
                scale = Math.max(scale, Math.ceil(UI.minPhoneDesktopSide / side * 20) / 20);
            }
        }
        return Math.min(scale, 4);
    },

    // An enlarged remote desktop is scaled down again to fit
    viewportScaled() {
        const mode = UI.resizeMode();
        // Phone mode always fits the view, which is what pinching zooms
        return mode === 'scale' || UI.phoneMode() || UI.lowBandwidthMode() ||
               (mode === 'remote' && (isTouchDevice || UI.remoteScale() !== 1));
    },

    // Desktop size from the "desktop_size" default ("1600x900"), which the
    // server returns to when remote resizing is turned off
    defaultDesktopSize() {
        const match = /^(\d+)x(\d+)$/.exec(
            UI.customSettings.defaults.desktop_size || '');
        if (!match) return null;
        return { w: parseInt(match[1]), h: parseInt(match[2]) };
    },

/* ------^-------
 *    /RESIZE
 * ==============
 * VIEW CLIPPING
 * ------v------*/

    // Update viewport clipping property for the connection. The normal
    // case is to get the value from the setting. There are special cases
    // for when the viewport is scaled or when a touch device is used.
    updateViewClip() {
        if (!UI.rfb) return;

        const scaling = UI.viewportScaled();

        // Some platforms have overlay scrollbars that are difficult
        // to use in our case, which means we have to force panning
        // FIXME: Working scrollbars can still be annoying to use with
        //        touch, so we should ideally be able to have both
        //        panning and scrollbars at the same time

        let brokenScrollbars = false;

        if (!hasScrollbarGutter) {
            if (isIOS() || isAndroid() || isMac() || isChromeOS()) {
                brokenScrollbars = true;
            }
        }

        if (scaling) {
            // Can't be clipping if viewport is scaled to fit
            UI.forceSetting('view_clip', false);
            UI.rfb.clipViewport  = false;
        } else if (brokenScrollbars) {
            UI.forceSetting('view_clip', true);
            UI.rfb.clipViewport = true;
        } else {
            UI.enableSetting('view_clip');
            UI.rfb.clipViewport = UI.getSetting('view_clip');
        }

        // Changing the viewport may change the state of
        // the dragging button
        UI.updateViewDrag();
    },

/* ------^-------
 * /VIEW CLIPPING
 * ==============
 *    VIEWDRAG
 * ------v------*/

    toggleViewDrag() {
        if (!UI.rfb) return;

        UI.rfb.dragViewport = !UI.rfb.dragViewport;
        UI.updateViewDrag();
    },

    updateViewDrag() {
        if (!UI.connected) return;

        const viewDragButton = document.getElementById('noVNC_view_drag_button');

        if ((!UI.rfb.clipViewport || !UI.rfb.clippingViewport) &&
            UI.rfb.dragViewport) {
            // We are no longer clipping the viewport. Make sure
            // viewport drag isn't active when it can't be used.
            UI.rfb.dragViewport = false;
        }

        if (UI.rfb.dragViewport) {
            viewDragButton.classList.add("noVNC_selected");
        } else {
            viewDragButton.classList.remove("noVNC_selected");
        }

        if (UI.rfb.clipViewport) {
            viewDragButton.classList.remove("noVNC_hidden");
        } else {
            viewDragButton.classList.add("noVNC_hidden");
        }

        viewDragButton.disabled = !UI.rfb.clippingViewport;
    },

/* ------^-------
 *   /VIEWDRAG
 * ==============
 *    QUALITY
 * ------v------*/

    updateFastMode() {
        const enabled = UI.getSetting('fast_mode');
        const lowBandwidth = UI.lowBandwidthMode();
        if (enabled || 'low_bandwidth' in UI.customSettings.mandatory) UI.disableSetting('low_bandwidth');
        else UI.enableSetting('low_bandwidth');
        if (lowBandwidth || 'fast_mode' in UI.customSettings.mandatory) UI.disableSetting('fast_mode');
        else UI.enableSetting('fast_mode');
        for (const name of ['quality', 'compression']) {
            if (enabled || lowBandwidth || name in UI.customSettings.mandatory) {
                UI.disableSetting(name);
            } else {
                UI.enableSetting(name);
            }
        }
        if (UI.rfb) {
            UI.rfb.fastMode = enabled;
            UI.updateQuality();
            UI.updateCompression();
        }
    },

    lowBandwidthMode() {
        return UI.getSetting('low_bandwidth') && !UI.getSetting('fast_mode');
    },

    updateDynamicQuality() {
        if (!UI.rfb) return;
        UI.rfb.dynamicQuality = UI.getSetting('dynamic_quality');
    },

    updateQuality() {
        if (!UI.rfb) return;

        UI.rfb.qualityLevel = UI.lowBandwidthMode() ? 3 : parseInt(UI.getSetting('quality'));
    },

/* ------^-------
 *   /QUALITY
 * ==============
 *  COMPRESSION
 * ------v------*/

    updateCompression() {
        if (!UI.rfb) return;

        UI.rfb.compressionLevel = UI.lowBandwidthMode() ? 2 : parseInt(UI.getSetting('compression'));
    },

/* ------^-------
 *  /COMPRESSION
 * ==============
 *    KEYBOARD
 * ------v------*/

    updateFloatingKeyboard() {
        const button = document.getElementById('noVNC_floating_keyboard');
        if (button) {
            button.hidden = !isTouchDevice || !UI.connected || !UI.rfb?.textCursor ||
                            UI.rfb.viewOnly || UI.virtualKeyboardActive();
        }
    },

    openFloatingKeyboard(event) {
        if (event.currentTarget.hidden) return;

        const pointer = UI.rfb?.clickTextCursor();
        if (!pointer) return;

        const input = document.getElementById('noVNC_keyboardinput');
        input.style.left = pointer.x + 'px';
        input.style.top = pointer.y + 'px';
        UI.lastTouchY = pointer.y;
        // Safari needs focus directly in this click handler.
        UI.showVirtualKeyboard();
    },

    virtualKeyboardActive() {
        const input = document.getElementById('noVNC_keyboardinput');
        return document.activeElement === input && input.inputMode === 'text';
    },

    showVirtualKeyboard() {
        if (!isTouchDevice || !UI.connected || !UI.rfb || UI.rfb.viewOnly) return;
        if (UI.virtualKeyboardActive()) return;

        const input = document.getElementById('noVNC_keyboardinput');
        // Refocus inside the button's click handler so the browser can open
        // the on-screen keyboard even if the IME already has focus.
        input.blur();
        input.inputMode = 'text';
        input.focus({ preventScroll: true });

        try {
            const l = input.value.length;
            // Move the caret to the end
            input.setSelectionRange(l, l);
        } catch (err) {
            // setSelectionRange is undefined in Google Chrome
        }
    },

    hideVirtualKeyboard() {
        if (!UI.virtualKeyboardActive()) return;

        document.getElementById('noVNC_keyboardinput').blur();
        UI.focusKeyboard();
    },

    toggleVirtualKeyboard() {
        if (UI.virtualKeyboardActive()) {
            UI.hideVirtualKeyboard();
        } else {
            UI.showVirtualKeyboard();
        }
    },

    onKeyboardInputFocus(event) {
        document.getElementById('noVNC_keyboard_button')
            .classList.toggle("noVNC_selected", event.target.inputMode === 'text');
        if (UI.rfb) {
            UI.rfb.focusOnClick = false;
        }
        UI.updateFloatingKeyboard();
    },

    onKeyboardInputBlur(event) {
        event.target.inputMode = '';
        document.getElementById('noVNC_keyboard_button')
            .classList.remove("noVNC_selected");
        if (UI.rfb) {
            UI.rfb.focusOnClick = true;
        }
        UI.updateFloatingKeyboard();
    },

    keepVirtualKeyboard(event) {
        const input = document.getElementById('noVNC_keyboardinput');

        // Only prevent focus change if the virtual keyboard is active
        if (document.activeElement != input) {
            return;
        }

        // Only allow focus to move to other elements that need
        // focus to function properly
        if (event.target.form !== undefined) {
            switch (event.target.type) {
                case 'text':
                case 'email':
                case 'search':
                case 'password':
                case 'tel':
                case 'url':
                case 'textarea':
                case 'select-one':
                case 'select-multiple':
                case 'range':
                // Sliders are dragged with the mouse; cancelling mousedown
                // would make them impossible to move while the local input
                // method keeps the focus on the keyboardinput element.
                    return;
            }
        }

        event.preventDefault();
    },

    keyboardinputReset() {
        const kbi = document.getElementById('noVNC_keyboardinput');
        kbi.value = new Array(UI.defaultKeyboardinputLen).join("_");
        UI.lastKeyboardinput = kbi.value;
    },

    keyEvent(keysym, code, down, numlock = null, capslock = null) {
        if (!UI.rfb) return;

        // A key pressed immediately after committing must follow that text,
        // even if the browser has not run the compositionend fallback yet.
        if (UI.imeCommitTimer !== null) {
            UI.keyInput({ target: document.getElementById('noVNC_keyboardinput') });
        }

        // Paced as well, so keys can't overtake text still being sent
        UI.sendKeyPaced(keysym, code, down, numlock, capslock);
    },

    // The server maps characters missing from its keymap to a spare keycode
    // on the fly, and may remap that same keycode for the next such
    // character before the application has looked up the first one. Space
    // those characters out so text committed by an input method in one go
    // arrives intact instead of repeating its last character.
    sendKeyPaced(keysym, code, down, numlock = null, capslock = null) {
        // Keep the lock state with the key until earlier text is delivered.
        UI.pacedKeys.push([keysym, code, down, numlock, capslock]);
        if (UI.pacedKeysTimer === null && UI.pacedTextPending === null) {
            UI.flushPacedKeys();
        }
    },

    sendTextPaced(text) {
        UI.textInputRevision++;
        const last = UI.pacedKeys.length - 1;
        if (typeof UI.pacedKeys[last] === 'string') {
            UI.pacedKeys[last] += text;
        } else {
            UI.pacedKeys.push(text);
        }
        if (UI.pacedKeysTimer === null && UI.pacedTextPending === null) {
            UI.flushPacedKeys();
        }
    },

    flushPacedKeys() {
        if (UI.pacedTextPending !== null) return;
        UI.pacedKeysTimer = null;
        while (UI.pacedKeys.length > 0) {
            if (!UI.rfb || UI.rfb.viewOnly) {
                UI.pacedKeys = [];
                return;
            }

            const next = UI.pacedKeys.shift();
            if (typeof next === 'string') {
                if (!UI.getSetting('ime_clipboard') && UI.sameOriginConnection) {
                    const rfb = UI.rfb;
                    const task = BrowserSession.typeText(next, UI.reconnectPassword);
                    UI.pacedTextPending = task;
                    task.then((typed) => {
                        if (UI.rfb !== rfb || UI.pacedTextPending !== task) return;
                        UI.pacedTextPending = null;
                        if (!typed) UI.queueTextKeysyms(next);
                        UI.flushPacedKeys();
                    }).catch((error) => {
                        if (UI.rfb !== rfb || UI.pacedTextPending !== task) return;
                        UI.pacedTextPending = null;
                        UI.pacedKeys = [];
                        Log.Error(error);
                        UI.showStatus(_("Text input failed. Please reconnect and try again."), 'error');
                    });
                    return;
                }
                // Preserve both clipboards during normal typing. Some remote
                // applications need clipboard paste as an explicit fallback.
                if (UI.getSetting('ime_clipboard') && UI.rfb.pasteText(next)) {
                    // Let the application consume the paste before changing
                    // the clipboard or sending a following Enter/Backspace.
                    UI.pacedKeysTimer = setTimeout(UI.flushPacedKeys,
                                                   UI.textPasteDelay);
                    return;
                }
                UI.queueTextKeysyms(next);
                continue;
            }
            const [keysym, code, down, numlock = null, capslock = null] = next;
            UI.rfb.sendKey(keysym, code, down, numlock, capslock);

            // Latin-1 and function keys are always in the keymap
            const unmapped = (keysym > 0xff && keysym < 0xfe00) ||
                             keysym > 0xffff;
            // Keep the interval even when the queue is currently empty:
            // keyInput() enqueues each character separately. Otherwise every
            // character is flushed immediately and pacing never takes effect.
            if (unmapped && down !== false) {
                UI.pacedKeysTimer = setTimeout(UI.flushPacedKeys,
                                               UI.pacedKeyDelay);
                return;
            }
        }
    },

    queueTextKeysyms(text) {
        UI.pacedKeys.unshift(...[...text].map(ch =>
            [keysyms.lookup(ch.codePointAt(0)), undefined, undefined]));
    },

    // When normal keyboard events are left uncought, use the input events from
    // the keyboardinput element instead and generate the corresponding key events.
    // This code is required since some browsers on Android are inconsistent in
    // sending keyCodes in the normal keyboard events when using on screen keyboards.
    keyInput(event) {

        if (!UI.rfb || UI.rfb.viewOnly) return;

        // Wait for committed text. The composition state also covers browsers
        // that omit isComposing or clear it before compositionend.
        if (UI.imeComposing || event.isComposing) return;
        clearTimeout(UI.imeCommitTimer);
        UI.imeCommitTimer = null;

        const newValue = event.target.value;

        if (!UI.lastKeyboardinput) {
            UI.keyboardinputReset();
        }
        const oldValue = UI.lastKeyboardinput;

        let newLen;
        try {
            // Try to check caret position since whitespace at the end
            // will not be considered by value.length in some browsers
            newLen = Math.max(event.target.selectionStart, newValue.length);
        } catch (err) {
            // selectionStart is undefined in Google Chrome
            newLen = newValue.length;
        }

        // Compare the old string with the new to account for
        // text-corrections. Compare code points so a shared high surrogate
        // in two different emoji cannot split the replacement character.
        const oldChars = [...oldValue];
        const newChars = [...newValue];
        let unchanged = 0;
        while (unchanged < Math.min(oldChars.length, newChars.length) &&
               oldChars[unchanged] === newChars[unchanged]) {
            unchanged++;
        }

        // Send the key events, per character rather than per UTF-16 code
        // unit so that emoji and other astral characters arrive intact
        for (let i = unchanged; i < oldChars.length; i++) {
            UI.sendKeyPaced(KeyTable.XK_BackSpace, "Backspace");
        }
        const inserted = newChars.slice(unchanged);
        if (inserted.some(ch => ch.codePointAt(0) > 0xff)) {
            UI.sendTextPaced(inserted.join(''));
        } else {
            for (const ch of inserted) {
                UI.sendKeyPaced(keysyms.lookup(ch.codePointAt(0)));
            }
        }

        if (inserted.length || oldChars.length > unchanged) UI.releaseStickyKeys();

        // Control the text content length in the keyboardinput element
        if (newLen > 2 * UI.defaultKeyboardinputLen) {
            UI.keyboardinputReset();
        } else if (newLen < 1) {
            // There always have to be some text in the keyboardinput
            // element with which backspace can interact.
            UI.keyboardinputReset();
            if (UI.virtualKeyboardActive()) {
                // The Android keyboard needs a new focus event to recognize
                // text added to the field. Refocus outside the input handler.
                event.target.blur();
                setTimeout(UI.showVirtualKeyboard, 0);
            }
        } else {
            UI.lastKeyboardinput = newValue;
        }
        if (UI.imeInputActive()) UI.imePinCaret();
    },

    // With IME input, the keyboard focus stays on the keyboardinput element
    // so the browser's local input method can compose text there. The
    // committed text is then sent through keyInput(), just like the
    // on-screen keyboard on touch devices.
    imeInputActive() {
        return !!UI.rfb && !UI.rfb.viewOnly && UI.getSetting('ime_input');
    },

    focusKeyboard() {
        if (!UI.rfb) return;

        if (!UI.rfb.viewOnly && UI.virtualKeyboardActive()) return;

        if (UI.imeInputActive()) {
            const input = document.getElementById('noVNC_keyboardinput');
            // Let the browser compose hardware keyboard input while keeping
            // the on-screen keyboard closed until the user opens it.
            input.inputMode = isTouchDevice ? 'none' : '';
            if (document.activeElement === input) return;
            input.focus({ preventScroll: true });
            // keyInput() expects typing to happen at the end of the text
            const l = input.value.length;
            input.setSelectionRange(l, l);
            UI.imePinCaret();
        } else {
            UI.rfb.focus();
        }
    },

    updateMacShortcuts() {
        const enabled = UI.getSetting('mac_shortcuts');
        if (UI.touchKeyboard) UI.touchKeyboard.macShortcuts = enabled;
        if (UI.rfb) UI.rfb.macShortcuts = enabled;
    },

    updateTouchMode() {
        if (!UI.rfb) return;
        UI.rfb.touchpadMode = UI.getSetting('touch_mode') === 'touchpad';
    },

    // Show how the line to the server is doing while the settings are open
    async updateLine() {
        clearTimeout(UI.lineTimer);
        const hint = document.getElementById('noVNC_line_hint');
        document.getElementById('noVNC_first_frame_hint').textContent =
            UI.connected && UI.firstFrameMs !== null ?
                _("Time to first frame: %s ms").replace('%s', UI.firstFrameMs) : '';
        if (!UI.connected || !UI.lineId ||
            !document.getElementById('noVNC_settings').classList.contains('noVNC_open')) {
            hint.textContent = '';
            return;
        }
        const id = UI.lineId;
        let text = '';
        try {
            const response = await fetch(new URL('api/files/line?id=' + id, window.location.href),
                                         { cache: 'no-store', signal: AbortSignal.timeout(2500) });
            if (response.ok) {
                const line = await response.json();
                text = _("Line: ") + line.node;
                if (line.rtt > 0) {
                    text += " · " + _("Gateway-side RTT: %s ms").replace('%s', line.rtt);
                }
                if (line.sent > 0) {
                    text += " · " + _("resent") + " " +
                            (line.resent / line.sent * 100).toFixed(1) + "%";
                }
            }
        } catch { /* Refresh on the next poll. */ }
        if (id !== UI.lineId || !UI.connected ||
            !document.getElementById('noVNC_settings').classList.contains('noVNC_open')) return;
        hint.textContent = text;
        clearTimeout(UI.lineTimer);
        UI.lineTimer = setTimeout(UI.updateLine, 3000);
    },

    updateWheel() {
        if (!UI.rfb) return;
        UI.rfb.wheelReverse = UI.getSetting('wheel_reverse');
        UI.rfb.wheelSpeed = Number(UI.getSetting('wheel_speed'));
    },

    updateImeInput() {
        if (!UI.rfb) return;

        const active = UI.imeInputActive();
        const input = document.getElementById('noVNC_keyboardinput');

        document.documentElement.classList.toggle('noVNC_ime_input', active);
        UI.rfb.focusOnClick = document.activeElement !== input;
        if (!active) {
            UI.hideImePreedit();
        }

        if (UI.connected) {
            UI.focusKeyboard();
        }
        UI.updateFloatingKeyboard();
    },

    // The async clipboard sends the local clipboard when the screen gets
    // focus (also when returning to this window), but with IME input the
    // keyboardinput element has the focus instead
    async imeInputFocus() {
        if (!UI.imeInputActive()) return;
        const rfb = UI.rfb;
        const revision = UI.textInputRevision;
        if (await browserAsyncClipboardSupport() !== 'available') return;
        if (await UI.syncLocalImage()) return;

        let text;
        try {
            text = await navigator.clipboard.readText();
        } catch (err) {
            Log.Error("Clipboard read failed: " + err);
            return;
        }
        // Clipboard reads can finish after typing starts. Do not replace
        // text that is still being pasted, or sync into a new connection.
        if (UI.rfb === rfb && revision === UI.textInputRevision &&
            UI.pacedKeysTimer === null && UI.pacedTextPending === null) {
            rfb.syncClipboardText(text);
        }
    },

    imeScreenPointerDown(event) {
        if (!UI.imeInputActive()) return;

        // Keep the input method's candidate window next to where the
        // user last clicked, which is usually the remote text cursor
        const input = document.getElementById('noVNC_keyboardinput');
        input.style.left = event.clientX + 'px';
        input.style.top = event.clientY + 'px';

        if (document.activeElement !== input) {
            UI.focusKeyboard();
        }
    },

    // Keep the caret at the element's own position, so the candidate
    // window stays where the user clicked instead of drifting with the
    // hidden text's scroll offset
    imePinCaret() {
        const input = document.getElementById('noVNC_keyboardinput');
        input.scrollTop = 0;
        input.scrollLeft = input.scrollWidth;
    },

    imeCompositionStart(event) {
        if (UI.imeCommitTimer !== null) {
            UI.keyInput(event);
        }
        UI.imeComposing = true;
        UI.imeCompositionUpdate(event);
    },

    imeCompositionUpdate(event) {
        if (!UI.imeInputActive()) return;

        const input = document.getElementById('noVNC_keyboardinput');
        const preedit = document.getElementById('noVNC_ime_preedit');
        UI.imePinCaret();
        preedit.textContent = event.data || '';
        preedit.style.left = input.style.left;
        preedit.style.top = input.style.top;
        preedit.classList.toggle('noVNC_open', preedit.textContent !== '');
    },

    imeCompositionEnd(event) {
        UI.imeComposing = false;
        UI.hideImePreedit();
        // Browsers differ on whether the final value and input event precede
        // or follow compositionend. Prefer the final input event, with a
        // fallback for input methods that only emit compositionend.
        UI.imeCommitTimer = setTimeout(() => {
            UI.imeCommitTimer = null;
            UI.keyInput(event);
        }, 0);
    },

    hideImePreedit() {
        const preedit = document.getElementById('noVNC_ime_preedit');
        preedit.classList.remove('noVNC_open');
        preedit.textContent = '';
    },

/* ------^-------
 *   /KEYBOARD
 * ==============
 *   EXTRA KEYS
 * ------v------*/

    openExtraKeys() {
        UI.closeAllPanels();
        UI.openControlbar();

        document.getElementById('noVNC_modifiers')
            .classList.add("noVNC_open");
        document.getElementById('noVNC_toggle_extra_keys_button')
            .classList.add("noVNC_selected");
    },

    closeExtraKeys() {
        document.getElementById('noVNC_modifiers')
            .classList.remove("noVNC_open");
        document.getElementById('noVNC_toggle_extra_keys_button')
            .classList.remove("noVNC_selected");
    },

    toggleExtraKeys() {
        if (document.getElementById('noVNC_modifiers')
            .classList.contains("noVNC_open")) {
            UI.closeExtraKeys();
        } else  {
            UI.openExtraKeys();
        }
    },

    sendEsc() {
        UI.sendKey(KeyTable.XK_Escape, "Escape");
    },

    sendTab() {
        UI.sendKey(KeyTable.XK_Tab, "Tab");
    },

    toggleCtrl() {
        const btn = document.getElementById('noVNC_toggle_ctrl_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    toggleWindows() {
        const btn = document.getElementById('noVNC_toggle_windows_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Super_L, "MetaLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Super_L, "MetaLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    toggleAlt() {
        const btn = document.getElementById('noVNC_toggle_alt_button');
        if (btn.classList.contains("noVNC_selected")) {
            UI.sendKey(KeyTable.XK_Alt_L, "AltLeft", false);
            btn.classList.remove("noVNC_selected");
        } else {
            UI.sendKey(KeyTable.XK_Alt_L, "AltLeft", true);
            btn.classList.add("noVNC_selected");
        }
    },

    sendCtrlAltDel() {
        UI.rfb.sendCtrlAltDel();
        // See below
        UI.focusKeyboard();
        UI.idleControlbar();
    },

    sendKey(keysym, code, down) {
        UI.sendKeyPaced(keysym, code, down);

        // Restore keyboard focus after using an extra key.
        UI.focusKeyboard();
        // fade out the controlbar to highlight that
        // the focus has been moved to the screen
        UI.idleControlbar();
    },

/* ------^-------
 *   /EXTRA KEYS
 * ==============
 *     MISC
 * ------v------*/

    updateViewOnly() {
        if (!UI.rfb) return;
        UI.rfb.viewOnly = UI.getSetting('view_only');

        UI.updateBeforeUnload();

        // Hide input related buttons in view only mode
        if (UI.rfb.viewOnly) {
            document.getElementById('noVNC_keyboard_button')
                .classList.add('noVNC_hidden');
            document.getElementById('noVNC_toggle_extra_keys_button')
                .classList.add('noVNC_hidden');
            document.getElementById('noVNC_clipboard_button')
                .classList.add('noVNC_hidden');
        } else {
            document.getElementById('noVNC_keyboard_button')
                .classList.remove('noVNC_hidden');
            document.getElementById('noVNC_toggle_extra_keys_button')
                .classList.remove('noVNC_hidden');
            document.getElementById('noVNC_clipboard_button')
                .classList.remove('noVNC_hidden');
        }

        UI.updateImeInput();
    },

    updateClipboard() {
        if (!UI.rfb) return;

        // Keep the manual panel available on HTTPS as well. Automatic
        // clipboard sync can coexist with it and does not replace its controls.
        document.getElementById('noVNC_clipboard_button')
            .classList.toggle('noVNC_hidden', UI.rfb.viewOnly);
        document.getElementById('noVNC_clipboard_files')
            .classList.toggle('noVNC_hidden', !UI.sameOriginConnection);
    },

    updateShowDotCursor() {
        if (!UI.rfb) return;
        UI.rfb.showDotCursor = UI.getSetting('show_dot');
    },

    updateLogging() {
        WebUtil.initLogging(UI.getSetting('logging'));
    },

    updateDesktopName(e) {
        UI.desktopName = e.detail.name;
        // Display the desktop name in the document title
        document.title = e.detail.name + " - " + PAGE_TITLE;
    },

    updateRequestWakelock() {
        if (!UI.rfb) return;
        if (UI.getSetting('keep_device_awake')) {
            UI.wakeLockManager.acquire();
        } else {
            UI.wakeLockManager.release();
        }
    },


    bell(e) {
        if (UI.getSetting('bell') === 'on') {
            const promise = document.getElementById('noVNC_bell').play();
            // The standards disagree on the return value here
            if (promise) {
                promise.catch((e) => {
                    if (e.name === "NotAllowedError") {
                        // Ignore when the browser doesn't let us play audio.
                        // It is common that the browsers require audio to be
                        // initiated from a user action.
                    } else {
                        Log.Error("Unable to play bell: " + e);
                    }
                });
            }
        }
    },

    //Helper to add options to dropdown.
    addOption(selectbox, text, value) {
        const optn = document.createElement("OPTION");
        optn.text = text;
        optn.value = value;
        selectbox.options.add(optn);
    },

/* ------^-------
 *    /MISC
 * ==============
 */
};

export default UI;
