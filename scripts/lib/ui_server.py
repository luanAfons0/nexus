#!/usr/bin/env python3
"""The Web UI server behind `nexus ui`.

One loopback listener (ADR 0005). Static files come from an allowlist in
the web directory; every API call is a subprocess run of the Nexus CLI and
answers HTTP 200 with the envelope {command, exit, stdout, stderr} plus
`json` when stdout parses. HTTP errors exist only for the loopback guard
(403), an unknown path (404), a missing JSON content type (415), and a
concurrent mutation (409). The server never reads or writes GLOBAL.md, the
Nexus Lock, or any skill root.
"""
import argparse
import http.server
import ipaddress
import json
import os
import secrets
import shlex
import signal
import subprocess
import sys
import threading

STATIC = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "vendor/marked.min.js": "text/javascript; charset=utf-8",
}

# Read endpoints: name -> CLI argv tail. Reads are not locked.
READS = {
    "list": ["list", "--json"],
    "global": ["global", "show", "--json"],
}
# Mutating endpoints: (method, name) -> CLI subcommand. The body key `name`
# is passed as one argv element, never through a shell; the CLI's own name
# checks are the only validation.
MUTATIONS = {
    ("POST", "update"): "update",
    ("POST", "remove"): "remove",
}
# PUT api/global runs `global edit --if-match <ifMatch>` with `content` on
# standard input; see do_PUT.


class State:
    def __init__(self, args):
        self.cli = args.cli
        self.web = args.web
        self.timeout = args.timeout
        self.token = secrets.token_hex(16)
        self.port = None
        self.mutation = threading.Lock()
        self.child_lock = threading.Lock()
        self.child = None


STATE = None


def run_cli(tail, stdin_text=None):
    """Run the CLI once and return the envelope. Never raises for a CLI
    failure: exit 1 is a refusal the page must show, not an HTTP error."""
    argv = [STATE.cli] + tail
    stdin = subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL
    child = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    with STATE.child_lock:
        STATE.child = child
    try:
        try:
            out, err = child.communicate(
                input=stdin_text.encode() if stdin_text is not None else None,
                timeout=STATE.timeout)
            code = child.returncode
        except subprocess.TimeoutExpired:
            kill_child(child)
            out, err = child.communicate()
            code = 124
            err = err + ("nexus ui: command killed after %s seconds (timeout)\n"
                         % STATE.timeout).encode()
    finally:
        with STATE.child_lock:
            STATE.child = None
    envelope = {"command": argv, "exit": code,
                "stdout": out.decode("utf-8", "replace"),
                "stderr": err.decode("utf-8", "replace")}
    if code == 0:
        try:
            envelope["json"] = json.loads(envelope["stdout"])
        except ValueError:
            pass
    return envelope


def kill_child(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "nexus-ui"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def refuse(self, status, reason, headers=()):
        body = reason.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        sys.stderr.write("nexus ui: refused %s %s: %s %s\n"
                         % (self.command, self.path, status, reason))

    def guard(self):
        """Return the relative path under the token prefix, or None after
        refusing. Order: peer, Host, Origin, token."""
        try:
            peer = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            peer = None
        if peer is None or not peer.is_loopback:
            self.refuse(403, "peer")
            return None
        host = self.headers.get("Host", "")
        if host not in ("127.0.0.1:%d" % STATE.port, "localhost:%d" % STATE.port):
            self.refuse(403, "host")
            return None
        origin = self.headers.get("Origin")
        if origin is not None and origin != "http://" + host:
            self.refuse(403, "origin")
            return None
        prefix = "/t/%s/" % STATE.token
        path = self.path.split("?", 1)[0]
        if not path.startswith(prefix):
            self.refuse(403, "token")
            return None
        return path[len(prefix):]

    def send_static(self, rel):
        if rel == "":
            rel = "index.html"
        if rel not in STATIC:
            self.refuse(404, "not found")
            return
        try:
            with open(os.path.join(STATE.web, *rel.split("/")), "rb") as handle:
                body = handle.read()
        except OSError:
            self.refuse(404, "not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", STATIC[rel])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def do_GET(self):
        rel = self.guard()
        if rel is None:
            return
        if rel.startswith("api/"):
            name = rel[4:]
            if name in READS:
                self.send_json(200, run_cli(READS[name]))
                return
            self.refuse(404, "not found")
            return
        self.send_static(rel)

    def do_HEAD(self):
        self.do_GET()

    def json_body(self, keys):
        """Body of a mutating request: JSON content type (415), one JSON
        object with every named key as a string (400). None after refusing."""
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.read_body()
            self.refuse(415, "json")
            return None
        raw = self.read_body()
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = None
        if not isinstance(body, dict) or any(not isinstance(body.get(key), str) for key in keys):
            self.refuse(400, "body")
            return None
        return body

    def mutate(self, tail, stdin_text=None):
        """Run one mutating CLI command, one at a time: 409 while another
        runs. Reads are never locked."""
        if not STATE.mutation.acquire(blocking=False):
            self.refuse(409, "busy")
            return
        try:
            envelope = run_cli(tail, stdin_text)
        finally:
            STATE.mutation.release()
        self.send_json(200, envelope)

    def do_POST(self):
        rel = self.guard()
        if rel is None:
            return
        subcommand = MUTATIONS.get(("POST", rel[4:])) if rel.startswith("api/") else None
        if subcommand is None:
            self.refuse(404, "not found")
            return
        body = self.json_body(["name"])
        if body is None:
            return
        self.mutate([subcommand, body["name"]])

    def do_PUT(self):
        rel = self.guard()
        if rel is None:
            return
        if rel != "api/global":
            self.refuse(404, "not found")
            return
        body = self.json_body(["content", "ifMatch"])
        if body is None:
            return
        self.mutate(["global", "edit", "--if-match", body["ifMatch"]], body["content"])

    def do_OPTIONS(self):
        rel = self.guard()
        if rel is None:
            return
        self.refuse(404, "not found")


def open_browser(url):
    candidates = []
    browser = os.environ.get("BROWSER", "").strip()
    if browser:
        try:
            candidates.append(shlex.split(browser))
        except ValueError:
            pass
    candidates.extend([["xdg-open"], ["wslview"], ["explorer.exe"]])
    for argv in candidates:
        if not argv:
            continue
        try:
            subprocess.Popen(argv + [url], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return
        except Exception:
            continue


def main(argv):
    global STATE
    parser = argparse.ArgumentParser(prog="nexus ui")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--web", required=True)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv[1:])
    STATE = State(args)

    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        sys.stderr.write("nexus: error: cannot bind 127.0.0.1:%d: %s\n"
                         % (args.port, error.strerror or error))
        return 1
    server.daemon_threads = True
    STATE.port = server.server_address[1]
    url = "http://127.0.0.1:%d/t/%s/" % (STATE.port, STATE.token)

    stop = threading.Event()

    def on_signal(signum, frame):
        stop.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1})
    thread.daemon = True
    thread.start()

    sys.stdout.write("nexus ui: %s\n" % url)
    sys.stdout.flush()
    if not args.no_open:
        open_browser(url)

    try:
        while not stop.is_set():
            stop.wait(1)
    except KeyboardInterrupt:
        pass
    with STATE.child_lock:
        child = STATE.child
    if child is not None:
        kill_child(child)
    server.shutdown()
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
