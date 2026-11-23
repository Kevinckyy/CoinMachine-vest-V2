import argparse
import logging
import os
import secrets
import sys
import threading

from .bridge import Bridge
from .center import Center
from .http import make_server


def main():
    parser = argparse.ArgumentParser(description="Vest Fleet 分布式浏览器控制")
    parser.add_argument("role", choices=("center", "bridge", "key"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int)
    parser.add_argument("--db")
    parser.add_argument("--node-id", default=os.getenv("VEST_NODE_ID"))
    parser.add_argument("--parent-pipe", action="store_true", help="由节点更新器托管，父进程关闭输入管道时退出")
    args = parser.parse_args()
    if args.role == "key":
        print(secrets.token_urlsafe(32))
        return
    os.umask(0o077)

    def secret(name):
        val = os.getenv(name, "")
        if len(val) < 24 or len(val) > 512 or not val.isascii() or not val.isprintable() or val.strip() != val:
            parser.error(f"请设置 {name}（可用 python -m fleet key 生成）")
        return val

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = args.db or f"runtime/{args.role}.sqlite3"
    plugin_token = None
    stop = threading.Event()
    scheduler = None
    if args.role == "center":
        token = secret("VEST_ADMIN_TOKEN")
        app, port = Center(store), 8780
        scheduler = threading.Thread(target=app.run, args=(stop,), name="vest-controller", daemon=True)
    else:
        token, plugin_token = secret("VEST_NODE_TOKEN"), secret("VEST_PLUGIN_TOKEN")
        if token == plugin_token or not args.node_id:
            parser.error("桥需要节点 ID 和两个不同用途的密钥")
        app, port = Bridge(store, args.node_id), 8877
    server = make_server(args.host, args.port if args.port is not None else port, app, token, plugin_token)
    if args.parent_pipe and args.role == "bridge":
        def watch_parent():
            sys.stdin.buffer.read(1)
            server.shutdown()
        threading.Thread(target=watch_parent, daemon=True).start()
    if scheduler:
        scheduler.start()
    logging.info("%s 已监听 %s:%d", args.role, *server.server_address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        if scheduler:
            scheduler.join()
        app.db.close()


if __name__ == "__main__":
    main()
