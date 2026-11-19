/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 or any later version (see LICENSE.txt)
 */

import { supportsCursorURIs, isTouchDevice } from './browser.js';

const useFallback = !supportsCursorURIs || isTouchDevice;

// VNC sends a cursor bitmap. An I-beam has a centered hotspot and shaft,
// with wider caps at both ends. Check both text orientations.
export function isTextCursor(rgba, hotX, hotY, width, height) {
    const opaque = (x, y) => rgba[(y * width + x) * 4 + 3] >= 128;
    return isIBeam(width, height, hotX, hotY, opaque) ||
           isIBeam(height, width, hotY, hotX, (x, y) => opaque(y, x));
}

function isIBeam(width, height, hotX, hotY, opaque) {
    let left = width, right = -1, top = height, bottom = -1;
    const spans = [];
    for (let y = 0; y < height; y++) {
        let first = width, last = -1;
        for (let x = 0; x < width; x++) {
            if (!opaque(x, y)) continue;
            first = Math.min(first, x);
            last = x;
        }
        spans.push(Math.max(0, last - first + 1));
        if (last >= 0) {
            left = Math.min(left, first);
            right = Math.max(right, last);
            top = Math.min(top, y);
            bottom = y;
        }
    }

    const length = bottom - top + 1;
    const breadth = right - left + 1;
    if (length < 7 || breadth < 3 || length < breadth * 1.3 ||
        Math.abs(hotX - (left + right) / 2) > breadth / 4 ||
        Math.abs(hotY - (top + bottom) / 2) > length / 4 ||
        !opaque(hotX, hotY)) {
        return false;
    }

    const band = Math.floor(length / 5);
    const firstCap = Math.max(...spans.slice(top, top + band));
    const lastCap = Math.max(...spans.slice(bottom - band + 1, bottom + 1));
    const shaft = spans.slice(top + 2 * band, bottom - 2 * band + 1);
    // Resize arrows are widest slightly inward from each pointed end.
    return spans[top] >= firstCap * 0.65 && spans[bottom] >= lastCap * 0.65 &&
           Math.min(...shaft) > 0 && Math.max(...shaft) * 1.4 <= Math.min(firstCap, lastCap);
}

export default class Cursor {
    constructor() {
        this._target = null;

        this._canvas = document.createElement('canvas');

        if (useFallback) {
            this._canvas.style.position = 'fixed';
            this._canvas.style.zIndex = '65535';
            this._canvas.style.pointerEvents = 'none';
            // Safari on iOS can select the cursor image
            // https://bugs.webkit.org/show_bug.cgi?id=249223
            this._canvas.style.userSelect = 'none';
            this._canvas.style.WebkitUserSelect = 'none';
            // Can't use "display" because of Firefox bug #1445997
            this._canvas.style.visibility = 'hidden';
        }

        this._position = { x: 0, y: 0 };
        this._hotSpot = { x: 0, y: 0 };

        this._eventHandlers = {
            'mouseover': this._handleMouseOver.bind(this),
            'mouseleave': this._handleMouseLeave.bind(this),
            'mousemove': this._handleMouseMove.bind(this),
            'mouseup': this._handleMouseUp.bind(this),
        };
    }

    attach(target) {
        if (this._target) {
            this.detach();
        }

        this._target = target;

        if (useFallback) {
            document.body.appendChild(this._canvas);

            const options = { capture: true, passive: true };
            this._target.addEventListener('mouseover', this._eventHandlers.mouseover, options);
            this._target.addEventListener('mouseleave', this._eventHandlers.mouseleave, options);
            this._target.addEventListener('mousemove', this._eventHandlers.mousemove, options);
            this._target.addEventListener('mouseup', this._eventHandlers.mouseup, options);
        }

        this.clear();
    }

    detach() {
        if (!this._target) {
            return;
        }

        if (useFallback) {
            const options = { capture: true, passive: true };
            this._target.removeEventListener('mouseover', this._eventHandlers.mouseover, options);
            this._target.removeEventListener('mouseleave', this._eventHandlers.mouseleave, options);
            this._target.removeEventListener('mousemove', this._eventHandlers.mousemove, options);
            this._target.removeEventListener('mouseup', this._eventHandlers.mouseup, options);

            if (document.contains(this._canvas)) {
                document.body.removeChild(this._canvas);
            }
        }

        this._target = null;
    }

