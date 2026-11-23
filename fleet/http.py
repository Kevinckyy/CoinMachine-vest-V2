import hmac
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .bridge import Bridge
from .protocol import Problem, dump, ident, obj, require

WEB = Path(__file__).resolve().parent.parent / "web"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/reports.js": ("reports.js", "text/javascript; charset=utf-8"),
          "/strategy.js": ("strategy.js", "text/javascript; charset=utf-8"),
          "/styles.css": ("styles.css", "text/css; charset=utf-8")}


def make_server(bind, port, app, token, plugin_token=None):
    is_bridge = isinstance(app, Bridge)

    class Handler(BaseHTTPRequestHandler):
        server_version = "VestFleet/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, fmt, *args):
            # Polls and heartbeats are expected every few seconds.
            if len(args) > 1 and str(args[1]).startswith("5"):
                logging.warning("%s %s", self.command, urlsplit(self.path).path)

        def reply(self, status, data, mime="application/json; charset=utf-8"):
            raw = data if isinstance(data, bytes) else dump(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self):
            try:
                path = urlsplit(self.path).path
                method = self.command
                if method == "GET" and path == "/healthz":
                    return self.reply(200, {"service": "bridge", "version": 1, "release":app.release} if is_bridge
                                      else {"service":"center","version":1})
                if not is_bridge and method == "GET" and path in STATIC:
                    name, mime = STATIC[path]
                    return self.reply(200, (WEB / name).read_bytes(), mime)
                keys = path.strip("/").split("/")
                plugin = path.startswith("/v1/plugin/")
                secret = plugin_token if plugin and is_bridge else token
                if not is_bridge and keys[:2] == ["v1","node-agent"]:
                    require(method == "POST" and len(keys) == 4 and keys[3] in ("poll","report"), "接口不存在", 404)
                    secret = app.agent_secret(ident(keys[2]))
                auth = self.headers.get("Authorization", "")
                require(secret and hmac.compare_digest(auth.encode(), ("Bearer " + secret).encode()), "密钥无效", 401)
                require(len(keys) >= 2 and keys[0] == "v1", "接口不存在", 404)
                body = {}
                if method in {"PUT", "POST"}:
                    require(self.headers.get_content_type() == "application/json", "需要 application/json", 415)
                    size = int(self.headers.get("Content-Length", "-1"))
                    require(0 <= size <= 256_000, "请求长度无效", 413)
                    def invalid_constant(_):
                        raise ValueError("non-finite number")
                    body = obj(json.loads(self.rfile.read(size), parse_constant=invalid_constant))
                result = self.route(method, keys[1:], body)
                self.reply(200, result)
            except Problem as err:
                self.reply(err.status, {"error": str(err)})
            except (ValueError, TypeError, KeyError, RecursionError):
                self.reply(400, {"error": "请求数据格式无效"})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except Exception:
                logging.exception("处理 API 请求失败")
                self.reply(500, {"error": "内部服务错误"})

        def route(self, method, keys, body):
            if len(keys) == 2 and keys[0] == "commands" and method == "GET":
                return app.get(ident(keys[1]))
            if len(keys) == 2 and keys[0] == "commands" and method == "PUT":
                return app.submit(ident(keys[1]), body)
            if len(keys) == 3 and keys[0] == "commands" and keys[2] == "resolve" and method == "POST":
                if is_bridge:
                    require(body.get("instance_id") == app.instance_id, "节点数据库身份不匹配", 409)
                return app.resolve(ident(keys[1]), body)
            if is_bridge:
                if keys == ["status"] and method == "GET":
                    return app.status()
                if keys == ["status"] and method == "PUT":
                    return app.refresh_cards(body)
                if keys in (["ledger"], ["logs"]) and method == "GET":
                    query = parse_qs(urlsplit(self.path).query)
                    after = int(query.get("after", ["0"])[0])
                    return app.ledger_page(after) if keys == ["ledger"] else app.log_page(after)
                if len(keys) == 2 and keys[0] == "plugin" and method == "POST":
                    return app.plugin(keys[1], body)
                if len(keys) == 3 and keys[0] == "commands" and keys[2] == "cancel" and method == "PUT":
                    return app.submit(ident(keys[1]), body, cancel=True)
            else:
                query = {k:v[-1] for k,v in parse_qs(urlsplit(self.path).query).items()}
                if len(keys) == 3 and keys[0] == "node-agent" and method == "POST":
                    return app.agent(ident(keys[1]),keys[2],body)
                if len(keys) == 4 and keys[0] == "nodes" and keys[2] == "updates" and method in ("GET","PUT"):
                    return app.deployment(ident(keys[1]),ident(keys[3]),"create" if method == "PUT" else "get",body)
                if len(keys) == 5 and keys[0] == "nodes" and keys[2] == "updates" and keys[4] == "cancel" and method == "POST":
                    return app.deployment(ident(keys[1]),ident(keys[3]),"cancel",body)
                if keys == ["state"] and method == "GET":
                    return app.state(query.get("node_id"))
                if keys == ["strategy","defaults"] and method == "PUT":
                    return app.save_defaults(body)
                if len(keys) == 3 and keys[:2] == ["strategy","presets"] and method == "PUT":
                    return app.preset(keys[2],body)
                if len(keys) == 4 and keys[:2] == ["strategy","presets"] and keys[3] == "delete" and method == "POST":
                    return app.preset(keys[2],body,remove=True)
                if keys == ["analytics"] and method == "GET":
                    return app.analytics(query)
                if keys == ["commands"] and method == "GET":
                    return app.history(query.get("status", ""), int(query.get("offset", 0)), query.get("node_id"))
                if len(keys) == 3 and keys[0] == "nodes" and method == "GET":
                    nid = ident(keys[1])
                    if keys[2] == "logs":
                        return app.logs(nid, query.get("level", ""), int(query.get("offset", 0)))
                    if keys[2] == "accounts":
                        return {"accounts": app.state(nid)["accounts"]}
                if len(keys) == 4 and keys[0] == "nodes" and keys[2] == "strategy" and method == "POST":
                    return app.strategy(keys[3], body, ident(keys[1]))
                if len(keys)==4 and keys[0]=="nodes" and keys[2:]==["accounts","refresh"] and method=="POST":
                    return app.refresh_accounts(ident(keys[1]))
                if len(keys)==4 and keys[0]=="nodes" and keys[2:]==["accounts","read-all"] and method=="POST":
                    return app.read_accounts(ident(keys[1]))
                if len(keys) == 2 and keys[0] == "nodes" and method == "PUT":
                    return app.configure_node(keys[1], body)
                if keys == ["accounts", "config"] and method == "POST":
                    return app.account_config(body)
                if len(keys) == 3 and keys[0] == "commands" and keys[2] == "cancel" and method == "POST":
                    return app.cancel(ident(keys[1]))
                if len(keys) == 2 and keys[0] == "strategy" and method == "POST":
                    return app.strategy(keys[1], body)
            raise Problem("接口不存在", 404)

        do_GET = do_POST = do_PUT = handle_request

    return ThreadingHTTPServer((bind, port), Handler)
