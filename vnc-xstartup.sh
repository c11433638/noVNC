#!/usr/bin/env bash

set -e

unset SESSION_MANAGER

# Snap applications need the systemd user bus to create their cgroup scopes.
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -S "$runtime_dir/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus"
fi

export GTK_IM_MODULE=ibus
export QT_IM_MODULE=ibus
export XMODIFIERS="@im=ibus"

if [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    ibus-daemon --daemonize --replace --xim
    (for _ in {1..20}; do ibus engine libpinyin >/dev/null 2>&1 && exit; sleep 0.25; done) &
    exec startxfce4
fi

exec dbus-run-session -- bash -c 'ibus-daemon --daemonize --replace --xim; (for _ in {1..20}; do ibus engine libpinyin >/dev/null 2>&1 && exit; sleep 0.25; done) & exec startxfce4'
