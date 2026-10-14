# 本 Fork 的定制与安装

本仓库保留官方 noVNC 历史，并增加以下定制：

- 文件上传下载，包括分块上传、进度显示和取消。
- 本地输入法组合输入，以及中文和 emoji 文本传输。
- 记住浏览器登录 7 天，以及撤销浏览器登录。
- 手机工具栏和面板布局调整。
- 剪贴板面板同步、网页缓存刷新和 TigerVNC/Xfce 启动脚本。

文件传输与登录的详细说明见 [FILE_TRANSFER.md](FILE_TRANSFER.md)。

## 本地输入法与剪贴板

使用本仓库的网关连接本机 X11 桌面时，本地输入法默认通过已认证的
文本输入接口发送中文、emoji 等内容，不改写本机或远端剪贴板。
网关临时使用一个空闲按键并在发送后恢复映射，避免 TigerVNC 动态
键盘映射用尽造成漏字。回车、退格等编辑键会等待前面的文本发送完毕。

网关默认按本机 VNC 端口推导显示编号（5901 → :1）；特殊配置可通过
`--input-display :1` 指定。该功能需要系统的 `libX11` 和 `libXtst`，并使用
与文件传输相同的 VNC 密码或浏览器登录会话。连接其他 VNC 网关时会
退回逐字 Unicode 按键发送。

如果特定远端应用无法正确接收 Unicode 按键，可在设置中开启
“通过剪贴板输入（兼容模式）”。此模式通过远端剪贴板粘贴文本，会替换
剪贴板内容；关闭后恢复按键输入。复制粘贴和剪贴板同步仍可正常使用。

## Mac 快捷键与滚轮

Mac 和 iPad 外接键盘默认启用“使用 Mac 快捷键（⌘ → Ctrl）”，例如
⌘C、⌘V、⌘X、⌘A、⌘Z 会发送为远端 Ctrl 组合键，⌘⇧Z 会发送为
Ctrl+Shift+Z。设置面板中可以关闭此选项，恢复原有 Command 映射。
本地输入法和直接输入都使用同一设置。

滚轮和触控板默认遵循本机系统的滚动方向，包括 Mac 的自然滚动。
设置面板中可选择“反转滚动方向”，以及 0.5×、1×、2×、3× 的滚动速度。
方向和速度设置立即生效，并保存在当前浏览器。VNC 使用滚轮步进，
触控板的细小移动会累积后发送，不能完全复现本机的逐像素滚动。

macOS 或浏览器保留的组合键（如 ⌘Tab）可能不会传入网页；网页无法
改写这些系统快捷键。终端应用仍按远端终端自身的复制粘贴组合键处理。

## 获取代码与 websockify

`websockify/` 是独立的依赖仓库，不作为嵌套 Git 仓库提交。本 Fork 将其
本地缓存控制修改保存为 [websockify-local.patch](websockify-local.patch)。
在新机器执行以下命令，可以恢复依赖到当前使用的版本并应用修改：

```sh
git clone https://github.com/c11433638/noVNC.git
cd noVNC
git clone https://github.com/novnc/websockify.git websockify
git -C websockify checkout 3dd228b81ade1ff76a27ad12eed6e78df8c6f8a6
git -C websockify apply ../docs/websockify-local.patch
```

以上补丁只需应用一次。浏览器客户端是原生 JavaScript 模块，无需构建。

## Ubuntu 桌面环境

当前启动脚本使用 TigerVNC、Xfce 和 IBus 拼音。在 Ubuntu 上安装所需组件：

```sh
sudo apt update
sudo apt install tigervnc-standalone-server tigervnc-tools xfce4 dbus-x11 \
    ibus ibus-libpinyin python3-cryptography python3-numpy
mkdir -p "$HOME/.vnc"
chmod 700 "$HOME/.vnc"
tigervncpasswd "$HOME/.vnc/passwd"
chmod 600 "$HOME/.vnc/passwd"
./vnc-control.sh start
```

打开 `http://服务器地址:6990/vnc.html` 并输入设置的 VNC 密码。已有 HTTPS
反向代理可以继续代理端口 `6990`，并需支持 WebSocket。传输目录默认为
`~/Downloads/noVNC`，网关状态保存在 `~/.local/state/novnc-files`。

常用操作：

```sh
./vnc-control.sh status
./vnc-control.sh web-restart  # 只重启网页网关，保留桌面和应用
./vnc-control.sh restart      # 重启桌面和网页网关
./vnc-control.sh stop
```

如果已经有 VNC 服务，可直接启动网关，按需要修改目标端口：

```sh
python3 utils/novnc_gateway.py --port 6990 --target-port 5901
```

## 同步官方代码

首次在新克隆中配置官方仓库：

```sh
git remote add upstream https://github.com/novnc/noVNC.git
```

之后在工作区干净时同步，并保留本 Fork 的定制提交：

```sh
git fetch upstream
git checkout master
git merge upstream/master
git push origin master
```

如有冲突，需要解决冲突后再提交和推送。

## 验证

```sh
python3 tests/test_browser_session.py -v
python3 tests/test_file_transfer.py -v
bash -n vnc-control.sh vnc-xstartup.sh
npm install
npm run lint
TEST_BROWSER_NAME=ChromeHeadless CHROME_BIN=/usr/bin/chromium npm test
```

文件接口和浏览器测试需要允许运行本地监听端口的环境。
