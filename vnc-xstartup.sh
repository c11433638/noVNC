#!/usr/bin/env bash

set -e

unset SESSION_MANAGER

# Snap applications need the systemd user bus to create their cgroup scopes.
runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -S "$runtime_dir/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_dir/bus"
fi

# Local input methods send committed text through noVNC.
export GTK_IM_MODULE=xim
export QT_IM_MODULE=xim
export XMODIFIERS="@im=none"

if [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    exec startxfce4
fi

exec dbus-run-session -- startxfce4
