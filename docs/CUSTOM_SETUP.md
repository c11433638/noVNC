# 本 Fork 的定制与安装

本仓库保留官方 noVNC 历史，并增加以下定制：

- 文件上传下载，包括分块上传、进度显示和取消。
- 本地输入法组合输入，以及中文和 emoji 文本传输。
- 记住浏览器登录 7 天，以及撤销浏览器登录。
- 手机工具栏和面板布局调整。
- 剪贴板面板同步、网页缓存刷新和 TigerVNC/Xfce 启动脚本。

文件传输与登录的详细说明见 [FILE_TRANSFER.md](FILE_TRANSFER.md)。

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