    change(rgba, hotx, hoty, w, h) {
        if ((w === 0) || (h === 0)) {
            this.clear();
            return;
        }

        this._position.x = this._position.x + this._hotSpot.x - hotx;
        this._position.y = this._position.y + this._hotSpot.y - hoty;
        this._hotSpot.x = hotx;
        this._hotSpot.y = hoty;

        let ctx = this._canvas.getContext('2d');

        this._canvas.width = w;
        this._canvas.height = h;

        let img = new ImageData(new Uint8ClampedArray(rgba), w, h);
        ctx.clearRect(0, 0, w, h);
        ctx.putImageData(img, 0, 0);

        if (useFallback) {
            this._updatePosition();
        } else {
            let url = this._canvas.toDataURL();
            this._target.style.cursor = 'url(' + url + ')' + hotx + ' ' + hoty + ', default';
        }
    }

    clear() {
        this._target.style.cursor = 'none';
        this._canvas.width = 0;
        this._canvas.height = 0;
        this._position.x = this._position.x + this._hotSpot.x;
        this._position.y = this._position.y + this._hotSpot.y;
        this._hotSpot.x = 0;
        this._hotSpot.y = 0;
    }

    // Mouse events might be emulated, this allows
    // moving the cursor in such cases
    move(clientX, clientY) {
        if (!useFallback) {
            return;
        }
        // clientX/clientY are relative the _visual viewport_,
        // but our position is relative the _layout viewport_,
        // so try to compensate when we can
        if (window.visualViewport) {
            this._position.x = clientX + window.visualViewport.offsetLeft;
            this._position.y = clientY + window.visualViewport.offsetTop;
        } else {
            this._position.x = clientX;
            this._position.y = clientY;
        }
        this._position.x -= this._hotSpot.x;
        this._position.y -= this._hotSpot.y;
        this._updatePosition();
        let target = document.elementFromPoint(clientX, clientY);
        this._updateVisibility(target);
    }

    _handleMouseOver(event) {
        // This event could be because we're entering the target, or
        // moving around amongst its sub elements. Let the move handler
        // sort things out.
        this._handleMouseMove(event);
    }

    _handleMouseLeave(event) {
        // Check if we should show the cursor on the element we are leaving to
        this._updateVisibility(event.relatedTarget);
    }

    _handleMouseMove(event) {
        this._updateVisibility(event.target);

        this._position.x = event.clientX - this._hotSpot.x;
        this._position.y = event.clientY - this._hotSpot.y;

        this._updatePosition();
    }

    _handleMouseUp(event) {
        // We might get this event because of a drag operation that
        // moved outside of the target. Check what's under the cursor
        // now and adjust visibility based on that.
        let target = document.elementFromPoint(event.clientX, event.clientY);
        this._updateVisibility(target);

        // Captures end with a mouseup but we can't know the event order of
        // mouseup vs releaseCapture.
        //
        // In the cases when releaseCapture comes first, the code above is
        // enough.
        //
        // In the cases when the mouseup comes first, we need wait for the
        // browser to flush all events and then check again if the cursor
        // should be visible.
        if (this._captureIsActive()) {
            window.setTimeout(() => {
                // We might have detached at this point
                if (!this._target) {
                    return;
                }
                // Refresh the target from elementFromPoint since queued events
                // might have altered the DOM
                target = document.elementFromPoint(event.clientX,
                                                   event.clientY);
                this._updateVisibility(target);
            }, 0);
        }
    }

    _showCursor() {
        if (this._canvas.style.visibility === 'hidden') {
            this._canvas.style.visibility = '';
        }
    }

    _hideCursor() {
        if (this._canvas.style.visibility !== 'hidden') {
            this._canvas.style.visibility = 'hidden';
        }
    }

    // Should we currently display the cursor?
    // (i.e. are we over the target, or a child of the target without a
    // different cursor set)
    _shouldShowCursor(target) {
        if (!target) {
            return false;
        }
        // Easy case
        if (target === this._target) {
            return true;
        }
        // Other part of the DOM?
        if (!this._target.contains(target)) {
            return false;
        }
        // Has the child its own cursor?
        // FIXME: How can we tell that a sub element has an
        //        explicit "cursor: none;"?
        if (window.getComputedStyle(target).cursor !== 'none') {
            return false;
        }
        return true;
    }

    _updateVisibility(target) {
        // When the cursor target has capture we want to show the cursor.
        // So, if a capture is active - look at the captured element instead.
        if (this._captureIsActive()) {
            target = document.captureElement;
        }
        if (this._shouldShowCursor(target)) {
            this._showCursor();
        } else {
            this._hideCursor();
        }
    }

    _updatePosition() {
        this._canvas.style.left = this._position.x + "px";
        this._canvas.style.top = this._position.y + "px";
    }

    _captureIsActive() {
        return document.captureElement &&
            document.documentElement.contains(document.captureElement);
    }
}
