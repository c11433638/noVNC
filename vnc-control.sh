#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/novnc-vnc"
VNC_DISPLAY="${VNC_DISPLAY:-:1}"
VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6990}"
NOVNC_FILES_DIR="${NOVNC_FILES_DIR:-${HOME}/Downloads/noVNC}"
VNC_PASSWORD_FILE="${VNC_PASSWORD_FILE:-${HOME}/.vnc/passwd}"
VNC_GEOMETRY="${VNC_GEOMETRY:-1280x720}"
VNC_STARTUP="${VNC_STARTUP:-${ROOT_DIR}/vnc-xstartup.sh}"
VNC_LOG="${STATE_DIR}/vnc.log"
NOVNC_LOG="${STATE_DIR}/novnc.log"
NOVNC_PID_FILE="${STATE_DIR}/novnc.pid"

die() {
    echo "Error: $*" >&2
    exit 1
}

usage() {
    cat <<EOF
Usage: $(basename "$0") {start|stop|restart|status|on|off|web-start|web-stop|web-restart}

Environment variables:
  VNC_GEOMETRY=1920x1080  TigerVNC desktop geometry
  VNC_PORT=5901           VNC port
  NOVNC_PORT=6990         noVNC/WebSocket port
  NOVNC_FILES_DIR=~/Downloads/noVNC  Remote file transfer folder
  VNC_PASSWORD_FILE=~/.vnc/passwd   VNC password file for transfers
EOF
}

require_commands() {
    local command_name
    for command_name in tigervncserver dbus-run-session startxfce4 ss; do
        command -v "$command_name" >/dev/null 2>&1 || die "Command not found: ${command_name}"
    done

    [[ -f "${ROOT_DIR}/utils/novnc_gateway.py" ]] || die "File not found: ${ROOT_DIR}/utils/novnc_gateway.py"
    [[ -x "${VNC_STARTUP}" ]] || die "Executable not found: ${VNC_STARTUP}"
    [[ -f "${ROOT_DIR}/vnc.html" ]] || die "File not found: ${ROOT_DIR}/vnc.html"
}

port_is_listening() {
    ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

wait_for_port() {
    local port="$1"
    local attempts=0
    while (( attempts < 40 )); do
        port_is_listening "${port}" && return 0
        sleep 0.25
        ((attempts += 1))
    done
    return 1
}

wait_for_port_to_close() {
    local port="$1"
    local attempts=0
    while (( attempts < 40 )); do
        ! port_is_listening "${port}" && return 0
        sleep 0.25
        ((attempts += 1))
    done
    return 1
}

novnc_listener_pid() {
    local line
    line="$(ss -H -ltnp "sport = :${NOVNC_PORT}" 2>/dev/null || true)"
    if [[ "${line}" =~ pid=([0-9]+), ]]; then
        printf "%s\n" "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

novnc_pid() {
    [[ -s "${NOVNC_PID_FILE}" ]] || return 1
    local pid
    pid="$(<"${NOVNC_PID_FILE}")"
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    [[ -r "/proc/${pid}/cmdline" ]] || return 1
    tr "\0" " " < "/proc/${pid}/cmdline" | grep -Eq "websockify|novnc_gateway.py"
}

start_vnc() {
    if port_is_listening "${VNC_PORT}"; then
        echo "VNC is already listening on port ${VNC_PORT}."
        return 0
    fi

    echo "Starting TigerVNC ${VNC_DISPLAY} (port ${VNC_PORT}, geometry ${VNC_GEOMETRY})..."
    if ! tigervncserver "${VNC_DISPLAY}" \
        -rfbport "${VNC_PORT}" \
        -localhost no \
        -SecurityTypes VncAuth \
        -geometry "${VNC_GEOMETRY}" \
        -depth 16 \
        -FrameRate 30 \
        -CompareFB 2 \
        -ZlibLevel 1 \
        -xstartup "${VNC_STARTUP}" >>"${VNC_LOG}" 2>&1; then
        tail -40 "${VNC_LOG}" >&2 || true
        die "TigerVNC failed to start; see ${VNC_LOG}"
    fi

    wait_for_port "${VNC_PORT}" || {
        tail -40 "${VNC_LOG}" >&2 || true
        die "TigerVNC did not listen on port ${VNC_PORT}; see ${VNC_LOG}"
    }
    echo "VNC started."
}

start_novnc() {
    if port_is_listening "${NOVNC_PORT}"; then
        if novnc_pid; then
            echo "noVNC is already listening on port ${NOVNC_PORT}."
            return 0
        fi
        die "Port ${NOVNC_PORT} is already in use by another process."
    fi

    echo "Starting noVNC (port ${NOVNC_PORT} -> 127.0.0.1:${VNC_PORT})..."
    rm -f "${NOVNC_PID_FILE}"
    if ! python3 "${ROOT_DIR}/utils/novnc_gateway.py" \
        --daemon \
        --web "${ROOT_DIR}" \
        --files "${NOVNC_FILES_DIR}" \
        --password-file "${VNC_PASSWORD_FILE}" \
        --log-file "${NOVNC_LOG}" \
        --port "${NOVNC_PORT}" --target-port "${VNC_PORT}" >/dev/null 2>&1; then
        tail -40 "${NOVNC_LOG}" >&2 || true
        die "noVNC failed to start; see ${NOVNC_LOG}"
    fi

    if ! wait_for_port "${NOVNC_PORT}"; then
        tail -40 "${NOVNC_LOG}" >&2 || true
        die "noVNC failed to listen on port ${NOVNC_PORT}; see ${NOVNC_LOG}"
    fi

    local pid
    pid="$(novnc_listener_pid || true)"
    if [[ -z "${pid}" ]]; then
        tail -40 "${NOVNC_LOG}" >&2 || true
        die "Unable to find the noVNC process listening on port ${NOVNC_PORT}"
    fi
    printf "%s\n" "${pid}" >"${NOVNC_PID_FILE}"
    if ! novnc_pid; then
        rm -f "${NOVNC_PID_FILE}"
        die "noVNC process validation failed; see ${NOVNC_LOG}"
    fi
    echo "noVNC started (PID ${pid})."
}

start_all() {
    require_commands
    mkdir -p "${STATE_DIR}"
    start_vnc
    start_novnc
    echo
    echo "URL: http://$(hostname):${NOVNC_PORT}/vnc.html"
}

stop_novnc() {
    if novnc_pid; then
        local pid
        pid="$(<"${NOVNC_PID_FILE}")"
        echo "Stopping noVNC (PID ${pid})..."
        kill "${pid}" 2>/dev/null || true
        for _ in {1..40}; do
            kill -0 "${pid}" 2>/dev/null || break
            sleep 0.25
        done
    elif port_is_listening "${NOVNC_PORT}"; then
        echo "Cannot safely stop noVNC: port ${NOVNC_PORT} is not owned by the recorded process." >&2
        return 1
    fi
    rm -f "${NOVNC_PID_FILE}"
    wait_for_port_to_close "${NOVNC_PORT}" || {
        echo "Port ${NOVNC_PORT} is still listening." >&2
        return 1
    }
    echo "noVNC stopped."
}

stop_vnc() {
    if port_is_listening "${VNC_PORT}"; then
        echo "Stopping TigerVNC ${VNC_DISPLAY}..."
        tigervncserver -kill "${VNC_DISPLAY}" >>"${VNC_LOG}" 2>&1 || {
            tail -40 "${VNC_LOG}" >&2 || true
            return 1
        }
        wait_for_port_to_close "${VNC_PORT}" || {
            echo "Port ${VNC_PORT} is still listening." >&2
            return 1
        }
    else
        echo "VNC is not listening on port ${VNC_PORT}."
    fi
    echo "VNC stopped."
}

stop_all() {
    require_commands
    local result=0
    stop_novnc || result=1
    stop_vnc || result=1
    return "${result}"
}

status_all() {
    local vnc_status="stopped"
    local novnc_status="stopped"

    port_is_listening "${VNC_PORT}" && vnc_status="running (port ${VNC_PORT})"
    if port_is_listening "${NOVNC_PORT}"; then
        if novnc_pid; then
            novnc_status="running (PID $(<"${NOVNC_PID_FILE}"), port ${NOVNC_PORT})"
        else
            novnc_status="port ${NOVNC_PORT} is owned by another process"
        fi
    fi

    echo "VNC:   ${vnc_status}"
    echo "noVNC: ${novnc_status}"
    echo "Logs:  ${VNC_LOG}"
    echo "       ${NOVNC_LOG}"
}

case "${1:-}" in
    start|on)
        start_all
        ;;
    stop|off)
        stop_all
        ;;
    restart)
        stop_all && start_all
        ;;
    status)
        status_all
        ;;
    web-start)
        require_commands
        mkdir -p "${STATE_DIR}"
        start_novnc
        ;;
    web-stop)
        stop_novnc
        ;;
    web-restart)
        require_commands
        mkdir -p "${STATE_DIR}"
        stop_novnc && start_novnc
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
